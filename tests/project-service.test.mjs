import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { RuntimeStore } from '../miniapps/mimic-tear/miniapp/node/runtime-store.mjs';
import { Persistence } from '../miniapps/mimic-tear/miniapp/node/persistence.mjs';
import { PatrolStore } from '../miniapps/mimic-tear/miniapp/node/patrol-store.mjs';
import { ProjectService, DomainError } from '../miniapps/mimic-tear/miniapp/node/project-service.mjs';
// 拆出来的纯函数：写路径上的判断、收件箱装配、巡检计算、项目可见性。
import {
  buildDispatchPayload,
  buildDispatchRecord,
  dispatchResult,
  validateDispatchRequest,
} from '../miniapps/mimic-tear/miniapp/node/dispatch-flow.mjs';
import {
  assembleInbox,
  attachQuestionnaireShapes,
  buildPatrolInboxItems,
} from '../miniapps/mimic-tear/miniapp/node/inbox-assembly.mjs';
import { buildPatrolFindings, resolvePatrolProposals } from '../miniapps/mimic-tear/miniapp/node/patrol-run.mjs';
import { splitVisibleProjects } from '../miniapps/mimic-tear/miniapp/node/project-scope.mjs';
import { buildDutyStatus, resolveDutyIntervals } from '../miniapps/mimic-tear/miniapp/node/duty-status.mjs';
import { ageMinutes, severityRank, sortBySeverity } from '../miniapps/mimic-tear/miniapp/node/inbox-builder.mjs';
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
    async patrol() {
      return {
        bossSessionId: 'boss-session-1',
        status: 'finished',
        text: [
          '巡检结论：有一项要处理',
          '- 项目: alpha | 级别: high | 摘要: alpha 的会话在报错',
        ].join('\n'),
        error: null,
      };
    },
  };

  // The overrides may need the data directory, so a function form is accepted too.
  const extra = typeof overrides === 'function' ? overrides(dir) : overrides;

  const service = new ProjectService({
    store,
    readPlan: async () => null,
    skills: { skills: [], failures: [] },
    domains: [],
    persistence: new Persistence(join(dir, 'data')),
    boss,
    ...extra,
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
      assert.equal(dispatches[0].source, 'board', '看板这条派工要标出自己的来源');
      store.close();
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('收件箱的结论必须带来源：看板巡检是 board，值班结论是 duty，旧结论默认 board', async () => {
    const { service, store, dir } = makeService((dir) => ({ patrol: new PatrolStore(join(dir, 'data')) }));
    try {
      const { mkdir, writeFile } = await import('node:fs/promises');
      const dataDir = join(dir, 'data');
      await mkdir(dataDir, { recursive: true });
      // A conclusion written before the `source` field existed.
      await writeFile(join(dataDir, 'patrol.json'), JSON.stringify([
        {
          id: 'patrol_legacy',
          createdAt: 1,
          projectId: 1,
          projectName: 'alpha',
          severity: 'medium',
          title: '旧结论',
          body: '还没有来源字段时写的',
          acknowledged: false,
          acknowledgedBy: null,
          note: '',
        },
      ]), 'utf8');

      // The board's own patrol loop writes one.
      await service.runPatrol();

      // The duty path writes one.
      await new PatrolStore(dataDir).add({
        projectId: 1,
        projectName: 'alpha',
        severity: 'high',
        title: '值班结论',
        body: '值班这一轮发现的问题',
        source: 'duty',
      });

      const inbox = await service.getInbox();
      const conclusions = inbox.items.filter((item) => item.kind === 'patrol');
      assert.equal(conclusions.length, 3, '三条结论一条都不能少');
      assert.equal(
        conclusions.find((item) => item.title === 'alpha 的会话在报错').source,
        'board',
        '看板自己巡检出来的结论是 board',
      );
      assert.equal(
        conclusions.find((item) => item.title === '值班结论').source,
        'duty',
        '值班路径的结论是 duty',
      );
      assert.equal(
        conclusions.find((item) => item.title === '旧结论').source,
        'board',
        '旧结论没有来源字段，按 board 兜底',
      );

      // The duty line counts the two origins apart.
      const overview = await service.getOverview();
      assert.equal(overview.duty.openFindings, 3, '总数不变');
      assert.equal(overview.duty.dutyOpenFindings, 1, '值班来源的结论单独计数');
      assert.equal(overview.duty.boardOpenFindings, 2, '看板来源的（含旧结论）单独计数');
      store.close();
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('两条投递路径写进同一本派工账：看板的标 board，值班的标 duty', async () => {
    const { service, store, calls, dir } = makeService((dir) => ({ patrol: new PatrolStore(join(dir, 'data')) }));
    try {
      await service.dispatch({ projectId: 1, sessionId: null, instruction: '看板的指令', idempotencyKey: 'key-board' });
      await new PatrolStore(join(dir, 'data')).recordDutyDispatch({
        targetSessionId: 'sess-alpha-lead',
        instruction: '值班的指令',
      });

      const dispatches = await service.listDispatches();
      assert.equal(dispatches.length, 2, '两条投递路径的记录要在一本账里');

      const board = dispatches.find((record) => record.source === 'board');
      const duty = dispatches.find((record) => record.source === 'duty');
      assert.ok(board, '看板那条记录要在');
      assert.ok(duty, '值班那条记录也要在');
      assert.equal(board.instruction, '看板的指令');
      assert.equal(duty.instruction, '值班的指令');
      assert.equal(duty.projectName, 'alpha', '值班只报了会话，项目要从运行时补出来');
      assert.equal(duty.projectId, 1);

      // The board's idempotency behaviour is untouched — one key, one delivery.
      const again = await service.dispatch({
        projectId: 1, sessionId: null, instruction: '看板的指令', idempotencyKey: 'key-board',
      });
      assert.equal(again.duplicate, true, '同一个幂等键仍然只投递一次');

      const fresh = await service.dispatch({
        projectId: 1, sessionId: null, instruction: '另一条指令', idempotencyKey: 'key-other',
      });
      assert.equal(fresh.duplicate, false, '值班记录不能让新指令变成重复投递');
      assert.equal(calls.length, 2, 'boss 只应被调用两次');
      store.close();
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('旧派工记录没有来源字段：默认 board，一条都不能少', async () => {
    const { service, store, dir } = makeService();
    try {
      const { mkdir, writeFile } = await import('node:fs/promises');
      await mkdir(join(dir, 'data'), { recursive: true });
      await writeFile(join(dir, 'data', 'dispatches.json'), JSON.stringify([
        {
          id: 'dsp_legacy',
          idempotencyKey: 'k-legacy',
          projectId: 1,
          projectName: 'alpha',
          targetSessionId: null,
          instruction: '老记录',
          status: 'done',
          bossSessionId: null,
          text: '',
          error: null,
          createdAt: 1,
          updatedAt: 1,
        },
      ]), 'utf8');

      const dispatches = await service.listDispatches();
      assert.equal(dispatches.length, 1, '旧记录不能被丢掉');
      assert.equal(dispatches[0].source, 'board', '旧记录来自看板的派工按钮');
      assert.equal(dispatches[0].instruction, '老记录');
      store.close();
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('KPI 的待决策数与「需你处理」的条数必须是同一个数', async () => {
    const { service, store, dir } = makeService();
    try {
      const overview = await service.getOverview();
      assert.ok(overview.attention.length > 0, '夹具里本来就有要处理的事');
      assert.equal(
        overview.kpi.pendingDecisions,
        overview.attention.length,
        '徽标上的数字和列表里的条数必须一致——它们读的是同一个判定',
      );
      store.close();
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('看板巡检间隔与值班周期的兜底值只有一个来源', async () => {
    const { service, store, dir } = makeService();
    try {
      // 没有巡检存储时，配置走的是兜底值。
      const config = await service.getPatrolConfig();
      const duty = buildDutyStatus({ config, findings: [], now: Date.now() });
      const fallback = resolveDutyIntervals({});

      assert.equal(config.intervalMinutes, fallback.intervalMinutes, '配置与值班状态不能各写一份兜底值');
      assert.equal(config.dutyIntervalMinutes, fallback.dutyIntervalMinutes);
      assert.equal(duty.intervalMinutes, config.intervalMinutes);
      assert.equal(duty.dutyIntervalMinutes, config.dutyIntervalMinutes);
      store.close();
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('收件箱的排序只有一份口径：服务层装配的顺序与共享比较器一致', async () => {
    const { service, store, dir } = makeService((dir) => ({ patrol: new PatrolStore(join(dir, 'data')) }));
    try {
      await service.runPatrol();
      const inbox = await service.getInbox();
      const snapshot = await service.snapshot();

      // 服务层的收件箱 = 运行时原始项 + 巡检结论，两处用的是同一份排序。
      assert.deepEqual(
        inbox.items.map((item) => item.id),
        sortBySeverity(inbox.items).map((item) => item.id),
        '服务层的顺序必须与共享排序口径一致',
      );
      const ranks = inbox.items.map((item) => severityRank(item.severity));
      assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), '严重的必须排在前面');

      // 混进巡检结论之后，运行时原始项之间的相对顺序不能变。
      const runtimeOrder = snapshot.inbox.map((item) => item.id);
      const serviceRuntimeOrder = inbox.items
        .filter((item) => !item.id.startsWith('patrol:'))
        .map((item) => item.id);
      assert.deepEqual(serviceRuntimeOrder, runtimeOrder, '运行时原始项的相对顺序不能被巡检结论打乱');
      store.close();
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('派工：重复提交与新投递的结果形状一致', async () => {
    const { service, store, dir } = makeService();
    try {
      const input = { projectId: 1, sessionId: null, instruction: '把 X 排到明天', idempotencyKey: 'key-shape' };
      const first = await service.dispatch(input);
      const second = await service.dispatch(input);

      assert.deepEqual(
        Object.keys(first).sort(),
        Object.keys(second).sort(),
        '重复提交的结果形状必须和第一次一样',
      );
      assert.equal(second.duplicate, true);
      assert.equal(second.delivered, true, '重复提交的那次也要如实报出投递结果');
      store.close();
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('派工输入校验：四种错误码', () => {
    assert.throws(
      () => validateDispatchRequest({ instruction: 'x', idempotencyKey: 'k' }),
      (error) => error instanceof DomainError && error.code === 'invalid_project_id',
    );
    assert.throws(
      () => validateDispatchRequest({ projectId: 1, instruction: '   ', idempotencyKey: 'k' }),
      (error) => error instanceof DomainError && error.code === 'empty_instruction',
    );
    assert.throws(
      () => validateDispatchRequest({ projectId: 1, instruction: 'x' }),
      (error) => error instanceof DomainError && error.code === 'missing_idempotency_key',
    );

    const ok = validateDispatchRequest({ projectId: '2', instruction: '  做点事 ', idempotencyKey: '  k ' });
    assert.deepEqual(ok, { projectId: 2, instruction: '做点事', idempotencyKey: 'k' }, '字符串项目号要转成数字，两头空白要去掉');
  });

  await t.test('派工记录：来源标成 board，字段齐全', () => {
    const record = buildDispatchRecord({
      projectId: 1,
      projectName: 'alpha',
      targetSessionId: 'sess-alpha-lead',
      instruction: '做点事',
      idempotencyKey: 'k-record',
      now: 1000,
    });

    assert.equal(record.source, 'board', '看板这条派工要标出自己的来源');
    assert.equal(record.status, 'queued');
    assert.equal(record.createdAt, 1000);
    assert.equal(record.updatedAt, 1000);
    assert.match(record.id, /^dsp_/);
    assert.equal(record.bossSessionId, null);
    assert.equal(record.text, '');
    assert.equal(record.error, null);
    assert.equal(record.targetSessionId, 'sess-alpha-lead');
  });

  await t.test('给大哥的载荷：项目名与路径取自看板卡片', () => {
    const record = buildDispatchRecord({
      projectId: 1,
      projectName: 'alpha',
      targetSessionId: 'sess-alpha-lead',
      instruction: '做点事',
      idempotencyKey: 'k-payload',
      now: 1000,
    });

    const payload = buildDispatchPayload(record, { name: 'alpha', path: 'D:/projects/alpha' }, { id: 'sess-alpha-lead', title: '会话 alpha' });
    assert.equal(payload.projectName, 'alpha');
    assert.equal(payload.projectPath, 'D:/projects/alpha');
    assert.equal(payload.sessionId, 'sess-alpha-lead');
    assert.equal(payload.sessionTitle, '会话 alpha');
    assert.equal(payload.instruction, '做点事');

    // 卡片不在时退回记录里存的值——值班那条记录只有会话，没有项目。
    const fallback = buildDispatchPayload(record, null, null);
    assert.equal(fallback.projectName, 'alpha');
    assert.equal(fallback.projectPath, '');
    assert.equal(fallback.sessionId, null);
  });

  await t.test('派工结果：重复、成功、失败三种形状', () => {
    const done = { id: 'd1', status: 'done', bossSessionId: 'b1', text: '已投递', error: null };
    assert.deepEqual(dispatchResult(done), {
      dispatchId: 'd1',
      status: 'done',
      bossSessionId: 'b1',
      text: '已投递',
      error: null,
      delivered: true,
      duplicate: false,
    });
    assert.equal(dispatchResult(done, { duplicate: true }).duplicate, true, '重复提交要如实标出来');

    const failed = { id: 'd2', status: 'error', bossSessionId: null, text: '', error: 'boom' };
    assert.deepEqual(dispatchResult(failed), {
      dispatchId: 'd2',
      status: 'error',
      bossSessionId: null,
      text: '',
      error: 'boom',
      delivered: false,
      duplicate: false,
    });
  });

  await t.test('巡检结论落成条目：一条都没解析出来也要留一条', () => {
    const cards = [{ id: 1, name: 'alpha' }];

    const parsed = buildPatrolFindings(
      { conclusion: '有一项要处理', items: [{ projectName: 'alpha', severity: 'high', summary: '会话报错' }] },
      cards,
      '兜底正文',
    );
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].projectId, 1, '项目名要换算成项目 id');
    assert.equal(parsed[0].severity, 'high');
    assert.equal(parsed[0].title, '会话报错');

    // 一条都没解析出来：仍然落一条结论，把原文带上去，巡检不能静默。
    const empty = buildPatrolFindings({ conclusion: '随便写点', items: [] }, cards, '原文');
    assert.equal(empty.length, 1);
    assert.equal(empty[0].projectId, null);
    assert.equal(empty[0].severity, 'medium');
    assert.equal(empty[0].title, '随便写点');
    assert.equal(empty[0].body, '原文');

    // 项目名对不上：项目 id 留空，但结论一条都不能少。
    const unknown = buildPatrolFindings(
      { items: [{ projectName: 'gamma', severity: 'low', summary: '小事' }] },
      cards,
      'x',
    );
    assert.equal(unknown.length, 1);
    assert.equal(unknown[0].projectId, null);
    assert.equal(unknown[0].projectName, 'gamma');
  });

  await t.test('巡检提案：项目名对不上就当场标成失败，不去投递', () => {
    const cards = [{ id: 1, name: 'alpha' }];
    const resolved = resolvePatrolProposals({
      proposals: [
        { projectName: 'alpha', sessionId: null, instruction: '做' },
        { projectName: 'gamma', sessionId: null, instruction: '不做' },
      ],
    }, cards);

    assert.equal(resolved.length, 2);
    assert.equal(resolved[0].card.id, 1);
    assert.equal(resolved[0].error, null);
    assert.equal(resolved[1].card, null);
    assert.match(resolved[1].error, /找不到项目 gamma/);
    assert.equal(resolved[1].index, 1, '序号要留着——幂等键靠它');
  });

  await t.test('收件箱装配：巡检结论带上来源与年龄，问卷带上形状', () => {
    const patrolItems = buildPatrolInboxItems([
      {
        id: 'p1',
        severity: 'medium',
        projectId: 1,
        projectName: 'alpha',
        title: '结论',
        body: '正文',
        createdAt: Date.now() - 60_000,
        acknowledged: false,
        source: 'duty',
      },
      {
        id: 'p2',
        severity: 'low',
        projectId: null,
        projectName: null,
        title: '全局结论',
        body: '正文',
        createdAt: 1,
        acknowledged: true,
        acknowledgedBy: 'boss',
        note: '不适用',
      },
    ]);

    assert.equal(patrolItems[0].id, 'patrol:p1');
    assert.equal(patrolItems[0].source, 'duty', '值班来源的结论要带上来源');
    assert.equal(patrolItems[0].ageMinutes, 1, '年龄要走共享口径');
    assert.equal(patrolItems[0].ageMinutes, ageMinutes(patrolItems[0].createdAt));
    assert.equal(patrolItems[1].projectName, '全局', '没有项目的结论落到全局');
    assert.equal(patrolItems[1].handledBy, 'boss');
    assert.equal(patrolItems[1].handledReason, '不适用');

    const enriched = attachQuestionnaireShapes([
      {
        kind: 'questionnaire',
        requestId: 'q1',
        requestJson: JSON.stringify({ steps: [{ id: 's', question: '继续？', options: [{ id: 'o1', recommended: true }] }] }),
      },
      { kind: 'patrol', id: 'patrol:p1' },
    ], [{ requestId: 'q1', optionIds: ['o1'], answer: '继续', rationale: '因为', answeredAt: 5 }]);

    assert.deepEqual(enriched[0].stepIds, ['s']);
    assert.equal(enriched[0].options[0].recommended, true);
    assert.deepEqual(enriched[0].recommendation, {
      optionIds: ['o1'],
      answer: '继续',
      rationale: '因为',
      decidedAt: 5,
    });
    assert.equal(enriched[1].recommendation, undefined, '非问卷条目不能被动过');

    const assembled = assembleInbox(
      [{ id: 'r1', severity: 'high', createdAt: 1 }],
      [{ id: 'patrol:p1', severity: 'medium', createdAt: 2 }],
      [],
    );
    assert.deepEqual(assembled.map((item) => item.id), ['r1', 'patrol:p1'], '严重的在前');
  });

  await t.test('内部工作区拆分：可见项目与被藏起来的数量', () => {
    const { visible, internalCount } = splitVisibleProjects([
      { id: 1, workspaceDir: 'D:/Project/AppProject/Dungeon-Chesser' },
      { id: 2, workspaceDir: 'C:/Users/x/.minimax/agents/mavis/workspace' },
      { id: 3, workspaceDir: 'C:/Users/x/.mavis/agents/worker/miniapps/x' },
    ]);

    assert.equal(visible.length, 1);
    assert.equal(visible[0].id, 1);
    assert.equal(internalCount, 2, '被藏起来的项目要留着计数，不能悄悄消失');
  });
});
