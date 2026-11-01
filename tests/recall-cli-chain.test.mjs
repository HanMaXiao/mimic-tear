import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { ManagedProjects } from '../miniapps/mimic-tear/miniapp/node/managed-projects.mjs';
import { PatrolStore } from '../miniapps/mimic-tear/miniapp/node/patrol-store.mjs';
import { makeRuntimeDb, tmpDir, cleanupDir } from './helpers/fixture.mjs';

const CLI = fileURLToPath(new URL('../miniapps/mimic-tear/miniapp/node/patrol-cli.mjs', import.meta.url));
const NODE = process.execPath;

/**
 * `patrol-cli recall <id>` 的端到端读数。
 *
 * 这条测试走的是**生产入口**（真的 CLI、真的运行时库、真的板面目录），不是纯函数。
 * 原因：2026-11-01 上岗验收时的那个缺陷在**入口**上，不在纯函数里——
 * `buildFactRefGraph` 一直支持项目节点的下一跳，但 `recall` 入口把
 * `ownerSessionId` 写死成 `null`，而且压根没把「同项目的其它结论」传进去。
 * 只测纯函数的话，这个缺陷会一直绿着。
 */
test('recall 的链要能走到「项目 → 负责会话 → 同项目的其它结论」', async () => {
  const dir = tmpDir();
  try {
    const dataDir = `${dir}/data`;
    const dbPath = makeRuntimeDb(dir);

    const managed = new ManagedProjects(dataDir);
    const patrol = new PatrolStore(dataDir);

    // 管辖名单：没有它，alpha 不在范围内，项目与会话会被过滤掉。
    await managed.add('alpha', '大老板点名要盯这个');
    const first = await patrol.add({
      projectId: 1,
      projectName: 'alpha',
      severity: 'low',
      title: '结论甲',
      body: '甲的正文。',
    });
    const second = await patrol.add({
      projectId: 1,
      projectName: 'alpha',
      severity: 'low',
      title: '结论乙',
      body: '乙的正文。',
    });

    const output = execFileSync(NODE, [
      CLI,
      'recall',
      first.id,
      '--data-dir',
      dataDir,
      '--db',
      dbPath,
    ], { encoding: 'utf8' });
    const payload = JSON.parse(output.replace(/^\uFEFF+/, ''));
    const ids = (payload.chain?.hops ?? []).map((hop) => hop.id);

    assert.equal(payload.found, true, '这条结论必须找得到');
    assert.ok(ids.includes('alpha'), `链里要有项目（实际：${ids.join(' → ')}）`);
    assert.ok(
      ids.includes('sess-alpha-lead'),
      `链里要有负责会话（实际：${ids.join(' → ')}）——ownerSessionId 写死成 null 时这一跳就断了`,
    );
    assert.ok(
      ids.includes(second.id),
      `链里要有同项目的另一条结论（实际：${ids.join(' → ')}）`,
    );
    assert.equal(payload.chain.truncated, false, '三跳走完不算被截断');
  } finally {
    cleanupDir(dir);
  }
});
