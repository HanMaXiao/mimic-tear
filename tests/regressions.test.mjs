import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { BossBridge } from '../miniapps/mimic-tear/miniapp/node/boss-bridge.mjs';
import { ProjectService } from '../miniapps/mimic-tear/miniapp/node/project-service.mjs';
import { PatrolStore } from '../miniapps/mimic-tear/miniapp/node/patrol-store.mjs';
import { RuntimeStore } from '../miniapps/mimic-tear/miniapp/node/runtime-store.mjs';
import { buildOrgTree, buildProjectCards } from '../miniapps/mimic-tear/miniapp/node/view-model.mjs';
import { createApp } from '../miniapps/mimic-tear/miniapp/node/server.mjs';
import { makeRuntimeDb, tmpDir, cleanupDir } from './helpers/fixture.mjs';

class PersistenceStub {
  constructor() {
    this.bossSession = null;
    this.acks = new Set();
    this.dismissed = new Map();
  }
  async getBossSession() { return this.bossSession; }
  async setBossSession(session) { this.bossSession = session; }
  async listAcks() { return [...this.acks]; }
  async addAck(id) { this.acks.add(id); }
  async listDismissed() {
    return [...this.dismissed].map(([id, reason]) => ({ id, reason, at: Date.now() }));
  }
  async addDismissed(id, reason) {
    this.dismissed.set(id, reason);
    return this.listDismissed();
  }
  async findDispatchByKey() { return null; }
  async saveDispatch() {}
  async listDispatches() { return []; }
}

function sessionRow(id, projectId, extra = {}) {
  return {
    id,
    agentName: 'mavis',
    status: 'idle',
    title: `会话 ${id}`,
    workspaceDir: 'D:/projects/x',
    purpose: null,
    purposeKind: null,
    parentSessionId: null,
    sessionType: 'root',
    visibility: 'visible',
    createdAt: 0,
    updatedAt: 100,
    errorCode: null,
    errorMessage: null,
    projectId,
    ...extra,
  };
}

