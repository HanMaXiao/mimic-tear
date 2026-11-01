import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { createApp, createRuntimePoller, POLL_INTERVAL_MS } from '../miniapps/mimic-tear/miniapp/node/server.mjs';
import { RuntimeStore } from '../miniapps/mimic-tear/miniapp/node/runtime-store.mjs';
import { Persistence } from '../miniapps/mimic-tear/miniapp/node/persistence.mjs';
import { PatrolStore } from '../miniapps/mimic-tear/miniapp/node/patrol-store.mjs';
import { ProjectService } from '../miniapps/mimic-tear/miniapp/node/project-service.mjs';
import { tmpDir, cleanupDir, makeRuntimeDb } from './helpers/fixture.mjs';
import { readClientSource } from './helpers/client-source.mjs';

const CLIENT_DIR = fileURLToPath(new URL('../miniapps/mimic-tear/miniapp/client', import.meta.url));

const OVERVIEW = {
  generatedAt: 1,
  kpi: { projects: 2, active: 1, pendingDecisions: 1, errors: 0 },
  projects: [{ id: 1, name: 'alpha', health: 'active' }],
  attention: [],
};

function makeFakeService() {
  const dispatched = [];
  return {
    dispatched,
    async getOverview() {
      return OVERVIEW;
    },
    async getInbox() {
      return { items: [{ id: 'i1', kind: 'questionnaire', severity: 'high' }] };
    },
    async getProjects() {
      return { projects: OVERVIEW.projects };
    },
    async getSkills() {
      return { groups: [{ key: 'unreal', label: 'UE5', skills: [] }], unmapped: [], total: 0, failures: 0 };
    },
    getPendingAsks() {
      return { asks: [{ id: 'ask1', sessionId: 'mvs_1', createdAt: 1 }] };
    },
    async getSkillLibrary() {
      return {
        entries: [{ id: 'sl1', skillName: 'watchdog-verify', status: 'active', triggers: ['看门狗'] }],
        stats: { total: 1, active: 1, stale: 0, retired: 0, candidates: 0, domains: ['process'] },
        domains: ['process'],
        dispatchable: [{ id: 'sl1', skillName: 'watchdog-verify' }],
        stale: [],
        retired: [],
        updatedAt: 1,
      };
    },
    async getProject(id) {
      if (id !== 1) return null;
      return { project: OVERVIEW.projects[0], orgTree: [], goals: [], questions: [], tasks: [], plan: null };
    },
    async getDispatch(id) {
      return id === 'd1' ? { id: 'd1', status: 'done' } : null;
    },
    async getChatHistory() {
      return [
        { id: 'm1', role: 'user', text: '从宿主侧栏说的话', source: 'communication', createdAt: 1000 },
        { id: 'm2', role: 'assistant', text: '大哥在侧栏里的回复', source: 'communication', createdAt: 1100 },
      ];
    },
    async getChatMessageCount() {
      return 2;
    },
    async getDutyRounds() {
      return [{
        startedAt: 1792507304400,
        findings: [{ id: 'p1', severity: 'high', title: '一条交班结论', projectName: 'alpha', acknowledged: false, acknowledgedBy: null }],
        counts: { high: 1, medium: 0, low: 0 },
      }];
    },
    async prepareDispatch(body) {
      if (!body?.instruction) {
        const error = new Error('下达的指令不能为空');
        error.code = 'empty_instruction';
        error.status = 400;
        throw error;
      }
      const record = { id: 'd1', instruction: body.instruction, status: 'queued' };
      return { record, duplicate: false };
    },
    async runDispatch(record) {
      dispatched.push(record);
      return { dispatchId: record.id, status: 'done', delivered: true, text: '已投递', error: null };
    },
    async ack(id) {
      return { ok: Boolean(id) };
    },
    async runPatrol() {
      return {
        runAt: 1,
        conclusion: '巡检结论',
        dispatches: [],
        proposals: [],
        executed: [],
        findings: [],
        error: null,
      };
    },
    // 轮次是后台的：接口立刻返回句柄，结论随 SSE 送。这是真服务的新契约。
    async startPatrol() {
      const result = {
        runAt: 1,
        conclusion: '巡检结论',
        dispatches: [],
        proposals: [],
        executed: [],
        findings: [],
        error: null,
      };
      return {
        id: 'rnd_test',
        kind: 'patrol',
        slot: 'board-patrol',
        status: 'running',
        skipped: false,
        reason: null,
        promise: Promise.resolve({ status: 'finished', result, error: null }),
      };
    },
    stopRound(id) {
      return { stopped: true, reason: 'aborted', id, status: 'running' };
    },
    listRounds() {
      return [];
    },
    async chat(text, onEvent) {
      onEvent?.({ type: 'text.delta', text: '收到' });
      onEvent?.({ type: 'tool.started', name: 'bash' });
      return { bossSessionId: 'b1', status: 'finished', text: '收到', error: null, request: null };
    },
    async getDutyRounds() {
      return [{
        startedAt: 1792507304400,
        findings: [{ id: 'p1', severity: 'high', title: '一条交班结论', projectName: 'alpha', acknowledged: false, acknowledgedBy: null }],
        counts: { high: 1, medium: 0, low: 0 },
      }];
    },
  };
}

