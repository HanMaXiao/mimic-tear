import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { BoardStateStore, BOARD_STATE_FILE } from '../miniapps/mimic-tear/miniapp/node/board-state.mjs';
import { tmpDir, cleanupDir } from './helpers/fixture.mjs';

/**
 * @param {string} dir
 * @param {string} file
 * @param {any} value
 * @returns {void}
 */
function writeLegacy(dir, file, value) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), JSON.stringify(value), 'utf8');
}

test('老账搬进 store：一次性搬完，之后老文件不再被读', async () => {
  const dir = tmpDir();
  try {
    writeLegacy(dir, 'dispatches.json', [{ id: 'dsp-1', instruction: '干活' }]);
    writeLegacy(dir, 'acks.json', ['item-1']);
    writeLegacy(dir, 'dismissed.json', [{ id: 'item-2', reason: '残骸', at: 1 }]);
    writeLegacy(dir, 'boss-session.json', { sessionId: 'sess-1', agent: 'boss' });

    const store = new BoardStateStore(dir);
    const state = await store.read();

    assert.equal(state.dispatches.length, 1, '派工账要搬进来');
    assert.deepEqual(state.acks, ['item-1']);
    assert.equal(state.dismissed.length, 1);
    assert.deepEqual(state.bossSession, { sessionId: 'sess-1', agent: 'boss' });

    // 老文件改了，store 不跟着变——**只有一份口径**。
    writeLegacy(dir, 'dispatches.json', [{ id: 'dsp-2', instruction: '后来的' }]);
    const again = await store.read();
    assert.equal(again.dispatches.length, 1, '老文件不再是真相');
    assert.equal(again.dispatches[0].id, 'dsp-1');
  } finally {
    cleanupDir(dir);
  }
});

test('迁移只发生一次：store 在了就直接用它', async () => {
  const dir = tmpDir();
  try {
    const store = new BoardStateStore(dir);
    await store.update((state) => ({ ...state, acks: ['item-1'] }));

    // 老文件这时才出现——它不该被读进来。
    writeLegacy(dir, 'acks.json', ['老文件里的']);
    const state = await store.read();
    assert.deepEqual(state.acks, ['item-1'], 'store 在了，老文件就不算了');
  } finally {
    cleanupDir(dir);
  }
});

test('过渡期：改动的那几段会镜像回老文件（回退时老代码读得懂）', async () => {
  const dir = tmpDir();
  try {
    const store = new BoardStateStore(dir);
    await store.update((state) => ({ ...state, acks: ['item-1'] }));

    // 镜像写出来了，内容一致——**镜子不是真相，但镜子不能是陈旧的**：
    // 万一这套收口后来被否掉，老代码（它只读老文件）读到的是最新的。
    const legacy = JSON.parse(readFileSync(join(dir, 'acks.json'), 'utf8'));
    assert.deepEqual(legacy, ['item-1'], '老文件要跟着更新');
  } finally {
    cleanupDir(dir);
  }
});

test('回退是显式动作：export-legacy 把老文件补齐', async () => {
  const dir = tmpDir();
  try {
    const store = new BoardStateStore(dir);
    await store.update((state) => ({ ...state, acks: ['item-1'] }));

    // 有人把老文件改了（或者删了）。
    writeFileSync(join(dir, 'acks.json'), '[]', 'utf8');
    const result = await store.exportLegacy();
    assert.deepEqual(result.failed, [], '不该有段写不回去');
    assert.ok(result.written.includes('acks'));

    assert.deepEqual(
      JSON.parse(readFileSync(join(dir, 'acks.json'), 'utf8')),
      ['item-1'],
      '显式导出后老文件是齐的',
    );
  } finally {
    cleanupDir(dir);
  }
});

test('老账坏了：那一段读不出来，但别的段照常', async () => {
  const dir = tmpDir();
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'dispatches.json'), '[{"id":"dsp-1",', 'utf8');
    writeFileSync(join(dir, 'acks.json'), JSON.stringify(['item-1']), 'utf8');

    const store = new BoardStateStore(dir);
    const state = await store.read();

    // 坏的那一段**记住它坏**，不是当成空段。
    assert.deepEqual(state.acks, ['item-1'], '别的段照常搬进来');
    assert.ok(state.damaged?.dispatches, '坏的那段被标记出来');
    assert.match(String(state.damaged.dispatches), /JSON/, '标记里说清是哪个文件、报了什么');

    // 读那一段要报错——当成空账就等于「记录明明在、读回来像没有」。
    await assert.rejects(
      () => store.section('dispatches'),
      /读不出来/,
      '读不出来的账必须报错，不能当成空账',
    );
    // 别的段不受牵连。
    assert.deepEqual(await store.section('acks'), ['item-1']);
  } finally {
    cleanupDir(dir);
  }
});

test('两段互不干扰：写派工不会动确认账', async () => {
  const dir = tmpDir();
  try {
    const store = new BoardStateStore(dir);
    await store.update((state) => ({ ...state, acks: ['item-1'] }));
    await store.update((state) => ({
      ...state,
      dispatches: [...state.dispatches, { id: 'dsp-1' }],
    }));

    const state = await store.read();
    assert.deepEqual(state.acks, ['item-1'], '确认账没被动过');
    assert.equal(state.dispatches.length, 1);
  } finally {
    cleanupDir(dir);
  }
});

test('两个 store 实例（两个进程）各写各的，一条都不能丢', async () => {
  const dir = tmpDir();
  try {
    const board = new BoardStateStore(dir);
    const duty = new BoardStateStore(dir);

    await Promise.all([
      board.update((state) => ({ ...state, dispatches: [...state.dispatches, { id: 'board-1' }] })),
      duty.update((state) => ({ ...state, dispatches: [...state.dispatches, { id: 'duty-1' }] })),
    ]);

    const state = await board.read();
    const ids = state.dispatches.map((item) => item.id).sort();
    assert.deepEqual(ids, ['board-1', 'duty-1'], '两个写者的记录都要在');
  } finally {
    cleanupDir(dir);
  }
});

test('老版本写的大哥会话是裸字符串，读得出来', async () => {
  const dir = tmpDir();
  try {
    writeLegacy(dir, 'boss-session.json', 'sess-old');
    const store = new BoardStateStore(dir);
    assert.deepEqual(
      await store.section('bossSession'),
      { sessionId: 'sess-old', agent: 'boss' },
    );
  } finally {
    cleanupDir(dir);
  }
});

test('写的时候永远读到完整文档', async () => {
  const dir = tmpDir();
  try {
    const store = new BoardStateStore(dir);
    const path = join(dir, BOARD_STATE_FILE);
    let stop = false;
    let reads = 0;

    const reader = (async () => {
      while (!stop) {
        try {
          const raw = readFileSync(path, 'utf8');
          if (raw.trim()) {
            JSON.parse(raw);
            reads += 1;
          }
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
        await new Promise((resolve) => { setTimeout(resolve, 1); });
      }
    })();

    for (let index = 0; index < 30; index += 1) {
      await store.update((state) => ({
        ...state,
        dispatches: [...state.dispatches, { id: `dsp-${index}` }],
      }));
    }
    stop = true;
    await reader;

    assert.ok(reads > 0, '读的那一侧根本没读到东西，测试没有意义');
    assert.equal((await store.read()).dispatches.length, 30);
  } finally {
    cleanupDir(dir);
  }
});
