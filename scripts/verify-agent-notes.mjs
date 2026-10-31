#!/usr/bin/env node
/**
 * Agent Note 门禁：守住 `.agents/notes/` 的结构与格式。
 *
 * 这套机制的价值在于「决策的理由不丢」，而理由最怕的就是格式腐烂——半年后树里
 * 混着三种骨架，就没人知道哪份还能信。所以格式由脚本守，不靠自觉。
 *
 * 断言：
 *   1. notes 根下只认四种生命周期目录，不许有别的目录，也不许有集中的 INDEX.md
 *   2. 每份 note 的路径是 {生命周期}/{分类}/yyyy-mm-dd-主题.md，分类是封闭集合
 *   3. 前三行固定：抬头、空行、Status:；Status 与所在目录交叉核对，全文只出现一次
 *   4. 第一个二级标题固定是「## 问题」，各生命周期有必带小节
 *   5. implemented/ 里不许出现提案腔的标题
 *   6. 「## 曾考虑的替代方案」强制存在
 *   7. archived/ 里的 note 必须是 implemented 且带一行 Archived: 日期
 *   8. 决策记录只许有一个家：docs/adr、docs/rfc、docs/rfcs 一律禁止
 *
 * 退出码：0 = 通过；1 = 有违规；2 = 用法错误
 *
 * 环境变量：
 *   MIMIC_TEAR_REPO_ROOT    仓库根目录，默认取本脚本所在仓库的根
 *   MIMIC_TEAR_NOTES_ROOT   被检查的 notes 目录，默认 <仓库根>/.agents/notes
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_REPO_ROOT = resolve(SCRIPT_DIR, '..');

const repoRoot = resolve(process.env.MIMIC_TEAR_REPO_ROOT || DEFAULT_REPO_ROOT);
const notesRoot = resolve(
  process.env.MIMIC_TEAR_NOTES_ROOT || join(repoRoot, '.agents', 'notes'),
);

/** 生命周期：note 的状态。archived 是封存区，规则单独判。 */
const LIFECYCLES = ['proposed', 'implemented', 'rejected', 'archived'];

/** 分类：决策的种类。加一个类别必须同时改这里和 .agents/notes/README.md。 */
const CLASSES = ['feature', 'bug-fix', 'simplification', 'architecture', 'process', 'testing'];

/** 允许直接放在生命周期根目录下的非 note 文件。 */
const ROOT_ALLOWLIST = new Set(['AGENTS.md', 'README.md']);

/** 各生命周期的 Status 行文法。 */
const STATUS = {
  proposed: /^Status: proposed$/,
  implemented: /^Status: implemented$/,
  rejected: /^Status: rejected — .+$/,
};

/** 各生命周期除「## 问题」以外的必带二级标题。 */
const REQUIRED = {
  proposed: ['## 提案', '## 验收标准', '## 风险'],
  implemented: ['## 决策', '## 后果'],
  rejected: ['## 提案'],
  archived: ['## 决策', '## 后果'],
};

/**
 * implemented/ 里禁止出现的提案腔标题。
 *
 * 边界用「后面不是汉字」来判断，不能用 `\b`：JavaScript 的 `\w` 只认
 * [A-Za-z0-9_]，中文字符两侧都算非单词字符，所以 `准` 和换行之间**不存在**
 * 词边界——写成 `\b` 会让这条规则永远不触发，看起来在管、实际是死的。
 */
const BANNED_IMPLEMENTED = /^## (?:提案|计划|迁移计划|验收标准)(?=$|[\s(（])/;

/** 替代方案是强制小节——只记结论不记比过什么，等于给后人重新翻案的机会。 */
const ALTERNATIVES = '## 曾考虑的替代方案';

/** 每份 note 的第一个二级标题。 */
const FIRST_SECTION = '## 问题';

/** 归档行：封存日期，必须紧挨在 Status 行下面。 */
const ARCHIVED_LINE = /^Archived: \d{4}-\d{2}-\d{2}$/;

/** 决策记录的其它家一律禁止——多一个家就多一份口径。 */
const FORBIDDEN_DECISION_HOMES = ['docs/adr', 'docs/rfc', 'docs/rfcs'];

/** 源码扫描时跳过的目录。 */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.vendor']);

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
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listFiles(full, base)));
      continue;
    }
    if (entry.isFile()) out.push(relative(base, full).split(sep).join('/'));
  }
  return out.sort();
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
 * 拆出正文行：围栏代码块里的内容不算文档结构。
 * @param {string} content 文件内容
 * @returns {string[]} 正文行
 */
function proseLines(content) {
  const lines = content.split('\n');
  const out = [];
  let inFence = false;
  for (const line of lines) {
    if (line.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) out.push(line);
  }
  return out;
}

/**
 * 校验一份 note 的抬头与正文骨架。
 * @param {string} rel 相对 notes 根的路径
 * @param {string} content 文件内容
 * @param {string} lifecycle 所在生命周期
 * @param {string[]} violations 违规收集器
 */
