import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createApp } from '../miniapps/mimic-tear/miniapp/node/server.mjs';
import { API_ROUTES, ROUTES } from '../miniapps/mimic-tear/miniapp/node/api-routes.mjs';
import { CONTENT_SECURITY_POLICY, SECURITY_HEADERS } from '../miniapps/mimic-tear/miniapp/node/security.mjs';
import { tmpDir, cleanupDir } from './helpers/fixture.mjs';

/**
 * 安全响应头 + 路由表。
 *
 * 这两条是一起来的：响应头要**到处都在**（静态资源、JSON、SSE 都不能漏），
 * 路由表要**一条不缺**（表里有的路由都得真的能打到）。
 */

/** 一个把板面所有路由都喂饱的假服务。 */
function makeService() {
  return {
    async getOverview() {
      return { generatedAt: 1, kpi: { projects: 0 }, projects: [] };
    },
    async getInbox() {
      return { items: [] };
    },
    async getProjects() {
      return { projects: [] };
    },
    async getSkills() {
      return { groups: [], unmapped: [], total: 0, failures: 0 };
    },
    async getSkillLibrary() {
      return { entries: [], stats: { total: 0 } };
    },
    async getProject(id) {
      return id === 1 ? { project: { id: 1, name: 'alpha' } } : null;
    },
    async getDispatch(id) {
      return id === 'd1' ? { id: 'd1', status: 'done' } : null;
    },
    async prepareDispatch(body) {
      return { record: { id: 'd1', status: 'queued', instruction: body?.instruction ?? '' }, duplicate: false };
    },
    async runDispatch(record) {
      return { dispatchId: record.id, status: 'done', delivered: true, text: '已投递', error: null };
    },
    async ack(id) {
      return { ok: Boolean(id) };
    },
    patrol: {
      async list() {
        return [];
      },
    },
    async getPatrolConfig() {
      return { enabled: false, intervalMinutes: 45, lastRunAt: null };
    },
    async setPatrolConfig(config) {
      return { enabled: false, intervalMinutes: 45, lastRunAt: null, ...config };
    },
    async setDutyIntent(intent) {
      return { intent, duty: { resting: intent?.mode === 'resting' } };
    },
    async runPatrol() {
      return { runAt: 1, findings: [], error: null };
    },
    async getWatchdogAlerts() {
      return { alerts: [] };
    },
    async getDutyRounds() {
      return [];
    },
    async getChatHistory() {
      return [];
    },
    async getChatMessageCount() {
      return 0;
    },
    async chat(text, onEvent) {
      onEvent?.({ type: 'text.delta', text });
      return { status: 'finished', text, error: null, request: null };
    },
    async answerChatQuestion(input, onEvent) {
      onEvent?.({ type: 'text.delta', text: '收到' });
      return { status: 'finished', text: '收到', error: null, request: null };
    },
  };
}

async function startTestServer() {
  const clientDir = tmpDir('mimic-client-');
  mkdirSync(join(clientDir, 'assets'), { recursive: true });
  writeFileSync(join(clientDir, 'index.html'), '<!doctype html><html><body>仿身泪滴</body></html>', 'utf8');
  writeFileSync(join(clientDir, 'assets', 'app.js'), 'export const x = 1;', 'utf8');

  const service = makeService();
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
    async close() {
      for (const stream of app.streams) stream.end();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      cleanupDir(clientDir);
    },
  };
}

/**
 * 断言一个响应带着全套安全响应头。
 *
 * @param {Response} response
 * @param {string} [what] 出错时说明是哪个响应
 */
function assertSecurityHeaders(response, what = '响应') {
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff', `${what} 要带 nosniff`);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer', `${what} 要带 no-referrer`);
  assert.equal(response.headers.get('x-frame-options'), 'DENY', `${what} 要拒绝被套进 iframe`);

  const csp = response.headers.get('content-security-policy');
  assert.ok(csp, `${what} 要带 CSP`);
  assert.equal(csp, CONTENT_SECURITY_POLICY, `${what} 的 CSP 要和共用的一套一致`);
  assert.match(csp, /frame-ancestors 'none'/, `${what} 的 CSP 要禁掉 frame-ancestors`);

  // 一个远程来源都不许有：只允许自己和 loopback。
  const hosts = [...csp.matchAll(/https?:\/\/([^\s;]+)/g)].map((matched) => matched[1]);
  for (const host of hosts) {
    assert.ok(
      /^(127\.0\.0\.1|localhost)(:\*)?$/.test(host),
      `${what} 的 CSP 不该放开远程来源：${host}`,
    );
  }
}

