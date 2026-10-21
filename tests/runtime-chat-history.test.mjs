import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { RuntimeStore } from '../miniapps/mimic-tear/miniapp/node/runtime-store.mjs';
import { makeRuntimeDb, tmpDir, cleanupDir } from './helpers/fixture.mjs';

/**
 * Reading the conversation back.
 *
 * The Mini App's transcript lives in the runtime database, not in the Mini App. That is
 * what makes the Host chat side panel and the Mini App two views of one thread — and it is
 * also what lets the Mini App pick up what was said in the side panel.
 */
test('runtime store: conversation history', async (t) => {
  await t.test('读取指定会话的消息，按时间正序', () => {
    const dir = tmpDir();
    try {
      const store = RuntimeStore.open(makeRuntimeDb(dir));
      try {
        const messages = store.listSessionMessages('sess-alpha-lead');
        assert.equal(messages.length, 3);
        assert.equal(messages[0].text, '从 Mini App 说的话');
        assert.equal(messages[1].text, '大哥的回复');
        assert.equal(messages[2].text, '从宿主侧栏说的话');
        // Oldest first — the page renders them top to bottom.
        assert.ok(messages[0].createdAt <= messages[2].createdAt);
      } finally {
        store.close();
      }
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('每条消息带上来源：miniapp 还是宿主侧栏', () => {
    const dir = tmpDir();
    try {
      const store = RuntimeStore.open(makeRuntimeDb(dir));
      try {
        const messages = store.listSessionMessages('sess-alpha-lead');
        assert.equal(messages[0].source, 'miniapp');
        assert.equal(messages[2].source, 'communication');
      } finally {
        store.close();
      }
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('不存在的会话返回空数组，不抛错', () => {
    const dir = tmpDir();
    try {
      const store = RuntimeStore.open(makeRuntimeDb(dir));
      try {
        assert.deepEqual(store.listSessionMessages('never-existed'), []);
        assert.deepEqual(store.listSessionMessages(''), []);
        assert.deepEqual(store.listSessionMessages(null), []);
      } finally {
        store.close();
      }
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('会话消息条数可作为变更检测器', () => {
    const dir = tmpDir();
    try {
      const store = RuntimeStore.open(makeRuntimeDb(dir));
      try {
        assert.equal(store.countSessionMessages('sess-alpha-lead'), 3);
        // An unknown session is zero, not an error.
        assert.equal(store.countSessionMessages('never-existed'), 0);
        assert.equal(store.countSessionMessages(''), 0);
      } finally {
        store.close();
      }
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('坏 JSON 的消息不拖垮整条记录', () => {
    const dir = tmpDir();
    try {
      const dbPath = makeRuntimeDb(dir);
      const store = RuntimeStore.open(dbPath);
      try {
        // Corrupt one message's payload the way a half-written row would.
        const db = new DatabaseSync(dbPath);
        db.prepare("UPDATE local_runtime_message_rows SET data_json = ? WHERE msg_id = ?")
          .run('{ broken', 'm-2');
        db.close();

        const messages = store.listSessionMessages('sess-alpha-lead');
        assert.equal(messages.length, 3, '坏消息不该让整条记录消失');
        assert.equal(messages[1].text, '', '坏消息的正文变成空字符串');
        assert.equal(messages[2].text, '从宿主侧栏说的话', '后面的消息照样读得到');
      } finally {
        store.close();
      }
    } finally {
      cleanupDir(dir);
    }
  });
});
