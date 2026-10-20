import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createApp } from '../miniapps/mimic-tear/miniapp/node/server.mjs';
import { tmpDir, cleanupDir } from './helpers/fixture.mjs';

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
    async getProject(id) {
      if (id !== 1) return null;
      return { project: OVERVIEW.projects[0], orgTree: [], goals: [], questions: [], tasks: [], plan: null };
    },
    async getDispatch(id) {
      return id === 'd1' ? { id: 'd1', status: 'done' } : null;
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
