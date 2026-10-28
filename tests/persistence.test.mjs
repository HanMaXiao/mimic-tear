import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Persistence } from '../miniapps/mimic-tear/miniapp/node/persistence.mjs';

/**
 * The dispatch ledger's write discipline.
 *
 * `dispatches.json` has two writers in two processes — the board's dispatch path and the
 * duty path — and both do read-modify-write. The bug this file pins down: the write used
 * a FIXED temporary file name, so two writers could rename the file out from under each
 * other, and the surviving document could be a half-written JSON file that had been
 * renamed mid-flight. The reader then failed to parse it and — because the parse error
 * was swallowed and turned into "nothing there" — a dispatch record that existed on disk
 * silently read back as missing. That breaks the board's idempotency: the same key would
 * then be delivered twice.
 *
 * The board's own CI caught this: `GET /api/dispatch/:id` answered 404 for a dispatch the
 * board had just accepted.
 */

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'mimic-persistence-'));
}

function record(id, extra = {}) {
  return {
    id,
    idempotencyKey: `key-${id}`,
    projectId: 1,
    projectName: '示例项目',
    targetSessionId: null,
    instruction: `指令 ${id}`,
    status: 'queued',
    bossSessionId: null,
    text: '',
    error: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...extra,
  };
}

test('派工记录并发写入', async (t) => {
  await t.test('并发写不同记录：一条都不能丢，文件始终是合法 JSON', async () => {
    const dir = tempDir();
    try {
      const persistence = new Persistence(dir);
      const ids = Array.from({ length: 24 }, (_, index) => `dsp-${index}`);

      await Promise.all(ids.map((id) => persistence.saveDispatch(record(id))));

      const all = await persistence.listDispatches();
      assert.equal(all.length, ids.length, '并发写入后记录数对不上');
      for (const id of ids) {
        assert.ok(all.some((item) => item.id === id), `记录 ${id} 不见了`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test('并发写同一条记录：账上只能有一条，不是零条也不是多条', async () => {
    const dir = tempDir();
    try {
      const persistence = new Persistence(dir);
      const updates = ['queued', 'running', 'done'].map((status, index) =>
        persistence.saveDispatch(record('dsp-same', { status, updatedAt: 1_700_000_000_000 + index })));

      await Promise.all(updates);

      const all = await persistence.listDispatches();
      assert.equal(all.length, 1, `同一 id 只该有一条记录，实际 ${all.length} 条`);
      assert.equal(all[0].id, 'dsp-same');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test('写的同时有人在读：读到的永远是完整文档', async () => {
    // 这就是线上真实的形状：看板刚接下一次派工（后台投递在写账），页面同时在读这张账。
    // 修好之前，这一读会拿到半截 JSON，然后被当成「没有记录」。
    const dir = tempDir();
    try {
      const persistence = new Persistence(dir);
      const path = join(dir, 'dispatches.json');

      let stop = false;
      let reads = 0;
      const reader = (async () => {
        while (!stop) {
          try {
            const raw = readFileSync(path, 'utf8');
            if (raw.trim()) {
              // 读到一半的 JSON 会在这里炸——这正是修复前发生的事。
              JSON.parse(raw);
              reads += 1;
            }
          } catch (error) {
            if (error?.code !== 'ENOENT') {
              stop = true;
              throw error;
            }
          }
          await new Promise((resolve) => { setTimeout(resolve, 1); });
        }
      })();

      const writer = (async () => {
        for (let index = 0; index < 40; index += 1) {
          await persistence.saveDispatch(record(`dsp-live-${index}`, { status: 'running' }));
        }
      })();

      await writer;
      stop = true;
      await reader;

      const all = await persistence.listDispatches();
      assert.equal(all.length, 40, `写完之后账上应该有 40 条，实际 ${all.length} 条`);
      assert.ok(reads > 0, '读的那一侧根本没读到东西，测试没有意义');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test('账坏了要报错，不能当成「没有记录」', async () => {
    const dir = tempDir();
    try {
      const path = join(dir, 'dispatches.json');
      writeFileSync(path, '[{"id":"dsp-1",', 'utf8'); // 截断的 JSON

      const persistence = new Persistence(dir);
      await assert.rejects(
        () => persistence.listDispatches(),
        /不是合法 JSON|读不了|损坏/,
        '损坏的账必须报错——当成空账会让同一条指令被投递两次',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test('账坏了写入要报错，不许清空重来', async () => {
    const dir = tempDir();
    try {
      const path = join(dir, 'dispatches.json');
      writeFileSync(path, '[{"id":"dsp-1",', 'utf8'); // 截断的 JSON

      const persistence = new Persistence(dir);
      await assert.rejects(
        () => persistence.saveDispatch(record('dsp-2')),
        /不是合法 JSON|读不了|损坏/,
        '写进一份损坏的账就等于把读不出来的记录悄悄丢掉——幂等键就在里面，丢一条就会重投一次',
      );

      // 原来的内容必须还在，不能被覆盖。
      assert.equal(readFileSync(path, 'utf8'), '[{"id":"dsp-1",', '损坏的账被改写了');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('确认与排除记录', async (t) => {
  await t.test('同一条确认重复写入只有一条', async () => {
    const dir = tempDir();
    try {
      const persistence = new Persistence(dir);
      await Promise.all([
        persistence.addAck('session-error:mvs_1'),
        persistence.addAck('session-error:mvs_1'),
        persistence.addAck('session-error:mvs_2'),
      ]);
      const acks = await persistence.listAcks();
      assert.deepEqual([...acks].sort(), ['session-error:mvs_1', 'session-error:mvs_2']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test('排除记录的理由会被更新而不是堆叠', async () => {
    const dir = tempDir();
    try {
      const persistence = new Persistence(dir);
      await persistence.addDismissed('item-1', '第一次的理由');
      await persistence.addDismissed('item-1', '第二次的理由');
      const dismissed = await persistence.listDismissed();
      assert.equal(dismissed.length, 1);
      assert.equal(dismissed[0].reason, '第二次的理由');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('大哥会话', async (t) => {
  await t.test('读写往返', async () => {
    const dir = tempDir();
    try {
      const persistence = new Persistence(dir);
      assert.equal(await persistence.getBossSession(), null);
      await persistence.setBossSession({ sessionId: 'sess-1', agent: 'boss' });
      assert.deepEqual(await persistence.getBossSession(), { sessionId: 'sess-1', agent: 'boss' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test('早版本写的裸字符串仍然读得出来', async () => {
    const dir = tempDir();
    try {
      writeFileSync(join(dir, 'boss-session.json'), '"sess-old"', 'utf8');
      const persistence = new Persistence(dir);
      assert.deepEqual(await persistence.getBossSession(), { sessionId: 'sess-old', agent: 'boss' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
