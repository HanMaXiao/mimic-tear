#!/usr/bin/env node
/**
 * 打包守卫：确认这个包「零第三方依赖、零本机路径残留」。
 *
 * 规格 §9 验收项 8 要求包内不得有 node_modules，清单必须能通过宿主校验。
 * Mini App 的运行时是裸 Node 环境，没有安装步骤——所以只要包里出现一个第三方
 * import，宿主加载时就会直接炸。这里把「零依赖」这条硬约束变成可执行的断言。
 *
 * 断言：
 *   1. 包内没有任何 node_modules 目录
 *   2. 包内没有任何 lockfile
 *   3. package.json 没有声明任何 dependencies
 *   4. .mjs/.js/.cjs/.ts 里的 import 说明符只有 node: 内置模块与相对路径
 *   5. 源码里没有烤进构建机的绝对路径
 *
 * 退出码：0 = 全部通过；1 = 有违规；2 = 用法错误
 *
 * 环境变量：
 *   MIMIC_TEAR_REPO_ROOT    仓库根目录，默认取本脚本所在仓库的根
 *   MIMIC_TEAR_PACKAGE_DIR  被检查的包目录，默认 <仓库根>/miniapps/mimic-tear
 */

import { execFile } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_REPO_ROOT = resolve(SCRIPT_DIR, '..');

const repoRoot = resolve(process.env.MIMIC_TEAR_REPO_ROOT || DEFAULT_REPO_ROOT);
const packageDir = resolve(process.env.MIMIC_TEAR_PACKAGE_DIR || join(repoRoot, 'miniapps', 'mimic-tear'));

/** 依赖目录与缓存目录：出现即违规，检查时先记下来再跳过内容。 */
const FORBIDDEN_DIRS = new Set(['node_modules']);

/** 构建产物目录：不是发布内容。 */
const SKIP_DIRS = new Set(['.git', 'dist', 'build', '.vendor']);

/** 常见的 lockfile 文件名。 */
const LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
]);

/** 参与 import 扫描的扩展名。 */
const CODE_EXTENSIONS = new Set(['.mjs', '.js', '.cjs', '.ts']);

/** 参与路径泄漏扫描的文本扩展名。 */
const TEXT_EXTENSIONS = new Set([
  '.mjs', '.js', '.cjs', '.ts', '.json', '.html', '.css', '.md', '.txt',
  '.yml', '.yaml', '.xml', '.vbs', '.sh',
]);

/** Windows 系统目录不是「构建机路径」，允许出现。 */
const ALLOWED_ABSOLUTE_PREFIXES = ['c:\\windows', 'c:\\program files', 'c:\\program files (x86)'];

/**
 * 判断路径是否落在允许名单的前缀下。
 * @param {string} normalized 已归一化并转小写的路径
 * @param {string} prefix 允许的前缀
 * @returns {boolean} 是否命中
 */
function underPrefix(normalized, prefix) {
  return normalized === prefix || normalized.startsWith(`${prefix}\\`) || normalized.startsWith(`${prefix}/`);
}

function printHelp() {
  process.stdout.write(
    [
      '用法：node scripts/check-package.mjs',
      '',
      '检查包内是否存在 node_modules、lockfile、第三方 import 或本机绝对路径。',
      '',
      '环境变量：',
      '  MIMIC_TEAR_REPO_ROOT    仓库根目录',
      '  MIMIC_TEAR_PACKAGE_DIR  被检查的包目录（默认 <仓库根>/miniapps/mimic-tear）',
      '',
    ].join('\n'),
  );
}

/**
 * 递归列出目录下的文件，返回相对路径（统一用 / 分隔）。
 * @param {string} dir 目录绝对路径
 * @param {string} [base] 相对路径的基准目录
 * @returns {Promise<string[]>} 相对路径列表
 */
async function listFiles(dir, base = dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return out;
    throw error;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...(await listFiles(full, base)));
      continue;
    }
    if (!entry.isFile()) continue;
    out.push(relative(base, full).split(sep).join('/'));
  }
  return out.sort();
}

/**
 * 优先用 git 列出「被跟踪的文件」，拿不到时退回遍历目录。
 * @param {string} dir 包目录
 * @returns {Promise<string[]>} 相对路径列表
 */
async function listTrackedFiles(dir) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', dir, 'ls-files', '-z', '--cached'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const files = stdout.split('\0').filter(Boolean);
    if (files.length > 0) return files.sort();
  } catch {
    /* 不是 git 仓库，或没有 git：退回遍历 */
  }
  return listFiles(dir);
}

/**
 * 判断是否为文本文件（含 NUL 字节的视为二进制）。
 * @param {Buffer} buf 文件内容
 * @returns {boolean} 是否文本
 */
function looksTextual(buf) {
  const head = buf.subarray(0, 4096);
  return !head.includes(0);
}

/**
 * 粗粒度地剥掉行注释与块注释，保留字符串字面量与字符偏移。
 * import 说明符本身就住在字符串里，所以只能剥注释，不能剥字符串。
 * @param {string} content 源码
 * @returns {string} 去掉注释后的源码（长度不变）
 */
function stripComments(content) {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (match, prefix) => prefix + ' '.repeat(match.length - prefix.length));
}

/**
 * 收集模块说明符：import ... from 'x' / import 'x' / import('x') / require('x')。
 * @param {string} content 源码
 * @returns {{specifier: string, index: number}[]} 说明符列表
 */
function collectSpecifiers(content) {
  const patterns = [
    /\bfrom\s*['"]([^'"\n]+)['"]/g,
    /\bimport\s*['"]([^'"\n]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  ];
  const found = [];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const specifier = match[1];
      // 模块说明符里不会有空白；带空白的多半是散文被误当成 import。
      if (/\s/.test(specifier)) continue;
      found.push({ specifier, index: match.index });
    }
  }
  return found;
}

