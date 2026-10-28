#!/usr/bin/env node
/**
 * 发布漂移守卫：把仓库里的 miniapps/mimic-tear 与「已发布副本」逐文件、逐字节地比。
 *
 * 背景：看门狗跑的是已发布副本（~/.minimax/plugins/mimic-tear），不是仓库工作区。
 * 于是「改的是源码、跑的是旧代码」这种漂移不会让任何测试变红，只会让线上行为与代码对不上。
 * 规格 §9 的第 4 条验收原则「新代码真的跑起来过吗」说的就是这件事，这里把它机械化。
 *
 * 退出码：
 *   0 = 两棵树完全一致；或没有已发布副本（打印 SKIPPED，CI 上没装插件也应当放行）
 *   1 = 发现漂移
 *   2 = 用法错误（例如指定的目录不存在）
 *
 * 环境变量：
 *   MIMIC_TEAR_REPO_ROOT      仓库根目录，默认取本脚本所在仓库的根
 *   MIMIC_TEAR_PACKAGE_DIR    待比对的包目录，默认 <仓库根>/miniapps/mimic-tear
 *   MIMIC_TEAR_PUBLISHED_DIR  已发布副本目录，默认 <用户主目录>/.minimax/plugins/mimic-tear
 */

import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_REPO_ROOT = resolve(SCRIPT_DIR, '..');

const repoRoot = resolve(process.env.MIMIC_TEAR_REPO_ROOT || DEFAULT_REPO_ROOT);
const packageDir = resolve(process.env.MIMIC_TEAR_PACKAGE_DIR || join(repoRoot, 'miniapps', 'mimic-tear'));
const publishedDir = resolve(
  process.env.MIMIC_TEAR_PUBLISHED_DIR || join(homedir(), '.minimax', 'plugins', 'mimic-tear'),
);

/**
 * 严格字节模式：把「仅行尾差异」也算作漂移。
 * 默认关闭——CRLF/LF 归一化后代码完全一样，跑起来的行为没有区别。
 */
const strictBytes =
  process.env.MIMIC_TEAR_STRICT_BYTES === '1' || process.argv.includes('--strict-bytes');

/** 比对时跳过的目录：依赖目录不是发布内容，出现即由 check-package 负责报错。 */
const SKIP_DIRS = new Set(['node_modules', '.git']);

/** 只报告文件名，不展开整棵树，避免刷屏。 */
const MAX_REPORTED = 50;

function printHelp() {
  process.stdout.write(
    [
      '用法：node scripts/check-published.mjs',
      '',
      '比较仓库包目录与已发布副本，报告逐字节差异。',
      '',
      '环境变量：',
      '  MIMIC_TEAR_REPO_ROOT      仓库根目录',
      '  MIMIC_TEAR_PACKAGE_DIR    包目录（默认 <仓库根>/miniapps/mimic-tear）',
      '  MIMIC_TEAR_PUBLISHED_DIR  已发布副本目录（默认 ~/.minimax/plugins/mimic-tear）',
      '  MIMIC_TEAR_STRICT_BYTES=1 把「仅行尾差异」也算作漂移',
      '',
      '退出码：0 = 一致（或没有已发布副本，输出 SKIPPED）；1 = 发现漂移；2 = 用法错误',
      '',
    ].join('\n'),
  );
}

/**
 * 递归列出目录下的所有文件，返回相对路径（统一用 / 分隔）。
 * @param {string} dir 目录绝对路径
 * @param {string} [base] 相对路径的基准目录，默认与 dir 相同
 * @returns {Promise<string[]>} 相对路径列表（已排序）
 */
