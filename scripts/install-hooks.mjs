#!/usr/bin/env node
/**
 * 提交守卫：把「不许用会扫全树的提交方式」这条纪律变成可执行的拦截。
 *
 * 依据：docs/plans/2026-10-22-line-ownership.md 第 3 节——
 *   「这个仓库里不许用会扫全树的提交方式。git add -A / git add . / git commit -a
 *     在这里是错的：它会把对方的在制品（写到一半的改动）一起卷进同一个 commit。」
 *
 * pre-commit 钩子看不到当初敲的是哪条 git 命令，所以这里拦的不是命令本身，
 * 而是那条命令造成的后果——两条规则都是机械可判的：
 *
 *   规则一（作用域）：声明了提交作用域时，暂存区里出现作用域之外的文件 → 拒绝。
 *     `git add -A` 会把作用域外的文件一起卷进来，于是被这条挡住。
 *   规则二（在制品）：暂存区里的文件，如果同时出现在同一个仓库的**其它 worktree**
 *     的未提交改动里 → 拒绝。这正是「把对方的在制品卷进同一个 commit」。
 *
 * 用法：
 *   node scripts/install-hooks.mjs                 安装 pre-commit 钩子
 *   node scripts/install-hooks.mjs --print         打印钩子内容与安装说明，不落盘
 *   node scripts/install-hooks.mjs --guard-commit  钩子内部调用，跑一次守卫
 *   node scripts/install-hooks.mjs --self-test     在临时 git 仓库里自测守卫
 *
 * 作用域声明（规则一才生效）：
 *   环境变量 MIMIC_TEAR_COMMIT_SCOPE      例：scripts,tests/packaging.test.mjs
 *   或文件 <git-dir>/mimic-tear-commit-scope.txt，每行一条
 *
 * 退出码：0 = 放行；1 = 拒绝提交；2 = 用法错误
 */

import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const SCRIPT_PATH = fileURLToPath(import.meta.url);

/** 钩子文件里的标记，用来认出「这个钩子是我们装的」，避免覆盖别人的钩子。 */
const HOOK_MARKER = '# mimic-tear-commit-guard';

/** 作用域声明文件名，放在 git 目录里（不入库，也不会污染工作区）。 */
const SCOPE_FILE = 'mimic-tear-commit-scope.txt';

function printHelp() {
  process.stdout.write(
    [
      '用法：node scripts/install-hooks.mjs [选项]',
      '',
      '  （无参数）      安装 pre-commit 钩子',
      '  --print         打印钩子内容与安装说明，不写任何文件',
      '  --guard-commit  跑一次提交守卫（供钩子内部调用）',
      '  --self-test     在临时 git 仓库里自测守卫',
      '  --help          显示这段说明',
      '',
    ].join('\n'),
  );
}

/**
 * 跑一条 git 命令，失败时返回 null 而不是抛异常——守卫必须「坏了就放行」，不能把仓库锁死。
 * @param {string[]} args git 参数
 * @param {string} [cwd] 工作目录
 * @returns {Promise<string|null>} 标准输出，或 null
 */
async function git(args, cwd) {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return null;
  }
}

/**
 * 读取提交作用域声明。
 * @param {string} gitDir git 目录绝对路径
 * @returns {Promise<string[]>} 作用域条目（已归一化为去掉首尾斜杠的相对路径）
 */