test('audit regressions', async (t) => {
  await t.test('I1：一次降级之后，后续派工仍然走 boss agent', async () => {
    const persistence = new PersistenceStub();
    const calls = [];
    let failNext = true;

    const agent = {
      async agents() {
        return { agents: [{ name: 'boss', displayName: '大哥', primary: false }] };
      },
      async run(input) {
        calls.push(input);
        if (input.agent === 'boss' && failNext) {
          failNext = false;
          throw new Error('boss 缺少投递工具');
        }
        return { sessionId: `sess-${calls.length}`, status: 'finished', text: '投递状态：已投递' };
      },
      async reply() {},
    };

    const bridge = new BossBridge({ agent, persistence });

    const first = await bridge.dispatch({
      projectId: 1, projectName: 'a', projectPath: 'D:/a',
      sessionId: null, sessionTitle: null, instruction: 'x',
    });
    assert.equal(first.usedAgent, 'primary', '第一次 boss 失败应降级');

    const second = await bridge.dispatch({
      projectId: 1, projectName: 'a', projectPath: 'D:/a',
      sessionId: null, sessionTitle: null, instruction: 'y',
    });
    assert.equal(second.usedAgent, 'boss', '降级只影响当次，下一次必须回到 boss');
    assert.equal(calls.at(-1).agent, 'boss');
  });

  await t.test('I1：降级用的主 agent 会话不会被记成大哥会话', async () => {
    const persistence = new PersistenceStub();
    const agent = {
      async agents() {
        return { agents: [{ name: 'boss', displayName: '大哥', primary: false }] };
      },
      async run(input) {
        if (input.agent === 'boss') throw new Error('boss 不可用');
        return { sessionId: 'primary-session', status: 'finished', text: '投递状态：已投递' };
      },
      async reply() {},
    };

    const bridge = new BossBridge({ agent, persistence });
    await bridge.dispatch({
      projectId: 1, projectName: 'a', projectPath: 'D:/a',
      sessionId: null, sessionTitle: null, instruction: 'x',
    });

    assert.notEqual(
      persistence.bossSession?.sessionId,
      'primary-session',
      '主 agent 的会话不能被记成大哥会话，否则以后永远走主 agent',
    );
  });

  await t.test('I3：项目卡片的会话数与组织树节点数一致', () => {
    const sessions = [
      sessionRow('lead', 1),
      sessionRow('child-1', 1, { parentSessionId: 'lead' }),
      sessionRow('child-2', 1, { parentSessionId: 'child-1' }),
      sessionRow('other', 1),
    ];
    const projects = [{
      id: 1,
      kind: 'workspace',
      workspaceDir: 'D:/projects/alpha',
      pinned: false,
      hidden: false,
      orderIndex: 0,
      recentAt: null,
      // The runtime's denormalised count counts root sessions only (2 here), not all 4.
      latestActivityAt: 100,
      sessionCount: 2,
    }];

    const cards = buildProjectCards({ projects, sessions, goals: [], questionnaires: [], plans: new Map() });
    const tree = buildOrgTree(sessions);
    const treeNodes = tree.reduce((total, node) => total + 1 + countTree(node), 0);

    assert.equal(cards[0].sessionCount, sessions.length, '卡片应显示真实会话数');
    assert.equal(cards[0].sessionCount, treeNodes, '卡片与组织树的会话数必须一致');
  });

  await t.test('I7：健康度规则真的接上了后台任务', () => {
    const sessions = [sessionRow('s1', 1)];
    const tasks = [{
      id: 'bg-1',
      ownerSessionId: 's1',
      kind: 'bash',
      status: 'running',
      createdAt: 0,
      updatedAt: 0,
      endedAt: null,
    }];
    const projects = [{
      id: 1,
      kind: 'workspace',
      workspaceDir: 'D:/projects/alpha',
      pinned: false,
      hidden: false,
      orderIndex: 0,
      recentAt: null,
      latestActivityAt: 100,
      sessionCount: 1,
    }];

    const cards = buildProjectCards({
      projects, sessions, goals: [], questionnaires: [], tasks, plans: new Map(),
    });
    assert.equal(cards[0].health, 'active', '有 running 后台任务时项目应为 active');
  });

  await t.test('I4：总览徽标与收件箱条目数一致', async () => {
    const dir = tmpDir();
    try {
      const store = RuntimeStore.open(makeRuntimeDb(dir));
      const patrol = new PatrolStore(join(dir, 'data'));
      const service = new ProjectService({
        store,
        readPlan: async () => null,
        skills: { skills: [], failures: [] },
        domains: [],
        persistence: new PersistenceStub(),
        boss: { dispatch: async () => ({}), patrol: async () => ({}) },
        patrol,
      });

      await patrol.add({
        projectId: null,
        projectName: null,
        severity: 'medium',
        title: '大哥巡检结论',
        body: '有一项需要你决定',
      });

      const overview = await service.getOverview();
      const inbox = await service.getInbox();
      const pendingInInbox = inbox.items.filter((i) => !i.acknowledged && i.severity !== 'low').length;

      assert.equal(
        overview.kpi.pendingDecisions,
        pendingInInbox,
        '徽标数字必须与收件箱里未确认的条目数一致',
      );
      assert.ok(
        overview.attention.some((i) => i.kind === 'patrol'),
        '巡检结论必须进入「需你处理」',
      );
      store.close();
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('大哥巡检发现的缺陷：计划任务状态必须带年龄', () => {
    const sessions = [sessionRow('lead', 1)];
    const projects = [{
      id: 1,
      kind: 'workspace',
      workspaceDir: 'D:/projects/alpha',
      pinned: false,
      hidden: false,
      orderIndex: 0,
      recentAt: null,
      latestActivityAt: 100,
      sessionCount: 1,
    }];
    const stalePlan = {
      source: '.mavis/plans/status1.log',
      updatedAt: Date.now() - 120 * 86_400_000,
      tasks: [{ id: 't1', title: '旧任务', state: 'blocked', assignedTo: 'coder' }],
    };

    const cards = buildProjectCards({
      projects,
      sessions,
      goals: [],
      questionnaires: [],
      plans: new Map([[1, stalePlan]]),
    });

    assert.equal(
      cards[0].planUpdatedAt,
      stalePlan.updatedAt,
      '项目卡必须带上计划状态的写入时间，否则看板无法区分"当前阻塞"和"四个月前的快照"',
    );
  });

  await t.test('M2：server 路由接的是真实 ProjectService 时，非法派工返回 400', async () => {
    const dir = tmpDir();
    let store = null;
    let server = null;
    try {
      store = RuntimeStore.open(makeRuntimeDb(dir));
      const service = new ProjectService({
        store,
        readPlan: async () => null,
        skills: { skills: [], failures: [] },
        domains: [],
        persistence: new PersistenceStub(),
        boss: { dispatch: async () => ({}), patrol: async () => ({}) },
        patrol: new PatrolStore(join(dir, 'data')),
      });

      const app = createApp({ service, clientDir: dir });
      server = (await import('node:http')).createServer((req, res) => {
        void app.handler(req, res);
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address();

      const response = await fetch(`http://127.0.0.1:${port}/api/dispatch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: 1, instruction: '' }),
      });
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.error, 'empty_instruction');

      const unknown = await fetch(`http://127.0.0.1:${port}/api/dispatch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: 9999, instruction: 'x', idempotencyKey: 'k' }),
      });
      assert.equal(unknown.status, 404);
      assert.equal((await unknown.json()).error, 'unknown_project');
    } finally {
      // The server MUST be closed even when an assertion throws. An open server keeps the
      // event loop alive and `node --test` waits for the file's process to exit — so a
      // failing assertion would hang the whole suite instead of reporting itself.
      if (server) await new Promise((resolve) => server.close(resolve));
      store?.close();
      cleanupDir(dir);
    }
  });
});

function countTree(node) {
  return node.children.reduce((total, child) => total + 1 + countTree(child), 0);
}