const get = (port, path) => fetch(`http://127.0.0.1:${port}${path}`);
const post = (port, path, body) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });

test('安全响应头', async (t) => {
  await t.test('静态资源带着安全头', async () => {
    const server = await startTestServer();
    try {
      const page = await get(server.port, '/');
      assert.equal(page.status, 200);
      assertSecurityHeaders(page, '首页');

      const asset = await get(server.port, '/assets/app.js');
      assert.equal(asset.status, 200);
      assertSecurityHeaders(asset, '静态资源');

      // 资源不存在时也是 JSON 响应，同样要带安全头。
      const missing = await get(server.port, '/assets/nope.js');
      assert.equal(missing.status, 404);
      assertSecurityHeaders(missing, '缺失的静态资源');
    } finally {
      await server.close();
    }
  });

  await t.test('JSON 接口带着安全头', async () => {
    const server = await startTestServer();
    try {
      const overview = await get(server.port, '/api/overview');
      assert.equal(overview.status, 200);
      assertSecurityHeaders(overview, 'JSON 接口');

      const unknown = await get(server.port, '/api/nope');
      assert.equal(unknown.status, 404);
      assertSecurityHeaders(unknown, '404 JSON');
    } finally {
      await server.close();
    }
  });

  await t.test('SSE 带着安全头，但没被它弄坏', async () => {
    const server = await startTestServer();
    try {
      const controller = new AbortController();
      const response = await fetch(`http://127.0.0.1:${server.port}/api/stream`, {
        signal: controller.signal,
        headers: { accept: 'text/event-stream' },
      });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /text\/event-stream/);
      assertSecurityHeaders(response, 'SSE 响应');

      // 长连接不能被头挤成一段缓冲好的短响应：不许有 Content-Length。
      assert.equal(response.headers.get('content-length'), null, 'SSE 不许有 Content-Length');
      assert.notEqual(response.headers.get('connection'), 'close', 'SSE 不许主动关连接');

      const reader = response.body.getReader();
      const first = new TextDecoder().decode((await reader.read()).value);
      assert.match(first, /event: snapshot/, '连上先给一份快照');

      // 头没把流弄死：连接还在，后面的事件照样送得到。
      await post(server.port, '/api/dispatch', { projectId: 1, instruction: 'x' });
      let received = '';
      for (let i = 0; i < 5 && !received.includes('event: dispatch'); i += 1) {
        received += new TextDecoder().decode((await reader.read()).value);
      }
      assert.match(received, /event: dispatch/, 'SSE 通道必须还是活的');
      controller.abort();
    } finally {
      await server.close();
    }
  });

  await t.test('安全头只有一套，谁也改不动', async () => {
    assert.equal(SECURITY_HEADERS['x-content-type-options'], 'nosniff');
    assert.equal(SECURITY_HEADERS['referrer-policy'], 'no-referrer');
    assert.equal(SECURITY_HEADERS['x-frame-options'], 'DENY');
    assert.ok(Object.isFrozen(SECURITY_HEADERS), '共用的一套不许被改');
    assert.equal(Object.keys(SECURITY_HEADERS).length, 4);
  });
});

/**
 * 路由表里的每一条都要真的能打到。
 *
 * key 用路由表里的写法（`GET /api/projects/:id`），path 是真的请求路径。
 * 两边对不上就说明表里多了一条没人走过的路由，或者少了一条没人测的路由。
 */