async function readScope(gitDir) {
  const fromEnv = process.env.MIMIC_TEAR_COMMIT_SCOPE;
  const raw = fromEnv && fromEnv.trim()
    ? fromEnv
    : await (async () => {
      try {
        return await readFile(join(gitDir, SCOPE_FILE), 'utf8');
      } catch {
        return '';
      }
    })();
  return raw
    .split(/[\s,;]+/)
    .map((entry) => entry.trim().replace(/^\.\//, '').replace(/\/+$/, ''))
    .filter(Boolean);
}

/**
 * 判断路径是否落在作用域内。
 * @param {string} file 仓库相对路径
 * @param {string[]} scope 作用域条目
 * @returns {boolean} 是否在作用域内
 */
function inScope(file, scope) {
  if (scope.length === 0) return true;
  return scope.some((entry) => file === entry || file.startsWith(`${entry}/`));
}

/**
 * 列出仓库里的所有 worktree（不含当前工作区）。
 * @param {string} cwd 当前工作目录
 * @returns {Promise<string[]>} 其它 worktree 的绝对路径
 */
async function listOtherWorktrees(cwd) {
  const out = await git(['worktree', 'list', '--porcelain'], cwd);
  if (!out) return [];
  const paths = [];
  for (const line of out.split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    paths.push(line.slice('worktree '.length).trim());
  }
  const current = resolve(cwd);
  return paths.filter((p) => resolve(p) !== current);
}

/**
 * 取某个 worktree 里所有未提交的路径（含未跟踪文件）。
 * @param {string} dir worktree 目录
 * @returns {Promise<string[]>} 仓库相对路径列表
 */
async function dirtyFiles(dir) {
  const out = await git(['status', '--porcelain', '-z', '--untracked-files=all'], dir);
  if (!out) return [];
  const files = [];
  for (const entry of out.split('\0')) {
    if (!entry) continue;
    // porcelain v1 的每条记录是「XY 路径」，重命名时多跟一个原始路径。
    const path = entry.slice(3).trim();
    if (path) files.push(path.replace(/\\/g, '/'));
  }
  return files;
}

/**
 * 跑一次提交守卫。
 * @param {string} cwd 工作目录
 * @returns {Promise<number>} 退出码
 */
async function guardCommit(cwd) {
  const gitDirOut = await git(['rev-parse', '--absolute-git-dir'], cwd);
  const gitDir = gitDirOut ? gitDirOut.trim() : '';
  const stagedOut = await git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], cwd);
  const staged = (stagedOut ?? '').split('\0').filter(Boolean).map((p) => p.replace(/\\/g, '/'));

  if (staged.length === 0) return 0;

  const scope = await readScope(gitDir);
  const violations = [];

  // 规则一：作用域之外的路径。
  if (scope.length > 0) {
    const outside = staged.filter((file) => !inScope(file, scope));
    if (outside.length > 0) {
      violations.push(
        `提交范围超出了声明的作用域（${scope.join(', ')}）：\n    ${outside.join('\n    ')}`,
      );
    }
  }

  // 规则二：别的 worktree 里的在制品。
  const others = await listOtherWorktrees(cwd);
  for (const other of others) {
    const dirty = await dirtyFiles(other);
    if (dirty.length === 0) continue;
    const conflict = staged.filter((file) => dirty.includes(file));
    if (conflict.length > 0) {
      violations.push(
        `这些文件在另一个 worktree 里还是未提交的在制品（${other}）：\n    ${conflict.join('\n    ')}`,
      );
    }
  }

  if (violations.length > 0) {
    process.stderr.write(
      [
        '',
        '提交被拒绝：这个仓库不许用会扫全树的提交方式。',
        '依据 docs/plans/2026-10-22-line-ownership.md 第 3 节。',
        '',
        ...violations.map((v) => `  - ${v}`),
        '',
        '请按路径限定提交：git commit -m "<说明>" -- <路径1> <路径2> ...',
        '若要声明本次提交的作用域，写入 <git-dir>/' + SCOPE_FILE + ' 或设置 MIMIC_TEAR_COMMIT_SCOPE。',
        '',
      ].join('\n'),
    );
    return 1;
  }

  return 0;
}

/** 钩子正文：运行时解析当前 worktree 的根目录，worktree 之间互不干扰。 */
const HOOK_BODY = `#!/bin/sh
${HOOK_MARKER}
# 由 scripts/install-hooks.mjs 生成，请勿手改；要改就改那个脚本再重新安装。
# 拦的是「扫全树的提交方式」造成的后果：作用域外的文件、别的 worktree 里的在制品。
root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
[ -f "$root/scripts/install-hooks.mjs" ] || exit 0
exec node "$root/scripts/install-hooks.mjs" --guard-commit
`;

/**
 * 安装 pre-commit 钩子。
 * @returns {Promise<number>} 退出码
 */
async function install() {
  const cwd = process.cwd();
  const hooksOut = await git(['rev-parse', '--git-path', 'hooks/pre-commit'], cwd);
  if (!hooksOut) {
    process.stderr.write('不在 git 仓库里，无法安装钩子。\n');
    return 2;
  }
  const hookPath = resolve(cwd, hooksOut.trim());

  let existing = '';
  try {
    existing = await readFile(hookPath, 'utf8');
  } catch {
    existing = '';
  }
  if (existing && !existing.includes(HOOK_MARKER)) {
    process.stderr.write(
      `${hookPath} 已经存在且不是本脚本装的，为了不覆盖别人的钩子，这里不动它。\n` +
      '请自行把下面的内容并进去：\n\n' +
      HOOK_BODY,
    );
    return 1;
  }

  await mkdir(dirname(hookPath), { recursive: true });
  await writeFile(hookPath, HOOK_BODY, 'utf8');
  await chmod(hookPath, 0o755).catch(() => {});

  process.stdout.write(
    [
      `已安装 pre-commit 钩子：${hookPath}`,
      '',
      '钩子会拦下两类提交：',
      '  1. 暂存区里有超出声明作用域的文件（git add -A 会造成这种结果）',
      '  2. 暂存区里有另一个 worktree 里还没提交的在制品',
      '',
      '声明作用域：把路径逐行写进 <git-dir>/' + SCOPE_FILE + '，或设置 MIMIC_TEAR_COMMIT_SCOPE。',
      '',
    ].join('\n'),
  );
  return 0;
}