async function listFiles(dir, base = dir) {
  const out = [];
  const entries = await readdir(dir, { withFileTypes: true });
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
 * 把 CRLF 归一化成 LF，用来区分「内容不同」与「只是行尾不同」。
 * @param {Buffer} buf 原始字节
 * @returns {Buffer} 归一化后的字节
 */
function normalizeEol(buf) {
  return Buffer.from(buf.toString('binary').replace(/\r\n/g, '\n'), 'binary');
}

/**
 * 找出第一处不同的字节位置，并换算成行列（行列按字符计，UTF-8 多字节字符不能按字节算）。
 * @param {Buffer} a 一侧字节
 * @param {Buffer} b 另一侧字节
 * @returns {{offset: number, line: number, column: number}|null} 无差异返回 null
 */
function firstDifference(a, b) {
  const len = Math.min(a.length, b.length);
  let offset = len;
  for (let i = 0; i < len; i += 1) {
    if (a[i] !== b[i]) {
      offset = i;
      break;
    }
  }
  if (offset === len && a.length === b.length) return null;

  const prefix = a.subarray(0, offset).toString('utf8');
  const lastNewline = prefix.lastIndexOf('\n');
  const line = prefix.split('\n').length;
  const column = prefix.length - lastNewline;
  return { offset, line, column };
}

/**
 * 取包含给定字节偏移量的那一行，并围绕差异位置截出一小段上下文。
 * @param {Buffer} buf 文件字节
 * @param {number} byteOffset 字节偏移
 * @returns {string} 上下文片段
 */
function lineAt(buf, byteOffset) {
  const text = buf.toString('utf8');
  const prefix = buf.subarray(0, byteOffset).toString('utf8');
  const charIndex = Math.min(prefix.length, Math.max(text.length - 1, 0));
  const start = text.lastIndexOf('\n', charIndex) + 1;
  let end = text.indexOf('\n', charIndex);
  if (end === -1) end = text.length;
  const line = text.slice(start, end);

  // 行太长时围绕差异点开窗，否则两边看起来一模一样。
  const half = 60;
  const focus = Math.max(0, charIndex - start);
  if (line.length <= half * 2 + 5) return line.trim();
  const from = Math.max(0, focus - half);
  const to = Math.min(line.length, focus + half);
  return `${from > 0 ? '…' : ''}${line.slice(from, to).trim()}${to < line.length ? '…' : ''}`;
}

/**
 * 比对单个文件，返回差异描述；一致返回 null。
 * @param {string} rel 相对路径
 * @param {string} repoFile 仓库侧绝对路径
 * @param {string} pubFile 发布侧绝对路径
 * @returns {Promise<{kind: string, text: string}|null>} 差异描述
 */
async function compareFile(rel, repoFile, pubFile) {
  const [a, b] = await Promise.all([readFile(repoFile), readFile(pubFile)]);
  if (a.equals(b)) return null;

  const onlyEol = normalizeEol(a).equals(normalizeEol(b));
  const diff = firstDifference(a, b);
  if (onlyEol) {
    return {
      kind: '仅行尾差异',
      text: [
        `    ${rel}`,
        `      仅行尾差异（CRLF/LF）：仓库 ${a.length} 字节 / 发布 ${b.length} 字节，归一化后内容一致`,
      ].join('\n'),
    };
  }
  if (!diff) {
    return {
      kind: '内容差异',
      text: `    ${rel}\n      内容差异：两侧字节完全相同，但行尾风格不同`,
    };
  }
  return {
    kind: '内容差异',
    text: [
      `    ${rel}`,
      `      内容差异：仓库 ${a.length} 字节 / 发布 ${b.length} 字节`,
      `      首个差异在第 ${diff.line} 行第 ${diff.column} 列（字节偏移 ${diff.offset}）`,
      `      仓库：${lineAt(a, diff.offset)}`,
      `      发布：${lineAt(b, diff.offset)}`,
    ].join('\n'),
  };
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp();
    return 0;
  }

  let repoFiles;
  try {
    repoFiles = await listFiles(packageDir);
  } catch (error) {
    process.stderr.write(`无法读取包目录 ${packageDir}：${error.message}\n`);
    return 2;
  }

  let publishedFiles;
  try {
    publishedFiles = await listFiles(publishedDir);
  } catch (error) {
    if (error.code === 'ENOENT') {
      process.stdout.write(
        [
          '=== 发布漂移检查 ===',
          `仓库包目录：${packageDir}`,
          `已发布副本：${publishedDir}`,
          '',
          `SKIPPED：没有找到已发布副本（${error.code}），本机未安装插件，跳过漂移比对。`,
          '',
        ].join('\n'),
      );
      return 0;
    }
    process.stderr.write(`无法读取已发布副本 ${publishedDir}：${error.message}\n`);
    return 2;
  }

  process.stdout.write(
    [
      '=== 发布漂移检查 ===',
      `仓库包目录：${packageDir}`,
      `已发布副本：${publishedDir}`,
      `文件数：仓库 ${repoFiles.length} / 发布 ${publishedFiles.length}`,
      '',
    ].join('\n'),
  );

  const repoSet = new Set(repoFiles);
  const pubSet = new Set(publishedFiles);
  const onlyRepo = repoFiles.filter((f) => !pubSet.has(f));
  const onlyPublished = publishedFiles.filter((f) => !repoSet.has(f));
  const shared = repoFiles.filter((f) => pubSet.has(f));

  const differences = [];
  const warnings = [];
  const kinds = new Map();

  const push = (kind, text) => {
    differences.push(text);
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  };

  for (const rel of onlyRepo) {
    push('仅在仓库', `    ${rel}\n      仅在仓库中存在：发布副本缺少这个文件`);
  }
  for (const rel of onlyPublished) {
    push('仅在发布', `    ${rel}\n      仅在已发布副本中存在：仓库已删除，发布副本里还是旧的`);
  }
  for (const rel of shared) {
    const desc = await compareFile(rel, join(packageDir, ...rel.split('/')), join(publishedDir, ...rel.split('/')));
    if (!desc) continue;
    // 仅行尾差异：归一化后代码完全一样，跑起来的行为也一样，默认只当警告。
    if (desc.kind === '仅行尾差异' && !strictBytes) {
      warnings.push(desc.text);
      continue;
    }
    push(desc.kind, desc.text);
  }

  if (warnings.length > 0) {
    process.stdout.write(`另有 ${warnings.length} 处仅行尾差异（归一化后内容一致，不计入漂移）：\n`);
    for (const text of warnings) process.stdout.write(`${text}\n`);
    process.stdout.write('\n');
  }

  if (differences.length === 0) {
    process.stdout.write('结论：仓库与已发布副本在代码内容上一致，没有漂移。\n');
    return 0;
  }

  const breakdown = [...kinds.entries()].map(([kind, count]) => `${kind} ${count}`).join('、');
  process.stdout.write(`发现 ${differences.length} 处漂移（${breakdown}）：\n`);
  for (const desc of differences.slice(0, MAX_REPORTED)) {
    process.stdout.write(`${desc}\n`);
  }
  if (differences.length > MAX_REPORTED) {
    process.stdout.write(`    …其余 ${differences.length - MAX_REPORTED} 处省略\n`);
  }
  process.stdout.write(
    [
      '',
      '结论：仓库与已发布副本不一致。看门狗跑的是已发布副本，请重新发布后再验证。',
      '',
    ].join('\n'),
  );
  return 1;
}

process.exitCode = await main();