const ROUTE_CASES = [
  { key: 'GET /', method: 'GET', path: '/' },
  { key: 'GET /index.html', method: 'GET', path: '/index.html' },
  { key: 'GET /assets/:file', method: 'GET', path: '/assets/app.js' },
  // SSE 那条是长连接：普通请求等它结束会等到天荒地老，单独测。
  { key: 'GET /api/stream', method: 'GET', path: '/api/stream', stream: true },
  { key: 'GET /api/overview', method: 'GET', path: '/api/overview' },
  { key: 'GET /api/inbox', method: 'GET', path: '/api/inbox' },
  { key: 'GET /api/projects', method: 'GET', path: '/api/projects' },
  { key: 'GET /api/skills', method: 'GET', path: '/api/skills' },
  { key: 'GET /api/skill-library', method: 'GET', path: '/api/skill-library' },
  { key: 'GET /api/projects/:id', method: 'GET', path: '/api/projects/1' },
  { key: 'GET /api/dispatch/:id', method: 'GET', path: '/api/dispatch/d1' },
  { key: 'POST /api/dispatch', method: 'POST', path: '/api/dispatch', body: { instruction: '干活' } },
  { key: 'POST /api/inbox/ack', method: 'POST', path: '/api/inbox/ack', body: { id: 'i1' } },
  { key: 'GET /api/patrol', method: 'GET', path: '/api/patrol' },
  { key: 'POST /api/patrol/config', method: 'POST', path: '/api/patrol/config', body: { enabled: false } },
  { key: 'POST /api/duty/intent', method: 'POST', path: '/api/duty/intent', body: { mode: 'on-duty' } },
  { key: 'POST /api/patrol/run', method: 'POST', path: '/api/patrol/run', body: {} },
  { key: 'GET /api/watchdog/alerts', method: 'GET', path: '/api/watchdog/alerts' },
  { key: 'GET /api/chat/duty', method: 'GET', path: '/api/chat/duty' },
  { key: 'GET /api/chat/history', method: 'GET', path: '/api/chat/history' },
  { key: 'GET /api/chat/session', method: 'GET', path: '/api/chat/session' },
  { key: 'POST /api/chat', method: 'POST', path: '/api/chat', body: { text: '各项目什么状态' } },
  { key: 'POST /api/chat/answer', method: 'POST', path: '/api/chat/answer', body: { requestId: 'req-1' } },
  { key: 'POST /api/permissions/:requestId', method: 'POST', path: '/api/permissions/req-1', body: { decision: 'allowOnce' } },
];

test('路由表', async (t) => {
  await t.test('API 路由一条都不能少', async () => {
    assert.equal(API_ROUTES.length, 21, '板面的 API 路由是 21 条，少一条就是少了一个契约');
    const apiKeys = API_ROUTES.map((route) => `${route.method} ${route.path}`).sort();
    const caseKeys = ROUTE_CASES
      .filter((item) => item.key.includes('/api/'))
      .map((item) => item.key)
      .sort();
    assert.deepEqual(caseKeys, apiKeys, '路由表和测试用例必须一一对应');
  });

  await t.test('静态路由也在表里', async () => {
    const staticKeys = ROUTES
      .filter((route) => route.kind === 'static')
      .map((route) => `${route.method} ${route.path}`)
      .sort();
    assert.deepEqual(staticKeys, ['GET /', 'GET /assets/:file', 'GET /index.html']);
  });

  await t.test('表里每条路由都真的能打到', async () => {
    const server = await startTestServer();
    try {
      for (const item of ROUTE_CASES) {
        if (item.stream) continue;
        const response = item.method === 'POST'
          ? await post(server.port, item.path, item.body)
          : await get(server.port, item.path);
        const payload = await response.text();
        assert.notEqual(
          payload,
          JSON.stringify({ error: 'not_found' }),
          `${item.key} 没被路由表接住，掉进了兜底的 404`,
        );
        assert.ok(response.status < 400, `${item.key} 不该报错，实际 ${response.status}`);
        assertSecurityHeaders(response, item.key);
      }
    } finally {
      await server.close();
    }
  });

  await t.test('SSE 那条路由也接得住', async () => {
    const server = await startTestServer();
    try {
      const controller = new AbortController();
      const response = await fetch(`http://127.0.0.1:${server.port}/api/stream`, {
        signal: controller.signal,
        headers: { accept: 'text/event-stream' },
      });
      assert.equal(response.status, 200);
      const reader = response.body.getReader();
      const chunk = new TextDecoder().decode((await reader.read()).value);
      assert.match(chunk, /event: snapshot/);
      controller.abort();
    } finally {
      await server.close();
    }
  });
});
