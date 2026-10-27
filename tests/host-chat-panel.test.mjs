import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLIENT_DIR = fileURLToPath(new URL('../miniapps/mimic-tear/miniapp/client', import.meta.url));
const HTML = join(CLIENT_DIR, 'index.html');
const APP = join(CLIENT_DIR, 'assets', 'app.js');

/**
 * The Host chat side panel.
 *
 * MiniMax Code already renders an agent conversation well: streaming text, tool chips,
 * permission prompts, questionnaires, the lot. A Mini App that re-implements all of that
 * is a worse copy of something that already exists. The Host exposes `agent.open(sessionId)`
 * for exactly this — it shows one of the plugin's own sessions in the Host's chat side panel,
 * so the user talks to the boss in the real thing.
 *
 * These tests pin the contract: the client calls the Host API when asked, and it never
 * pretends the panel opened when the Host refused.
 */
test('host-chat-side-panel', async (t) => {
  const html = await readFile(HTML, 'utf8');
  const app = await readFile(APP, 'utf8');

  await t.test('界面上有「在宿主侧栏打开」的入口', () => {
    assert.ok(html.includes('id="chat-open-host"'), '缺少打开宿主侧栏的按钮');
    assert.ok(/aria-label="[^"]*侧栏[^"]*"/.test(html), '按钮需要 aria-label 说明它打开侧栏');
  });

  await t.test('客户端调用 Host 的 agent.open，不是自己造轮子', () => {
    assert.ok(app.includes('agent.open'), '未调用 Host 的 agent.open');
    assert.ok(app.includes('window.mcode?.miniapp?.agent'), '未通过 window.mcode.miniapp.agent 访问');
  });

  await t.test('open 用的是大哥自己的会话 id', () => {
    // The id must come from the server (the boss session), never be invented client-side.
    assert.ok(/sessionId/.test(app), '未使用 sessionId');
    assert.ok(/API\.chat\b/.test(app) || /\/api\/chat/.test(app), '会话 id 应来自对话接口');
  });

  await t.test('Host 不支持时优雅降级，不报错', () => {
    // A Mini App can be opened outside a chat session; then there is no side panel to open.
    assert.ok(/mcode\?\.miniapp\?\.agent/.test(app), '缺少能力探测');
    assert.ok(/open\s*\(/.test(app), '未调用 open');
  });

  await t.test('失败必须有可见反馈，不能静默', () => {
    // "Nothing happened" is the worst outcome: the user clicks and cannot tell whether
    // the panel opened, was refused, or never existed.
    assert.ok(/toast\(/.test(app), '失败路径应通过 toast 给出反馈');
  });
});
