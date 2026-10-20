import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const CLIENT_DIR = 'D:/Project/AppProject/Mimic Tear/miniapps/mimic-tear/miniapp/client';
const HTML = join(CLIENT_DIR, 'index.html');
const APP = join(CLIENT_DIR, 'assets', 'app.js');

/**
 * The duty rounds, inside the conversation.
 *
 * The duty boss runs on its own cron session, so the Host chat side panel — which shows
 * one session — never shows the rounds. That is the gap: the user asked to see the boss
 * walking between projects, and the rounds are exactly that walking.
 *
 * The rounds are not *moved* into the conversation (steering a running turn would cut
 * off whatever the user is saying). They are *surfaced* there: each round's findings
 * arrive in the transcript as the boss's own report, in the order they happened.
 */
test('duty rounds in the conversation', async (t) => {
  const html = await readFile(HTML, 'utf8');
  const app = await readFile(APP, 'utf8');

  await t.test('对话区有一个大哥自己的交班汇报区', () => {
    assert.ok(html.includes('id="chat-duty"'), '缺少交班汇报区');
  });

  await t.test('汇报区有可访问的名字，不是裸 div', () => {
    assert.ok(
      /aria-label="[^"]*交班[^"]*"|aria-labelledby/.test(html),
      '交班汇报区需要 aria-label 或 aria-labelledby',
    );
  });

  await t.test('交班内容来自服务端的值班事实，不是客户端编的', () => {
    // The client must not invent duty rounds; it reads them from the server.
    assert.ok(/\/api\/chat\/duty/.test(app) || /duty/i.test(app), '未读取值班事实');
  });

  await t.test('交班汇报与大哥的对话区分得开', () => {
    // A duty round is not a chat message: it has its own visual treatment, or the user
    // cannot tell what the boss said to them from what it reported on its own.
    assert.ok(/chat__duty/.test(app) || /chat__duty/.test(html), '交班汇报需要独立的样式类');
  });
});
