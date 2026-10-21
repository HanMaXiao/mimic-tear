import test from 'node:test';
import assert from 'node:assert/strict';

import { chatHistoryChanged } from '../miniapps/mimic-tear/miniapp/node/chat-history.mjs';

/**
 * The change detector for the conversation.
 *
 * A line said in the Host chat side panel does not move the runtime revision, so without a
 * separate detector the Mini App would never learn about it and the two views would
 * disagree about what was said.
 */
test('chat history change detection', async (t) => {
  await t.test('消息数变了就是变了', () => {
    assert.equal(chatHistoryChanged(3, 2).changed, true);
    assert.equal(chatHistoryChanged(2, 3).changed, true);
  });

  await t.test('消息数没变就是没变', () => {
    assert.equal(chatHistoryChanged(2, 2).changed, false);
  });

  await t.test('会话被换掉时（消息数变少）也算变了', () => {
    // The page would otherwise keep showing a transcript that no longer exists.
    assert.equal(chatHistoryChanged(0, 5).changed, true);
  });

  await t.test('坏输入按 0 处理，不炸', () => {
    assert.equal(chatHistoryChanged(undefined, undefined).changed, false);
    assert.equal(chatHistoryChanged(1, undefined).changed, true);
    assert.equal(chatHistoryChanged(null, 0).changed, false);
  });
});