function checkNote(rel, content, lifecycle, violations) {
  const fail = (msg) => violations.push(`${rel}：${msg}`);
  const lines = content.split('\n');
  const prose = proseLines(content);

  if (!/^# Agent Note: \S/.test(lines[0] ?? '')) {
    fail('第 1 行必须是「# Agent Note: <标题>」');
  }
  if (lines[1] !== '') fail('第 2 行必须是空行');
  const status = STATUS[lifecycle];
  if (status !== undefined && !status.test(lines[2] ?? '')) {
    fail(`第 3 行必须匹配 ${lifecycle} 的状态文法（${String(status)}）`);
  }
  if (lines[3] !== '') fail('第 4 行必须是空行');

  const statusLines = prose.filter((l) => l.startsWith('Status:'));
  if (statusLines.length !== 1) {
    fail(`「Status:」行必须全文只出现一次（实际 ${statusLines.length} 次）`);
  }

  const h2s = prose.filter((l) => l.startsWith('## ')).map((l) => l.trimEnd());
  if (h2s[0] !== FIRST_SECTION) {
    fail(`第一个二级标题必须是「${FIRST_SECTION}」（实际「${h2s[0] ?? '无'}」）`);
  }
  for (const required of REQUIRED[lifecycle] ?? []) {
    if (!h2s.includes(required)) fail(`缺少必带小节「${required}」`);
  }
  if (lifecycle === 'implemented') {
    for (const h2 of h2s.filter((h) => BANNED_IMPLEMENTED.test(h))) {
      fail(`「${h2}」是提案腔标题，已落地的 note 要用现在时（折进「## 决策」／「## 后果」／「## 验证」）`);
    }
  }
  if (!h2s.includes(ALTERNATIVES)) {
    fail(`缺少「${ALTERNATIVES}」——只记结论不记比过什么，等于给后人重新翻案的机会`);
  }

  if (lifecycle === 'archived') {
    if (!/^Status: implemented$/.test(lines[2] ?? '')) {
      fail('归档区只收已落地的 note，Status 必须是「Status: implemented」');
    }
    if (!ARCHIVED_LINE.test(lines[3] ?? '')) {
      fail('封存的 note 必须在 Status 行下面紧挨着一行「Archived: YYYY-MM-DD」');
    }
  }
}

/**
 * 走一遍 notes 树，把结构与格式的问题都收进 violations。
 * @returns {Promise<{count: number, violations: string[]}>} 检查到的 note 数量与违规列表
 */
async function checkTree() {
  const violations = [];

  let rootStat;
  try {
    rootStat = await stat(notesRoot);
  } catch (error) {
    throw Object.assign(new Error(`读不到 notes 目录 ${notesRoot}：${error.message}`), { usage: true });
  }
  if (!rootStat.isDirectory()) {
    throw Object.assign(new Error(`notes 路径不是目录：${notesRoot}`), { usage: true });
  }

  // 断言 1：生命周期目录是封闭集合。
  const rootEntries = await readdir(notesRoot, { withFileTypes: true });
  for (const entry of rootEntries) {
    if (entry.name === 'INDEX.md') {
      violations.push(
        'notes 根目录不许有 INDEX.md——集中的索引会和路径里的信息重复，还让互不相干的改动挤在同一个文件上',
      );
      continue;
    }
    if (entry.isDirectory() && !LIFECYCLES.includes(entry.name)) {
      violations.push(
        `未知的生命周期目录「${entry.name}/」（允许：${LIFECYCLES.join('、')}）`,
      );
    }
  }

  let count = 0;
  for (const lifecycle of LIFECYCLES) {
    const dir = join(notesRoot, lifecycle);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }

    for (const entry of entries) {
      const rel = `${lifecycle}/${entry.name}`;
      if (entry.isFile()) {
        // 断言 2 的附则：生命周期根下只认白名单里的说明文件。
        if (!ROOT_ALLOWLIST.has(entry.name)) {
          violations.push(
            `${rel}：生命周期根目录下只允许 ${[...ROOT_ALLOWLIST].join('、')}，note 要放在分类目录里`,
          );
        }
        continue;
      }
      if (!entry.isDirectory()) continue;

      const classDir = entry.name;
      const files = (await listFiles(join(dir, classDir))).filter((f) => extOf(f) === '.md');
      if (files.length === 0) {
        violations.push(`${rel}/：分类目录是空的`);
        continue;
      }
      if (!CLASSES.includes(classDir)) {
        violations.push(
          `${rel}/：未知的分类目录「${classDir}」（允许：${CLASSES.join('、')}）`,
        );
      }
      for (const file of files) {
        const noteRel = `${rel}/${file}`;
        if (!/^\d{4}-\d{2}-\d{2}-.+\.md$/.test(file)) {
          violations.push(`${noteRel}：文件名必须是 yyyy-mm-dd-主题.md`);
          continue;
        }
        const content = await readFile(join(dir, classDir, ...file.split('/')), 'utf8');
        checkNote(noteRel, content, lifecycle, violations);
        count += 1;
      }
    }
  }

  return { count, violations };
}

/**
 * 断言 8：决策记录只许有一个家。
 * @param {string[]} violations 违规收集器
 */
async function checkDecisionHomes(violations) {
  for (const home of FORBIDDEN_DECISION_HOMES) {
    try {
      const info = await stat(join(repoRoot, ...home.split('/')));
      if (info.isDirectory()) {
        violations.push(
          `${home}/ 是禁止的——决策记录只有一个家，就是 .agents/notes/；` +
            '另开一家的代价是两份口径',
        );
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

async function main() {
  process.stdout.write(
    [
      '=== Agent Note 门禁 ===',
      `notes 目录：${notesRoot}`,
      '',
    ].join('\n'),
  );

  let result;
  try {
    result = await checkTree();
    await checkDecisionHomes(result.violations);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return error.usage ? 2 : 2;
  }

  if (result.violations.length === 0) {
    process.stdout.write(
      `结论：${result.count} 份 Agent Note 全部符合 .agents/notes/README.md 的结构与格式。\n`,
    );
    return 0;
  }

  process.stdout.write(`发现 ${result.violations.length} 处问题：\n`);
  for (const violation of result.violations) {
    process.stdout.write(`  - ${violation}\n`);
  }
  process.stdout.write('\n结论：Agent Note 门禁未通过。\n');
  return 1;
}

process.exitCode = await main();
