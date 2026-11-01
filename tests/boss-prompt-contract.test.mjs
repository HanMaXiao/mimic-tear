import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/check-boss-prompt.mjs', import.meta.url));

/**
 * Run the guard against a fake boss runtime directory.
 *
 * @param {Record<string,string>} files relative path → content
 * @returns {{status:number, stdout:string, stderr:string}}
 */
function runGuard(files) {
  const root = mkdtempSync(join(tmpdir(), 'mimic-boss-prompt-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = join(root, ...rel.split('/'));
      mkdirSync(resolve(full, '..'), { recursive: true });
      writeFileSync(full, content, 'utf8');
    }
    const env = { ...process.env, MIMIC_TEAR_BOSS_ROOT: root };
    try {
      const stdout = execFileSync(process.execPath, [SCRIPT], { encoding: 'utf8', env });
      return { status: 0, stdout, stderr: '' };
    } catch (error) {
      return {
        status: error.status ?? 1,
        stdout: String(error.stdout ?? ''),
        stderr: String(error.stderr ?? ''),
      };
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const PROMPT = 'state/cron-prompt-duty-canonical.txt';
const SKILL = 'skills/mimic-tear-boss/SKILL.md';

/**
 * 约定的那些词，**直接从守卫脚本里读出来**。
 *
 * 以前这里是手写的一串字，于是「加了新约定」这件事必须记得回来改这个假文本——
 * 2026-11-01 就漏了一次：守卫加了 `hostStatus` / `bossSuggestion` 两条约定，
 * 假文本没跟上，契约测试当场变红。**假样本必须从契约本身长出来**，不能手抄。
 */
const CLAIM_TERMS = [...readFileSync(SCRIPT, 'utf8').matchAll(/term:\s*'([^']+)'/g)]
  .map((match) => match[1]);

const FULL = CLAIM_TERMS.join(' ');

test('约定的词必须真的读到了（假文本不是空的）', () => {
  assert.ok(CLAIM_TERMS.length >= 5, `从守卫里读到的约定只有 ${CLAIM_TERMS.length} 条——读法坏了`);
  assert.ok(FULL.includes('patrol-cli answer'), '假文本里必须含多词的约定');
});

test('两份文本都提到关键概念 → 通过', () => {
  const result = runGuard({ [PROMPT]: FULL, [SKILL]: FULL });
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /没有漂移/);
});

test('少改一份 → 变红，并点名缺的是哪一条', () => {
  const result = runGuard({ [PROMPT]: FULL, [SKILL]: 'triggers.candidates recall' });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /delivered/);
  assert.match(result.stdout, /threads/);
  assert.match(result.stdout, /没有同步/);
});

test('文件都不在（CI 上的情形）→ SKIPPED 且以 0 退出，不制造假红', () => {
  const result = runGuard({});
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /SKIPPED/);
});

test('只缺一份文件 → 报出来，但不为它编红', () => {
  const result = runGuard({ [PROMPT]: FULL });
  // 缺的那份没法查，所以只能报告存在性；存在的这份仍要过检查。
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /缺文件/);
});

test('真实机器上的两份文本也要过这一关', () => {
  // 不带 MIMIC_TEAR_BOSS_ROOT：读本机真实的大哥运行时目录。
  let stdout = '';
  let status = 0;
  try {
    stdout = execFileSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  } catch (error) {
    status = error.status ?? 1;
    stdout = String(error.stdout ?? '');
  }
  assert.equal(status, 0, `本机的两份文本漂移了：\n${stdout}`);
  assert.match(stdout, /没有漂移|SKIPPED/);
});
