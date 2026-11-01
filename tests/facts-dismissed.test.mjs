import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { ManagedProjects } from '../miniapps/mimic-tear/miniapp/node/managed-projects.mjs';
import { makeRuntimeDb, tmpDir, cleanupDir } from './helpers/fixture.mjs';

const CLI = fileURLToPath(new URL('../miniapps/mimic-tear/miniapp/node/patrol-cli.mjs', import.meta.url));
const NODE = process.execPath;

/**
 * 跑一次 CLI，把 stdout 解析成 JSON。
 *
 * @param {string[]} args
 * @returns {any}
 */
function runCli(args) {
  const output = execFileSync(NODE, [CLI, ...args], { encoding: 'utf8' });
  return JSON.parse(output.replace(/^\uFEFF+/, ''));
}

/**
 * 大哥 2026-11-01 13:37 那一轮（**跑在新代码上的第一轮**）查出来的第七条缺陷：
 * `facts` 的 dismissed 口径缺一段。
 *
 * 板面 UI 传了 dismissed（页头正确显示「N 条已处理」），CLI 的 facts 路径**没传**：
 * `facts.duty.dismissed` 恒为 0，已排除的条目照样以「未处理」的样子出现在
 * `facts.decisions` 原始段里。模型读表会以为「从没排除过任何东西」——
 * 于是可能重报已经排除过的项。**同一个词（「已处理」）又是两套口径。**
 */

test('没排除过时：dismissed 计数是 0，条目是未处理的', async () => {
  const dir = tmpDir();
  try {
    const dataDir = `${dir}/data`;
    const dbPath = makeRuntimeDb(dir);
    await new ManagedProjects(dataDir).add('alpha', '大老板点名要盯这个');

    const facts = runCli(['facts', '--data-dir', dataDir, '--db', dbPath]);
    assert.equal(facts.duty.dismissed, 0);
    const item = facts.decisions.find((entry) => entry.id === 'session-error:sess-alpha-w2');
    assert.ok(item, '夹具里有一条 error 会话，应该出现在待办里');
    assert.equal(item.handledBy, null, '还没排除过，不该有处理人');
  } finally {
    cleanupDir(dir);
  }
});

test('排除过之后：dismissed 计数要真，条目要带处理人与理由', async () => {
  const dir = tmpDir();
  try {
    const dataDir = `${dir}/data`;
    const dbPath = makeRuntimeDb(dir);
    await new ManagedProjects(dataDir).add('alpha', '大老板点名要盯这个');

    runCli([
      'dismiss',
      'session-error:sess-alpha-w2',
      '旧残骸，已经自愈',
      '--data-dir',
      dataDir,
      '--db',
      dbPath,
    ]);

    const facts = runCli(['facts', '--data-dir', dataDir, '--db', dbPath]);
    assert.equal(facts.duty.dismissed, 1, '排除过一条，计数不能还是 0');

    const item = facts.decisions.find((entry) => entry.id === 'session-error:sess-alpha-w2');
    assert.ok(item, '排除不等于删除：条目还在清单里，但得标出已被排除');
    assert.equal(item.acknowledged, true, '排除过的条目不算「还没处理」');
    assert.equal(item.handledBy, 'boss', '是大哥排除的');
    assert.match(item.handledReason, /旧残骸/, '排除的理由要跟着走——不然等于悄悄把活丢了');
  } finally {
    cleanupDir(dir);
  }
});