async function startTestServer() {
  const clientDir = tmpDir('mimic-client-');
  mkdirSync(join(clientDir, 'assets'), { recursive: true });
  writeFileSync(join(clientDir, 'index.html'), '<!doctype html><html><body>仿身泪滴</body></html>', 'utf8');
  writeFileSync(join(clientDir, 'assets', 'app.js'), 'export const x = 1;', 'utf8');

  const service = makeFakeService();
  const app = createApp({ service, clientDir });
  const server = createServer((request, response) => {
    void app.handler(request, response);
  });
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    service,
    app,
    port,
    clientDir,
    async close() {
      for (const stream of app.streams) stream.end();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      cleanupDir(clientDir);
    },
  };
}

const get = (port, path) => fetch(`http://127.0.0.1:${port}${path}`);
const post = (port, path, body) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

test('server', async (t) => {
  await t.test('首页与静态资源可访问', async () => {
    const server = await startTestServer();
    try {
      const page = await get(server.port, '/');
      assert.equal(page.status, 200);
      assert.match(page.headers.get('content-type'), /text\/html/);
      assert.match(await page.text(), /仿身泪滴/);

      const asset = await get(server.port, '/assets/app.js');
      assert.equal(asset.status, 200);
      assert.match(asset.headers.get('content-type'), /javascript/);
    } finally {
      await server.close();
    }
  });

  await t.test('目录穿越被拒绝', async () => {
    const server = await startTestServer();
    try {
      const response = await get(server.port, '/assets/../../package.json');
      assert.ok(response.status === 403 || response.status === 404, `实际状态 ${response.status}`);
    } finally {
      await server.close();
    }
  });

  await t.test('读接口返回结构化 JSON', async () => {
    const server = await startTestServer();
    try {
      const overview = await (await get(server.port, '/api/overview')).json();
      assert.equal(overview.kpi.projects, 2);

      const inbox = await (await get(server.port, '/api/inbox')).json();
      assert.equal(inbox.items.length, 1);

      const projects = await (await get(server.port, '/api/projects')).json();
      assert.equal(projects.projects.length, 1);

      const skills = await (await get(server.port, '/api/skills')).json();
      assert.equal(skills.groups[0].key, 'unreal');

      // The packaged-skill registry is a different read from the capability scan: it is
      // what the boss packaged, not what happens to be installed.
      const library = await (await get(server.port, '/api/skill-library')).json();
      assert.equal(library.stats.active, 1);
      assert.equal(library.entries[0].skillName, 'watchdog-verify');
      assert.equal(library.dispatchable.length, 1);

      const detail = await get(server.port, '/api/projects/1');
      assert.equal(detail.status, 200);

      const missing = await get(server.port, '/api/projects/999');
      assert.equal(missing.status, 404);
    } finally {
      await server.close();
    }
  });

  await t.test('派工：接受并返回 202，后台执行', async () => {
    const server = await startTestServer();
    try {
      const response = await post(server.port, '/api/dispatch', {
        projectId: 1, instruction: '把登录页做完备', idempotencyKey: 'k1',
      });
      assert.equal(response.status, 202);
      const body = await response.json();
      assert.equal(body.dispatchId, 'd1');
      assert.equal(body.status, 'queued');

      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(server.service.dispatched.length, 1);
      assert.equal(server.service.dispatched[0].instruction, '把登录页做完备');
    } finally {
      await server.close();
    }
  });

  await t.test('派工：空指令返回 400 与业务错误码', async () => {
    const server = await startTestServer();
    try {
      const response = await post(server.port, '/api/dispatch', { projectId: 1, instruction: '' });
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.error, 'empty_instruction');
    } finally {
      await server.close();
    }
  });

  await t.test('ack 接口返回 ok', async () => {
    const server = await startTestServer();
    try {
      const response = await post(server.port, '/api/inbox/ack', { id: 'i1' });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true });
    } finally {
      await server.close();
    }
  });

  await t.test('未知路径返回 404 JSON', async () => {
    const server = await startTestServer();
    try {
      const response = await get(server.port, '/api/nope');
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: 'not_found' });
    } finally {
      await server.close();
    }
  });

  await t.test('SSE：连接后先收到 snapshot 事件', async () => {
    const server = await startTestServer();
    try {
      const controller = new AbortController();
      const response = await fetch(`http://127.0.0.1:${server.port}/api/stream`, {
        signal: controller.signal,
        headers: { accept: 'text/event-stream' },
      });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /text\/event-stream/);

      const reader = response.body.getReader();
      const { value } = await reader.read();
      const text = new TextDecoder().decode(value);
      assert.match(text, /event: snapshot/);
      assert.match(text, /"projects":2/);
      controller.abort();
    } finally {
      await server.close();
    }
  });

  await t.test('SSE：派工完成后广播 dispatch 事件', async () => {
    const server = await startTestServer();
    try {
      const controller = new AbortController();
      const response = await fetch(`http://127.0.0.1:${server.port}/api/stream`, {
        signal: controller.signal,
        headers: { accept: 'text/event-stream' },
      });
      const reader = response.body.getReader();

      await post(server.port, '/api/dispatch', { projectId: 1, instruction: 'x', idempotencyKey: 'k2' });

      let received = '';
      for (let i = 0; i < 5 && !received.includes('event: dispatch'); i += 1) {
        const { value } = await reader.read();
        received += new TextDecoder().decode(value);
      }
      assert.match(received, /event: dispatch/);
      assert.match(received, /"delivered":true/);
      controller.abort();
    } finally {
      await server.close();
    }
  });

  await t.test('SSE：巡检跑完必须广播 patrol 事件（广播静默失效过一次）', async () => {
    const server = await startTestServer();
    try {
      const controller = new AbortController();
      const response = await fetch(`http://127.0.0.1:${server.port}/api/stream`, {
        signal: controller.signal,
        headers: { accept: 'text/event-stream' },
      });
      const reader = response.body.getReader();

      await post(server.port, '/api/patrol/run', {});

      let received = '';
      for (let i = 0; i < 5 && !received.includes('event: patrol'); i += 1) {
        const { value } = await reader.read();
        received += new TextDecoder().decode(value);
      }
      // 这条事件以前是静默失效的：createApp 的作用域里没有 app，广播抛的是
      // "app is not defined"，页面会永远卡在"巡检中…"。
      assert.match(received, /event: patrol/, '巡检跑完必须广播，否则页面永远等不到结果');
      controller.abort();
    } finally {
      await server.close();
    }
  });

  await t.test('值班交班汇报：接口能拿到轮次', async () => {
    const server = await startTestServer();
    try {
      const response = await get(server.port, '/api/chat/duty');
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.ok(Array.isArray(payload.rounds), '要返回轮次数组');
      assert.equal(payload.rounds.length, 1);
      assert.equal(payload.rounds[0].findings[0].title, '一条交班结论');
    } finally {
      await server.close();
    }
  });

  await t.test('会话历史接口：侧栏里说的话要能读出来', async () => {
    const server = await startTestServer();
    try {
      const response = await get(server.port, '/api/chat/history');
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.ok(Array.isArray(payload.messages), '要返回消息数组');
      assert.equal(payload.messages.length, 2);
      // The source tells the page which view a line came from.
      assert.equal(payload.messages[0].source, 'communication');
      assert.equal(payload.messages[0].text, '从宿主侧栏说的话');
    } finally {
      await server.close();
    }
  });

  await t.test('值班交班汇报：接口能拿到轮次', async () => {
    const server = await startTestServer();
    try {
      const response = await get(server.port, '/api/chat/duty');
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.ok(Array.isArray(payload.rounds), '要返回轮次数组');
    } finally {
      await server.close();
    }
  });

  await t.test('SSE：对话的流式事件与结束事件都要广播', async () => {
    const server = await startTestServer();
    try {
      const controller = new AbortController();
      const response = await fetch(`http://127.0.0.1:${server.port}/api/stream`, {
        signal: controller.signal,
        headers: { accept: 'text/event-stream' },
      });
      const reader = response.body.getReader();

      await post(server.port, '/api/chat', { text: '各项目什么状态' });

      let received = '';
      for (let i = 0; i < 8 && !received.includes('event: chat.done'); i += 1) {
        const { value } = await reader.read();
        received += new TextDecoder().decode(value);
      }
      assert.match(received, /event: chat\.delta/, '回复要一个字一个字地流出来');
      assert.match(received, /event: chat\.tool/, '大哥在用什么工具要看得见');
      assert.match(received, /event: chat\.done/, '这轮结束必须广播，否则界面一直转');
      controller.abort();
    } finally {
      await server.close();
    }
  });

  await t.test('权限请求：页面可以批准，大哥收到 allowOnce', async () => {
    const server = await startTestServer();
    try {
      const decision = server.app.requestPermission({
        requestId: 'req-1', sessionId: 'boss-1', toolName: 'bash', reason: '需要执行',
      });
      const response = await post(server.port, '/api/permissions/req-1', { decision: 'allowOnce' });
      assert.equal(response.status, 200);
      assert.equal(await decision, 'allowOnce');
    } finally {
      await server.close();
    }
  });

  await t.test('权限请求：未知 requestId 不会挂起', async () => {
    const server = await startTestServer();
    try {
      const response = await post(server.port, '/api/permissions/unknown', { decision: 'allowOnce' });
      assert.equal(response.status, 200);
    } finally {
      await server.close();
    }
  });
});