/**
 * 自测：在临时 git 仓库里造三种场景，确认守卫的判定符合预期。
 * @returns {Promise<number>} 退出码
 */
async function selfTest() {
  const root = await mkdtemp(join(tmpdir(), 'mimic-hook-test-'));
  const results = [];

  const run = async (label, expected, fn) => {
    const code = await fn();
    const ok = code === expected;
    results.push({ label, expected, actual: code, ok });
  };

  try {
    const repo = join(root, 'repo');
    await mkdir(repo, { recursive: true });
    await git(['init', '-q'], repo);
    await git(['config', 'user.email', 'guard@example.com'], repo);
    await git(['config', 'user.name', 'guard'], repo);
    await writeFile(join(repo, 'a.txt'), 'a\n', 'utf8');
    await writeFile(join(repo, 'b.txt'), 'b\n', 'utf8');
    await git(['add', 'a.txt'], repo);
    await git(['commit', '-q', '-m', 'init'], repo);

    // 场景一：路径限定、没声明作用域 → 放行。
    await writeFile(join(repo, 'a.txt'), 'a2\n', 'utf8');
    await git(['add', 'a.txt'], repo);
    await run('路径限定的提交放行', 0, () => guardCommit(repo));

    // 场景二：声明了作用域却暂存了作用域外的文件 → 拦截。
    await writeFile(join(repo, 'b.txt'), 'b2\n', 'utf8');
    await git(['add', 'b.txt'], repo);
    process.env.MIMIC_TEAR_COMMIT_SCOPE = 'a.txt';
    await run('超出声明作用域被拦下', 1, () => guardCommit(repo));
    delete process.env.MIMIC_TEAR_COMMIT_SCOPE;

    // 场景三：暂存了另一个 worktree 里的在制品 → 拦截。
    const other = join(root, 'other');
    await git(['worktree', 'add', '-q', '-b', 'other-branch', other], repo);
    // 对方在另一个 worktree 里写了一半 c.txt（已暂存，未提交）。
    await writeFile(join(other, 'c.txt'), 'c 对方的在制品\n', 'utf8');
    await git(['add', 'c.txt'], other);
    // 我这边也动了同一个路径并暂存——这正是「把对方的在制品卷进同一个 commit」。
    await writeFile(join(repo, 'c.txt'), 'c 我这边的改动\n', 'utf8');
    await git(['add', 'c.txt', 'b.txt'], repo);
    await run('别的 worktree 的在制品被拦下', 1, () => guardCommit(repo));

    // 场景四：暂存区为空 → 放行。
    await git(['reset', '-q'], repo);
    await run('空暂存区放行', 0, () => guardCommit(repo));
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  process.stdout.write('=== 提交守卫自测 ===\n');
  let failed = 0;
  for (const r of results) {
    const mark = r.ok ? '通过' : '失败';
    if (!r.ok) failed += 1;
    process.stdout.write(`  [${mark}] ${r.label}（期望退出码 ${r.expected}，实际 ${r.actual}）\n`);
  }
  process.stdout.write(failed === 0 ? '\n自测全部通过。\n' : `\n自测有 ${failed} 项失败。\n`);
  return failed === 0 ? 0 : 1;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return 0;
  }
  if (args.includes('--guard-commit')) return guardCommit(process.cwd());
  if (args.includes('--self-test')) return selfTest();
  if (args.includes('--print')) {
    process.stdout.write(
      [
        '=== pre-commit 钩子正文 ===',
        HOOK_BODY,
        '=== 安装方法 ===',
        'node scripts/install-hooks.mjs',
        '',
        '钩子会写进 git 的公共 hooks 目录（同仓库的多个 worktree 共用），',
        '但它在运行时用 git rev-parse --show-toplevel 定位当前 worktree，因此互不干扰。',
        '',
      ].join('\n'),
    );
    return 0;
  }
  return install();
}

process.exitCode = await main();
