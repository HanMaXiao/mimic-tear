import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createApp } from '../miniapps/mimic-tear/miniapp/node/server.mjs';
import { PatrolStore } from '../miniapps/mimic-tear/miniapp/node/patrol-store.mjs';
import { ProjectService } from '../miniapps/mimic-tear/miniapp/node/project-service.mjs';
import { tmpDir, cleanupDir } from './helpers/fixture.mjs';

/**
 * A service with only what the duty routes need.
 *
 * The route is tested against the real service as well, because a route that forwards the
 * wrong field is still a route that answers 200.
 */
function makeService() {
  const dir = tmpDir();
  const patrol = new PatrolStore(dir);
  const service = new ProjectService({
    store: null,
    readPlan: async () => null,
    skills: { skills: [], failures: [] },
    domains: [],
    persistence: null,
    boss: null,
    patrol,
  });
  return { service, dir };
}

async function startTestServer(service) {
  const clientDir = tmpDir('mimic-client-');
  mkdirSync(join(clientDir, 'assets'), { recursive: true });
  writeFileSync(join(clientDir, 'index.html'), '<!doctype html><html><body>仿身泪滴</body></html>', 'utf8');
  writeFileSync(join(clientDir, 'assets', 'app.js'), 'export const x = 1;', 'utf8');

  const app = createApp({ service, clientDir });
  const server = createServer((request, response) => {
    void app.handler(request, response);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    port,
    async close() {
      for (const stream of app.streams) stream.end();
      await new Promise((resolve) => server.close(resolve));
      cleanupDir(clientDir);
    },
  };
}

const post = (port, path, body) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

test('值班意图的写入通道', async (t) => {
  await t.test('写意图的路由能把「歇着」记下来', async () => {
    const { service, dir } = makeService();
    const server = await startTestServer(service);
    try {
      const response = await post(server.port, '/api/duty/intent', {
        mode: 'resting',
        requestedBy: '大老板',
        note: '今天先歇着',
      });
      assert.equal(response.status, 200);

      const payload = await response.json();
      assert.equal(payload.intent.mode, 'resting');
      assert.equal(payload.intent.requestedBy, '大老板');
      assert.equal(payload.intent.note, '今天先歇着');
      assert.equal(payload.duty.resting, true);

      // 落盘的是文件，不是内存——下一个进程（大王的值班轮次）也要读得到。
      const onDisk = JSON.parse(readFileSync(join(dir, 'duty-intent.json'), 'utf8'));
      assert.equal(onDisk.mode, 'resting');
    } finally {
      await server.close();
      cleanupDir(dir);
    }
  });

  await t.test('回到在岗：意图要跟着改回来', async () => {
    const { service, dir } = makeService();
    const server = await startTestServer(service);
    try {
      await post(server.port, '/api/duty/intent', { mode: 'resting', requestedBy: '大老板' });
      const back = await post(server.port, '/api/duty/intent', { mode: 'on-duty', requestedBy: '大老板' });

      const payload = await back.json();
      assert.equal(payload.intent.mode, 'on-duty');
      assert.equal(payload.duty.resting, false);
      assert.equal(payload.duty.alertable, payload.duty.stale, '在岗时告警口径回到事实');
    } finally {
      await server.close();
      cleanupDir(dir);
    }
  });

  await t.test('没写 mode 的请求不能把大哥悄悄关掉', async () => {
    const { service, dir } = makeService();
    const server = await startTestServer(service);
    try {
      const response = await post(server.port, '/api/duty/intent', { note: '没说清楚' });
      const payload = await response.json();
      assert.equal(payload.intent.mode, 'on-duty', '说不清就不许当成歇着');
    } finally {
      await server.close();
      cleanupDir(dir);
    }
  });
});