/**
 * 轮询那一路。
 *
 * 会话消息数是一次 COUNT，在几百 MB 的运行时库上不便宜，所以要先问一句更便宜的：
 * 运行时库有没有被写过（`PRAGMA data_version`）。没人写过，对话就不可能变，
 * 那次 COUNT 就省掉了；有人写过才去数。
 *
 * 但省钱的代价不能是「侧栏里说的话不实时了」——那是产品硬要求。
 */
const POLL_SESSION = 'sess-alpha-lead';

/**
 * 一个只看得到会话消息数的假服务。
 *
 * 读的是真的运行时库（真的 RuntimeStore、真的 SQLite 文件），只有「版本号永远不变」
 * 是假的——这正是要测的那种情形：宿主侧栏里说的话不会推动运行时版本号。
 */
function makePollService(store, counter) {
  return {
    currentRevision() {
      return 'rev-constant';
    },
    async getChatMessageCount() {
      counter.counts += 1;
      return store.countSessionMessages(POLL_SESSION);
    },
    async getChatHistory() {
      return store.listSessionMessages(POLL_SESSION);
    },
    async getOverview() {
      return { generatedAt: 1 };
    },
  };
}

/**
 * 模拟宿主侧栏里说了一句话：另一个连接往运行时库里写一行消息。
 *
 * @param {string} dbPath
 * @param {string} text
 */
