import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { RuntimeStore } from '../miniapps/mimic-tear/miniapp/node/runtime-store.mjs';
import { Persistence } from '../miniapps/mimic-tear/miniapp/node/persistence.mjs';
import { ProjectService, DomainError } from '../miniapps/mimic-tear/miniapp/node/project-service.mjs';
import { makeRuntimeDb, tmpDir, cleanupDir } from './helpers/fixture.mjs';

function makeService(overrides = {}) {
  const dir = tmpDir();
  const dbPath = makeRuntimeDb(dir);
  const store = RuntimeStore.open(dbPath);

  const calls = [];
  const boss = {
    async dispatch(input) {
      calls.push(input);
      return {
        bossSessionId: 'boss-session-1',
        status: 'finished',
        text: '已投递',
        error: null,
        delivered: true,
      };
    },
  };

  const service = new ProjectService({
    store,
    readPlan: async () => null,
    skills: { skills: [], failures: [] },
    domains: [],
    persistence: new Persistence(join(dir, 'data')),
    boss,
    ...overrides,
  });

  return { service, store, boss, calls, dir, dbPath };
}

test('project-service', async (t) => {
  await t.test('总览：KPI、项目卡与需关注列表', async () => {
    const { service, store, dir } = makeService();
    try {
      const overview = await service.getOverview();

      assert.equal(overview.kpi.projects, 2, '隐藏项目与无目录项目不计入');
      assert.equal(overview.projects.length, 2);
      assert.ok(overview.kpi.errors >= 1, 'fixture 里有报错的会话');
      assert.ok(Array.isArray(overview.attention));
      assert.equal(overview.dataWarning, null);
      store.close();
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('项目详情：组织树、Goal、问卷、计划', async () => {
    const { service, store, dir } = makeService({
      readPlan: async () => ({
        source: '.mavis/plans/status1.log',
        updatedAt: 10,
        tasks: [{ id: 'a1', title: '任务 A', state: 'producing', assignedTo: 'coder' }],
      }),
    });
    try {
      const detail = await service.getProject(1);
      assert.ok(detail);
      assert.equal(detail.project.id, 1);
      assert.equal(detail.orgTree.length, 1);
      assert.equal(detail.orgTree[0].id, 'sess-alpha-lead');
      assert.equal(detail.orgTree[0].children.length, 2);
      assert.equal(detail.goals.length, 1);
      // The detail view is a record, not a to-do list: it shows every questionnaire the
      // project raised, including the expired one. Only the *counts* treat expired as done.
      assert.equal(detail.questions.length, 2);
      assert.equal(detail.questions.some((q) => q.status === 'expired'), true, '明细里要留得住过期卡这条记录');
      assert.equal(detail.project.pendingQuestions, 1, '但只有真正待答的那张算数');
      assert.equal(detail.plan.tasks[0].id, 'a1');

      assert.equal(await service.getProject(999), null, '不存在的项目返回 null');
      store.close();
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('ack 后条目被标记为已确认', async () => {
    const { service, store, dir } = makeService();
    try {
      const before = await service.getInbox();
      const target = before.items[0];
      assert.ok(target);
      assert.equal(target.acknowledged, false);

      const result = await service.ack(target.id);
      assert.equal(result.ok, true);

      const after = await service.getInbox();
      const updated = after.items.find((i) => i.id === target.id);
      assert.equal(updated.acknowledged, true);
      store.close();
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('Review Focus 5：同一幂等键只投递一次', async () => {
    const { service, store, calls, dir } = makeService();
    try {
      const input = { projectId: 1, sessionId: null, instruction: '把 X 排到明天', idempotencyKey: 'key-1' };

      const first = await service.dispatch(input);
      const second = await service.dispatch(input);

      assert.equal(first.duplicate, false);
      assert.equal(second.duplicate, true);
      assert.equal(second.dispatchId, first.dispatchId);
      assert.equal(calls.length, 1, 'boss 只应被调用一次');
      store.close();
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('派工：参数校验失败时不调用 boss', async () => {
    const { service, store, calls, dir } = makeService();
    try {
      await assert.rejects(
        () => service.dispatch({ projectId: 1, instruction: '', idempotencyKey: 'k' }),
        (error) => error instanceof DomainError && error.code === 'empty_instruction',
      );
      await assert.rejects(
        () => service.dispatch({ projectId: 1, instruction: 'x' }),
        (error) => error instanceof DomainError && error.code === 'missing_idempotency_key',
      );
      await assert.rejects(
        () => service.dispatch({ projectId: 999, instruction: 'x', idempotencyKey: 'k2' }),
        (error) => error instanceof DomainError && error.code === 'unknown_project',
      );
      await assert.rejects(
        () => service.dispatch({ projectId: 1, sessionId: 'nope', instruction: 'x', idempotencyKey: 'k3' }),
        (error) => error instanceof DomainError && error.code === 'unknown_session',
      );
      assert.equal(calls.length, 0);
      store.close();
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('派工：boss 抛错时记录为 error，不抛出未捕获异常', async () => {
    const { service, store, dir } = makeService({
      boss: {
        async dispatch() {
          throw new Error('boss 不可用');
        },
      },
    });
    try {
      const result = await service.dispatch({
        projectId: 1, sessionId: null, instruction: 'x', idempotencyKey: 'k-err',
      });
      assert.equal(result.status, 'error');
      assert.equal(result.delivered, false);
      assert.match(result.error, /boss 不可用/);
      store.close();
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('派工：目标会话必须属于该项目', async () => {
    const { service, store, calls, dir } = makeService();
    try {
      // 属于另一个项目的会话必须被拒绝。
      await assert.rejects(
        () => service.dispatch({
          projectId: 1, sessionId: 'sess-beta-lead', instruction: 'x', idempotencyKey: 'k-cross',
        }),
        (error) => error instanceof DomainError && error.code === 'unknown_session',
      );
      assert.equal(calls.length, 0);

      // 本项目内的会话可以正常派工。
      const result = await service.dispatch({
        projectId: 1, sessionId: 'sess-alpha-lead', instruction: 'x', idempotencyKey: 'k-own',
      });
      assert.equal(result.status, 'done');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].sessionId, 'sess-alpha-lead');
      assert.equal(calls[0].projectName, 'alpha');
      store.close();
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('能力库：返回领域分组', async () => {
    const { service, store, dir } = makeService({
      skills: { skills: [{ name: 'ue5-cpp-gameplay', description: '', source: 'user', path: 'a' }], failures: [] },
      domains: [{ key: 'unreal', label: 'UE5 引擎', match: ['ue5-'], keywords: [] }],
    });
    try {
      const skills = await service.getSkills();
      assert.equal(skills.total, 1);
      assert.equal(skills.groups.length, 1);
      assert.equal(skills.groups[0].key, 'unreal');
      store.close();
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('运行时内部工作区（agent 默认目录、插件目录）不计入项目', async () => {
    const { service, store, dir } = makeService();
    try {
      const internal = await import('../miniapps/mimic-tear/miniapp/node/project-service.mjs');
      assert.equal(internal.isInternalWorkspace('C:/Users/x/.minimax/agents/mavis/workspace'), true);
      assert.equal(internal.isInternalWorkspace('C:/Users/x/.minimax/agents/mavis/miniapps/minimax-bot'), true);
      assert.equal(internal.isInternalWorkspace('C:/Users/x/.mavis/agents/worker/workspace'), true);
      assert.equal(internal.isInternalWorkspace('D:/Project/AppProject/Dungeon-Chesser'), false);
      assert.equal(internal.isInternalWorkspace('D:/Project/My Workspace'), false);
      store.close();
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('已确认的条目不再计入「需你处理」，与 KPI 保持一致', async () => {
    const { service, store, dir } = makeService();
    try {
      const before = await service.getOverview();
      assert.ok(before.attention.length > 0);
      const target = before.attention[0];

      await service.ack(target.id);

      const after = await service.getOverview();
      assert.ok(
        !after.attention.some((item) => item.id === target.id),
        '已确认条目不应继续出现在需你处理里',
      );
      assert.equal(
        after.attention.length + 1,
        before.attention.length,
        '需你处理条数应与 KPI 待决策同步减少',
      );
      store.close();
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('持久化：ack 与派工记录写入 dataDir', async () => {
    const { service, store, dir } = makeService();
    try {
      await service.ack('item-1');
      await service.dispatch({ projectId: 1, sessionId: null, instruction: 'x', idempotencyKey: 'k-p' });

      const { readFile } = await import('node:fs/promises');
      const acks = JSON.parse(await readFile(join(dir, 'data', 'acks.json'), 'utf8'));
      const dispatches = JSON.parse(await readFile(join(dir, 'data', 'dispatches.json'), 'utf8'));

      assert.deepEqual(acks, ['item-1']);
      assert.equal(dispatches.length, 1);
      assert.equal(dispatches[0].instruction, 'x');
      store.close();
    } finally {
      cleanupDir(dir);
    }
  });
});
