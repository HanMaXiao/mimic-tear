#!/usr/bin/env node
/**
 * 风格守卫：只管这个仓库真正在守的几条规矩，不搞通用 lint。
 *
 * 本项目零第三方依赖，装不了 Biome/ESLint/Prettier，所以这里用几十行脚本
 * 把最容易被绕过的三条约定守住：
 *   1. 运行时（miniapp/node）里不许出现 console.log / console.error —— 走 context.logger 的结构化日志
 *   2. 发出去的源码里不许留 TODO / FIXME
 *   3. 客户端三件套里不许出现 emoji
 *
 * 第 3 条的检测正则**从 tests/client-contract.test.mjs 里现读**，
 * 而不是在这里抄一份——抄两份就等于两份都能漂移，现读才能保证两边永远一致。
 *
 * 退出码：0 = 通过；1 = 有违规；2 = 用法错误
 *
 * 环境变量：
 *   MIMIC_TEAR_REPO_ROOT            仓库根目录，默认取本脚本所在仓库的根
 *   MIMIC_TEAR_PACKAGE_DIR          被检查的包目录，默认 <仓库根>/miniapps/mimic-tear
 *   MIMIC_TEAR_CLIENT_CONTRACT_TEST 客户端契约测试文件，默认 <仓库根>/tests/client-contract.test.mjs
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_REPO_ROOT = resolve(SCRIPT_DIR, '..');

const repoRoot = resolve(process.env.MIMIC_TEAR_REPO_ROOT || DEFAULT_REPO_ROOT);
const packageDir = resolve(process.env.MIMIC_TEAR_PACKAGE_DIR || join(repoRoot, 'miniapps', 'mimic-tear'));
const clientContractTest = resolve(
  process.env.MIMIC_TEAR_CLIENT_CONTRACT_TEST || join(repoRoot, 'tests', 'client-contract.test.mjs'),
);

/** 运行时目录：这里的代码由宿主加载，用的是 context.logger。 */
const RUNTIME_DIR = join(packageDir, 'miniapp', 'node');

/** 客户端的源码目录：拆成原生 ES 模块之后，文件在 assets/ 下面按目录分。 */
const CLIENT_DIR = join(packageDir, 'miniapp', 'client');
const CLIENT_ASSETS = join(CLIENT_DIR, 'assets');

/** 源码扫描时跳过的目录。 */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.vendor']);

/** 参与扫描的文本扩展名。 */
const TEXT_EXTENSIONS = new Set([
  '.mjs', '.js', '.cjs', '.ts', '.json', '.html', '.css', '.md', '.txt',
  '.yml', '.yaml', '.xml', '.vbs', '.sh',
]);

/** 从客户端契约测试里提取 emoji 正则的写法。 */
const EMOJI_DECL = /const\s+EMOJI\s*=\s*\/((?:\\.|[^/\\\n])+)\/([a-z]*)\s*;/;