function writeSidePanelMessage(dbPath, text) {
  const writer = new DatabaseSync(dbPath);
  try {
    writer.prepare(
      `INSERT INTO local_runtime_message_rows
         (session_id, msg_id, role, turn_id, created_at_ms, data_json, source)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      POLL_SESSION,
      `m-${Date.now()}`,
      'user',
      'turn-side-panel',
      Date.now(),
      JSON.stringify({ msg_content: text }),
      'communication',
    );
  } finally {
    writer.close();
  }
}

/**
 * 等一个条件成立。
 *
 * @param {() => boolean} predicate
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

test('运行时轮询', async (t) => {
  await t.test('版本号没动、库也没被写：不去数会话消息', async () => {
    const dir = tmpDir('mimic-poll-');
    const dbPath = makeRuntimeDb(dir);
    const store = RuntimeStore.open(dbPath);
    const counter = { counts: 0 };
    const events = [];
    try {
      const poller = createRuntimePoller({
        service: makePollService(store, counter),
        store,
        broadcast: (event, data) => events.push({ event, data }),
      });

      // 第一次检查要和以前一样：先对齐基准，照旧数一次。
      await poller.tick();
      assert.equal(counter.counts, 1, '第一次照旧数一次');
      assert.equal(events.filter((item) => item.event === 'chat.history').length, 1,
        '第一次要把已有的会话推给页面');

      // 库没被动过：对话不可能变，那次 COUNT 省掉。
      await poller.tick();
      await poller.tick();
      await poller.tick();
      assert.equal(counter.counts, 1, '库没被写就不该反复数消息');
      assert.equal(events.filter((item) => item.event === 'chat.history').length, 1,
        '没有新消息就不该重复推会话');
    } finally {
      store.close();
      cleanupDir(dir);
    }
  });

  await t.test('库被写过：才去数会话消息', async () => {
    const dir = tmpDir('mimic-poll-');
    const dbPath = makeRuntimeDb(dir);
    const store = RuntimeStore.open(dbPath);
    const counter = { counts: 0 };
    const events = [];
    try {
      const poller = createRuntimePoller({
        service: makePollService(store, counter),
        store,
        broadcast: (event, data) => events.push({ event, data }),
      });

      await poller.tick();
      assert.equal(counter.counts, 1);

      // 有人往库里写了一行（哪怕写的是别的表）：数据版本号会变，于是值得去数一次。
      const writer = new DatabaseSync(dbPath);
      writer.prepare('UPDATE local_runtime_sessions SET updated_at_ms = updated_at_ms + 1 WHERE session_id = ?')
        .run(POLL_SESSION);
      writer.close();

      await poller.tick();
      assert.equal(counter.counts, 2, '库被写过就要去数一次消息');
      assert.equal(events.filter((item) => item.event === 'chat.history').length, 1,
        '消息数没变就不该重复推会话');
    } finally {
      store.close();
      cleanupDir(dir);
    }
  });

  await t.test('宿主侧栏里说的话：3 秒窗口内必须冒出来', async () => {
    const dir = tmpDir('mimic-poll-');
    const dbPath = makeRuntimeDb(dir);
    const store = RuntimeStore.open(dbPath);
    const counter = { counts: 0 };
    const events = [];
    let poller = null;
    try {
      poller = createRuntimePoller({
        service: makePollService(store, counter),
        store,
        broadcast: (event, data) => events.push({ event, data }),
      });

      // 先对齐基准，再上真正的定时器。
      await poller.tick();
      poller.start();

      const before = events.filter((item) => item.event === 'chat.history').length;
      const saidAt = Date.now();
      writeSidePanelMessage(dbPath, '从宿主侧栏说的话');

      const arrived = await waitFor(
        () => events.filter((item) => item.event === 'chat.history').length > before,
        POLL_INTERVAL_MS + 1000,
      );
      const elapsed = Date.now() - saidAt;

      assert.ok(arrived, '侧栏里说的话必须在轮询窗口内推给页面');
      assert.ok(
        elapsed <= POLL_INTERVAL_MS + 1000,
        `侧栏消息 ${elapsed}ms 才冒出来，超出了一个轮询周期（${POLL_INTERVAL_MS}ms）`,
      );

      const pushed = events.filter((item) => item.event === 'chat.history').at(-1);
      assert.match(pushed.data.messages.at(-1).text, /从宿主侧栏说的话/,
        '推给页面的必须是刚才那句');
    } finally {
      poller?.stop();
      store.close();
      cleanupDir(dir);
    }
  });

  await t.test('拿不到数据版本号时，宁可多查一次也不能漏', async () => {
    const dir = tmpDir('mimic-poll-');
    const dbPath = makeRuntimeDb(dir);
    const store = RuntimeStore.open(dbPath);
    const counter = { counts: 0 };
    try {
      const poller = createRuntimePoller({
        service: makePollService(store, counter),
        // 假装拿不到版本号（库没打开）。
        store: { dataVersion: () => null },
        broadcast: () => {},
      });

      await poller.tick();
      await poller.tick();
      await poller.tick();
      assert.equal(counter.counts, 3, '没有版本号可依赖时就退回每次都数');
    } finally {
      store.close();
      cleanupDir(dir);
    }
  });
});

/* --------------------------------------------------------- 响应字段契约 */

/**
 * 高风险端点的字段契约。
 *
 * 服务端改了字段名，页面不会报错——`overview.kpi` 变成 `overview.metrics`，KPI 那一块
 * 就不动了，页面上什么错都没有，看板上只是一片空白。所以这里对着**真的**领域服务打
 * 一遍接口，逐个字段核对客户端还在读的那些名字。
 *
 * - `fields`：服务端返回的 JSON 里必须有的字段（点号路径）。改名了就是契约破了。
 * - `items`：要逐项核对的数组在返回值的哪个位置（`null` 表示返回值本身就是那一项）。
 * - `itemFields`：数组里第一项必须有的字段。
 * - `clientFields`：客户端源码里必须还在读的名字。客户端改了读法，这里会响。
 */
const PAYLOAD_CONTRACT = [
  {
    endpoint: 'GET /api/overview',
    path: '/api/overview',
    fields: [
      'generatedAt', 'kpi', 'kpi.projects', 'kpi.active', 'kpi.pendingDecisions', 'kpi.errors',
      'projects', 'attention', 'internalProjectCount', 'dataWarning', 'duty',
    ],
    clientFields: ['kpi', 'projects', 'attention', 'internalProjectCount', 'dataWarning', 'duty'],
  },
  {
    endpoint: 'GET /api/inbox',
    path: '/api/inbox',
    fields: ['items'],
    items: 'items',
    itemFields: [
      'id', 'kind', 'severity', 'projectId', 'projectName', 'sessionId', 'sessionTitle',
      'title', 'body', 'createdAt', 'ageMinutes', 'acknowledged', 'handledBy', 'handledReason',
    ],
    itemKind: 'questionnaire',
    kindFields: ['requestId', 'stepIds', 'options', 'recommendation'],
    clientFields: [
      'items', 'id', 'kind', 'severity', 'projectId', 'projectName', 'sessionId', 'body',
      'acknowledged', 'handledBy', 'handledReason', 'recommendation',
    ],
  },
  {
    endpoint: 'GET /api/projects',
    path: '/api/projects',
    fields: ['projects'],
    items: 'projects',
    itemFields: [
      'id', 'name', 'path', 'health', 'sessionCount', 'pendingQuestions', 'lastActivityAt',
      'activeSessions', 'erroredSessions', 'goals', 'planTasks', 'planUpdatedAt',
    ],
    clientFields: [
      'projects', 'id', 'name', 'path', 'health', 'sessionCount', 'pendingQuestions',
      'lastActivityAt', 'goals',
    ],
  },
  {
    endpoint: 'GET /api/projects/:id',
    path: '/api/projects/1',
    fields: ['project', 'orgTree', 'goals', 'questions', 'tasks', 'plan', 'duty'],
    items: null,
    itemFields: [
      'project.id', 'project.name', 'project.path', 'project.health', 'project.sessionCount',
      'project.pendingQuestions', 'project.erroredSessions', 'project.planUpdatedAt',
    ],
    clientFields: ['project', 'orgTree', 'goals', 'questions', 'plan'],
  },
  {
    endpoint: 'GET /api/skills',
    path: '/api/skills',
    fields: ['groups', 'unmapped', 'total', 'failures'],
    clientFields: ['groups', 'unmapped', 'total', 'failures', 'key', 'label'],
  },
  {
    endpoint: 'GET /api/skill-library',
    path: '/api/skill-library',
    fields: [
      'entries', 'stats', 'stats.total', 'stats.active', 'stats.stale', 'stats.retired',
      'stats.candidates', 'domains', 'dispatchable', 'stale', 'retired', 'updatedAt',
    ],
    clientFields: ['entries', 'stats', 'skillName', 'status', 'domain', 'triggers'],
  },
  {
    // The durable source behind the "等回答" mark. Its list can legitimately be empty,
    // so only the container's shape is pinned here.
    endpoint: 'GET /api/sessions/pending-asks',
    path: '/api/sessions/pending-asks',
    fields: ['asks'],
    clientFields: ['asks', 'sessionId'],
  },
  {
    endpoint: 'GET /api/watchdog/alerts',
    path: '/api/watchdog/alerts',
    fields: ['alerts'],
    items: 'alerts',
    itemFields: ['at', 'action', 'title', 'body', 'delivered', 'error', 'note'],
    clientFields: ['alerts', 'action', 'at', 'title', 'body', 'delivered', 'error', 'note'],
  },
  {
    endpoint: 'GET /api/chat/duty',
    path: '/api/chat/duty',
    fields: ['rounds'],
    clientFields: ['rounds'],
  },
  {
    endpoint: 'GET /api/chat/history',
    path: '/api/chat/history',
    fields: ['messages'],
    items: 'messages',
    itemFields: ['id', 'role', 'text', 'source', 'createdAt'],
    clientFields: ['messages', 'role', 'text', 'source'],
  },
  {
    endpoint: 'GET /api/chat/session',
    path: '/api/chat/session',
    fields: ['bossSessionId', 'agent'],
    clientFields: ['bossSessionId'],
  },
  {
    endpoint: 'GET /api/patrol',
    path: '/api/patrol',
    fields: ['config', 'findings', 'config.enabled', 'config.intervalMinutes'],
    clientFields: ['config', 'findings', 'enabled'],
  },
  {
    endpoint: 'POST /api/dispatch',
    path: '/api/dispatch',
    method: 'POST',
    body: { projectId: 1, instruction: '把登录页做完备', idempotencyKey: 'k-contract-1' },
    fields: ['dispatchId', 'status', 'duplicate'],
    clientFields: ['dispatchId', 'status'],
  },
  {
    endpoint: 'GET /api/dispatch/:id',
    // 记录是服务端自己写的：这里先真的派一次工，再把记录读回来核对。
    path: '/api/dispatch/dsp-contract-1',
    prepare: async (port) => {
      const response = await post(port, '/api/dispatch', {
        projectId: 1, instruction: '把登录页做完备', idempotencyKey: 'k-contract-2',
      });
      const payload = await response.json();
      const path = `/api/dispatch/${payload.dispatchId}`;
      // 后台投递是异步的：等它真的落定再读记录，读到的才是最终的形状。
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const record = await (await get(port, path)).json();
        if (record.status === 'done' || record.status === 'error') break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return path;
    },
    fields: ['id', 'status', 'text', 'error', 'projectId', 'instruction'],
    items: null,
    itemFields: ['id', 'status', 'text', 'error'],
    clientFields: ['id', 'status', 'text', 'error'],
  },
];

/**
 * 一个真的服务端：真的领域服务、真的运行时库、真的 HTTP 栈。
 *
 * 字段契约必须对着**真的**返回值核对：用假的 service 的话，返回什么由测试自己说了算，
 * 改了字段名测试还是绿的——那等于没测。
 *
 * @returns {Promise<{ port: number, close: () => Promise<void> }>}
 */
async function startContractServer() {
  const dir = tmpDir('mimic-contract-');
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });

  const dbPath = makeRuntimeDb(dir);
  const store = RuntimeStore.open(dbPath);
  const persistence = new Persistence(dataDir);
  const patrol = new PatrolStore(dataDir);

  // 大哥的会话：对话记录那条路要真有东西可读。
  await persistence.setBossSession({ sessionId: 'sess-alpha-lead', agent: 'boss' });
  // 一条看门狗告警：告警流水那条路要真有东西可读。
  writeFileSync(
    join(dataDir, 'watchdog-alert.log'),
    `${JSON.stringify({
      at: 1_700_000_000_000,
      action: 'stale',
      title: '仿身泪滴 · 大哥掉线',
      body: '已 35 分钟没有交班',
      delivered: true,
      error: null,
      note: null,
      gapTo: null,
    })}\n`,
    'utf8',
  );

  const service = new ProjectService({
    store,
    readPlan: async () => null,
    skills: { skills: [], failures: [] },
    domains: [],
    persistence,
    patrol,
    boss: {
      async dispatch() {
        return {
          bossSessionId: 'sess-alpha-lead',
          status: 'finished',
          text: '已投递',
          error: null,
          delivered: true,
        };
      },
      async patrol() {
        return {
          bossSessionId: 'sess-alpha-lead',
          status: 'finished',
          text: '巡检结论',
          error: null,
        };
      },
    },
  });

  const app = createApp({ service, clientDir: CLIENT_DIR, persistence });
  const server = createServer((request, response) => {
    void app.handler(request, response);
  });
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    port,
    async close() {
      for (const stream of app.streams) stream.end();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      store.close();
      cleanupDir(dir);
    },
  };
}

/**
 * 返回值里有没有这个字段（点号路径）。
 *
 * @param {any} value
 * @param {string} path
 * @returns {boolean}
 */
function hasField(value, path) {
  let cursor = value;
  for (const part of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return false;
    if (!Object.hasOwn(cursor, part)) return false;
    cursor = cursor[part];
  }
  return true;
}

/**
 * 客户端还在读这个字段吗？
 *
 * 按名字找的，所以它的粒度是「这个字段名在客户端里还出现过」：客户端整体改了这个
 * 字段名会响，但只改了一处、另一处还留着旧名字时不会响。真正兜住「改名」的是服务端
 * 那一半——服务端改了字段名，返回值里就没有它了，测试立刻响。
 *
 * @param {string} source 客户端全部模块的源码
 * @param {string} field 字段名
 * @returns {boolean}
 */
function clientReadsField(source, field) {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\??\\.${escaped}\\b`).test(source);
}

test('响应字段契约：服务端返回的字段名要和客户端读的一致', async (t) => {
  const clientSource = await readClientSource(CLIENT_DIR);
  const server = await startContractServer();
  try {
    for (const entry of PAYLOAD_CONTRACT) {
      await t.test(entry.endpoint, async () => {
        const path = entry.prepare ? await entry.prepare(server.port) : entry.path;
        const response = entry.method === 'POST'
          ? await post(server.port, path, entry.body ?? {})
          : await get(server.port, path);
        assert.equal(
          response.status,
          entry.method === 'POST' ? 202 : 200,
          `${entry.endpoint} 返回了 ${response.status}`,
        );
        const payload = await response.json();

        for (const field of entry.fields ?? []) {
          assert.ok(
            hasField(payload, field),
            `${entry.endpoint} 的返回值里没有 ${field} 字段——客户端读不到它，页面会静悄悄地空掉`,
          );
        }

        if (entry.itemFields) {
          const items = entry.items === null ? [payload] : (payload[entry.items] ?? []);
          assert.ok(items.length > 0, `${entry.endpoint} 没有可核对的条目，字段契约没被验证`);
          for (const field of entry.itemFields) {
            assert.ok(
              hasField(items[0], field),
              `${entry.endpoint} 的条目里没有 ${field} 字段——客户端读不到它`,
            );
          }
        }

        if (entry.kindFields) {
          const items = payload[entry.items] ?? [];
          const item = items.find((candidate) => candidate.kind === entry.itemKind);
          assert.ok(item, `${entry.endpoint} 里没有一条 ${entry.itemKind} 条目，字段契约没被验证`);
          for (const field of entry.kindFields) {
            assert.ok(
              hasField(item, field),
              `${entry.endpoint} 的 ${entry.itemKind} 条目里没有 ${field} 字段——客户端读不到它`,
            );
          }
        }

        for (const field of entry.clientFields ?? []) {
          assert.ok(
            clientReadsField(clientSource, field),
            `客户端不再读 ${field} 字段了（${entry.endpoint}）——要么改契约，要么改回客户端`,
          );
        }
      });
    }
  } finally {
    await server.close();
  }
});