/**
 * 判断一个模块说明符是否只依赖 Node 内置模块或相对路径。
 * @param {string} specifier 模块说明符
 * @returns {boolean} 是否合规
 */
function isAllowedSpecifier(specifier) {
  if (specifier.startsWith('node:')) return true;
  if (specifier.startsWith('./') || specifier.startsWith('../')) return true;
  if (specifier === '.' || specifier === '..') return true;
  return false;
}

/**
 * 把源码里的绝对路径候选挑出来（先剥掉 URL，避免 https:// 被当成盘符路径）。
 * @param {string} content 源码
 * @returns {string[]} 绝对路径候选
 */
function findAbsolutePaths(content) {
  const withoutUrls = content.replace(/\b(?:https?|ftp|file):\/\/[^\s'"<>)\]]+/g, ' ');
  const windows = withoutUrls.match(/(?<![A-Za-z0-9_])[A-Za-z]:(?:\\\\|\\|\/)[^\s'"`<>|*?,;)\]}]*/g) ?? [];
  const posix = withoutUrls.match(/(?<![A-Za-z0-9_])\/(?:Users|home)\/[^\s'"`<>|*?,;)\]}]*/g) ?? [];
  return [...windows, ...posix];
}

/**
 * 判断绝对路径是否属于「构建机残留」。
 * @param {string} raw 原始命中的路径文本
 * @returns {boolean} 是否是构建机残留
 */
function isBuildMachinePath(raw) {
  // 源码里的 Windows 路径常写成转义形式（'C:\\Windows'），先归一化成真实路径。
  const normalized = raw.replace(/\\\\/g, '\\').replace(/\\\//g, '/').toLowerCase();
  if (ALLOWED_ABSOLUTE_PREFIXES.some((prefix) => underPrefix(normalized, prefix))) return false;
  return true;
}

/**
 * 把字节偏移换算成行列，便于定位。
 * @param {string} content 源码
 * @param {number} index 字符下标
 * @returns {{line: number, column: number}} 行列
 */
function positionOf(content, index) {
  const before = content.slice(0, index);
  const line = before.split('\n').length;
  const column = index - before.lastIndexOf('\n');
  return { line, column };
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp();
    return 0;
  }

  const violations = [];

  try {
    const info = await stat(packageDir);
    if (!info.isDirectory()) throw Object.assign(new Error('不是目录'), { code: 'ENOTDIR' });
  } catch (error) {
    process.stderr.write(`无法读取包目录 ${packageDir}：${error.message}\n`);
    return 2;
  }

  const allFiles = await listFiles(packageDir);

  // 断言 1：包内不得有 node_modules。
  for (const file of allFiles) {
    const segments = file.split('/');
    if (segments.includes('node_modules')) {
      violations.push(`包内出现了 node_modules：${file}（包必须零依赖）`);
    }
  }

  // 断言 2：包内不得有 lockfile。
  for (const file of allFiles) {
    const name = file.split('/').pop();
    if (LOCKFILES.has(name)) {
      violations.push(`包内出现了 lockfile：${file}（本项目不用包管理器装依赖）`);
    }
  }

  // 断言 3：package.json 不得声明依赖。
  const manifestPath = join(packageDir, 'package.json');
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const declared = manifest[field];
      if (declared && Object.keys(declared).length > 0) {
        violations.push(`package.json 声明了 ${field}：${Object.keys(declared).join(', ')}（本项目必须零第三方依赖）`);
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      violations.push(`package.json 无法解析：${error.message}`);
    }
  }

  const trackedFiles = await listTrackedFiles(packageDir);

  for (const rel of trackedFiles) {
    const full = join(packageDir, ...rel.split('/'));
    const extension = rel.slice(rel.lastIndexOf('.'));
    const isCode = CODE_EXTENSIONS.has(extension);
    const isText = TEXT_EXTENSIONS.has(extension);
    if (!isCode && !isText) continue;

    let content;
    try {
      const buf = await readFile(full);
      if (!looksTextual(buf)) continue;
      content = buf.toString('utf8');
    } catch {
      continue;
    }

    // 断言 4：import 说明符只能是 node: 内置模块或相对路径。
    if (isCode) {
      // 剥掉注释再找说明符，免得 JSDoc 里的英文散文被当成 import。
      const scannable = stripComments(content);
      for (const { specifier, index } of collectSpecifiers(scannable)) {
        if (isAllowedSpecifier(specifier)) continue;
        const { line, column } = positionOf(content, index);
        violations.push(`${rel}:${line}:${column} 引入了第三方模块「${specifier}」（只允许 node: 内置模块与相对路径）`);
      }
    }

    // 断言 5：不得烤进构建机的绝对路径。
    for (const raw of findAbsolutePaths(content)) {
      if (!isBuildMachinePath(raw)) continue;
      const index = content.indexOf(raw);
      const { line, column } = positionOf(content, index < 0 ? 0 : index);
      violations.push(`${rel}:${line}:${column} 烤进了本机绝对路径「${raw}」`);
    }
  }

  process.stdout.write(
    [
      '=== 打包守卫 ===',
      `包目录：${packageDir}`,
      `跟踪文件数：${trackedFiles.length}`,
      '',
    ].join('\n'),
  );

  if (violations.length === 0) {
    process.stdout.write('结论：包内零 node_modules、零 lockfile、零第三方 import、零本机绝对路径。\n');
    return 0;
  }

  process.stdout.write(`发现 ${violations.length} 处问题：\n`);
  for (const violation of violations) {
    process.stdout.write(`  - ${violation}\n`);
  }
  process.stdout.write('\n结论：打包守卫未通过。\n');
  return 1;
}

process.exitCode = await main();