function printHelp() {
  process.stdout.write(
    [
      '用法：node scripts/check-style.mjs',
      '',
      '检查运行时里的 console 调用、源码里遗留的 TODO/FIXME、客户端里的 emoji。',
      'emoji 的检测正则直接取自 tests/client-contract.test.mjs，两边不会漂移。',
      '',
      '环境变量：',
      '  MIMIC_TEAR_REPO_ROOT            仓库根目录',
      '  MIMIC_TEAR_PACKAGE_DIR          被检查的包目录',
      '  MIMIC_TEAR_CLIENT_CONTRACT_TEST 客户端契约测试文件',
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
 * 客户端的源文件清单（相对包目录）。
 *
 * 客户端是一个目录，不是一份固定的文件清单：`index.html` 加 `assets/` 下面按视图拆开
 * 的模块与样式表。写死文件名的话，每拆一次就得跟着改一次——而且改漏了不会报错，只
 * 会让 emoji 检查悄悄少看几个文件。
 *
 * @returns {Promise<string[]>} 相对包目录的路径列表
 */
async function listClientFiles() {
  const out = [];
  for (const rel of await listFiles(CLIENT_DIR)) {
    const ext = extOf(rel);
    if (rel === 'index.html' || ext === '.js' || ext === '.css') {
      out.push(join('miniapp', 'client', ...rel.split('/')));
    }
  }
  return out;
}

/**
 * 取文件的小写扩展名。
 * @param {string} rel 相对路径
 * @returns {string} 扩展名（含点），没有扩展名时返回空串
 */
function extOf(rel) {
  const dot = rel.lastIndexOf('.');
  const slash = rel.lastIndexOf('/');
  if (dot === -1 || dot < slash) return '';
  return rel.slice(dot);
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

/**
 * 从客户端契约测试里现读 emoji 正则。
 * @param {string} testSource 测试文件内容
 * @returns {RegExp} emoji 正则
 */
function readEmojiPattern(testSource) {
  const match = testSource.match(EMOJI_DECL);
  if (!match) {
    throw new Error(
      '无法从客户端契约测试里提取 EMOJI 正则：风格守卫与 tests/client-contract.test.mjs 已经漂移，请先同步两边。',
    );
  }
  return new RegExp(match[1], match[2]);
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp();
    return 0;
  }

  try {
    const info = await stat(packageDir);
    if (!info.isDirectory()) throw Object.assign(new Error('不是目录'), { code: 'ENOTDIR' });
  } catch (error) {
    process.stderr.write(`无法读取包目录 ${packageDir}：${error.message}\n`);
    return 2;
  }

  let testSource;
  try {
    testSource = await readFile(clientContractTest, 'utf8');
  } catch (error) {
    process.stderr.write(`无法读取客户端契约测试 ${clientContractTest}：${error.message}\n`);
    return 2;
  }

  let emojiPattern;
  try {
    emojiPattern = readEmojiPattern(testSource);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }

  const violations = [];

  // 客户端契约测试覆盖的文件如果变了，这里也要跟着变，否则 emoji 检查会漏。
  //
  // 客户端已经拆成一棵模块树，契约测试是**扫目录**拿到文件清单的，不再逐个写死名字。
  // 所以这里要问的是另一件事：契约测试还在扫目录吗？它扫的目录和这里扫的是同一个吗？
  // 只要它还在按 '.js' 与 '.css' 递归扫 assets 目录，两边的覆盖面就是一样的。
  for (const needle of ["'.js'", "'.css'", 'assets']) {
    if (!testSource.includes(needle)) {
      violations.push(
        `客户端契约测试里找不到「${needle}」——它可能不再扫整个 assets 目录了，`
        + '这样 emoji 检查会漏掉一部分客户端文件，请同步 tests/client-contract.test.mjs',
      );
    }
  }

  // 断言 1：运行时里不许有 console.log / console.error。
  const runtimeFiles = await listFiles(RUNTIME_DIR);
  for (const rel of runtimeFiles) {
    if (!['.mjs', '.js', '.cjs', '.ts'].includes(extOf(rel))) continue;
    const full = join(RUNTIME_DIR, ...rel.split('/'));
    const content = await readFile(full, 'utf8');
    const pattern = /(?<![.\w])console\s*\.\s*(log|error)\s*\(/g;
    for (const match of content.matchAll(pattern)) {
      const { line, column } = positionOf(content, match.index);
      violations.push(
        `miniapp/node/${rel}:${line}:${column} 用了 console.${match[1]}，运行时请走 context.logger 的结构化日志`,
      );
    }
  }

  // 断言 2：发出去的源码里不许留 TODO / FIXME。
  const packageFiles = await listFiles(packageDir);
  for (const rel of packageFiles) {
    if (!TEXT_EXTENSIONS.has(extOf(rel))) continue;
    const full = join(packageDir, ...rel.split('/'));
    const buf = await readFile(full);
    if (buf.subarray(0, 4096).includes(0)) continue;
    const content = buf.toString('utf8');
    const pattern = /\b(?:TODO|FIXME)\b/g;
    for (const match of content.matchAll(pattern)) {
      const { line, column } = positionOf(content, match.index);
      violations.push(`${rel}:${line}:${column} 留下了 ${match[0]}，发布前请处理掉`);
    }
  }

  // 断言 3：客户端里不许有 emoji（与客户端契约测试同一套正则）。
  const clientFiles = await listClientFiles();
  for (const rel of clientFiles) {
    const full = join(packageDir, ...rel.split('/'));
    let content;
    try {
      content = await readFile(full, 'utf8');
    } catch (error) {
      violations.push(`客户端文件缺失：${rel}（${error.code}）`);
      continue;
    }
    const found = content.match(emojiPattern);
    if (found) {
      const index = content.indexOf(found[0]);
      const { line, column } = positionOf(content, index);
      violations.push(`${rel}:${line}:${column} 含有 emoji：${found[0]}`);
    }
  }

  process.stdout.write(
    [
      '=== 风格守卫 ===',
      `包目录：${packageDir}`,
      `emoji 正则来源：${clientContractTest}`,
      '',
    ].join('\n'),
  );

  if (violations.length === 0) {
    process.stdout.write('结论：运行时没有 console 调用，源码里没有遗留 TODO/FIXME，客户端没有 emoji。\n');
    return 0;
  }

  process.stdout.write(`发现 ${violations.length} 处问题：\n`);
  for (const violation of violations) {
    process.stdout.write(`  - ${violation}\n`);
  }
  process.stdout.write('\n结论：风格守卫未通过。\n');
  return 1;
}

process.exitCode = await main();
