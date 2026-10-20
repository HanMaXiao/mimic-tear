import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeHealth,
  buildProjectCards,
  buildInbox,
  buildOrgTree,
  buildKpi,
  buildDutyStatus,
  dutyStaleAfterMinutes,
  questionnaireBody,
  projectName,
  sessionErrorBody,
} from '../miniapps/mimic-tear/miniapp/node/view-model.mjs';

const NOW = 1_800_000_000_000;

const project = (id, workspaceDir, extra = {}) => ({
  id,
  kind: 'workspace',
  workspaceDir,
  pinned: false,
  hidden: false,
  orderIndex: 0,
  recentAt: null,
  latestActivityAt: 900,
  sessionCount: 0,
  ...extra,
});

const session = (id, projectId, extra = {}) => ({
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
});

const goal = (id, sessionId, extra = {}) => ({
  id,
  sessionId,
  objective: `目标 ${id}`,
  status: 'active',
  createdAt: 0,
  updatedAt: 200,
  tokensUsed: 10,
  timeUsedSeconds: 5,
  statusReason: null,
  lastVerification: null,
  dismissedAt: null,
  ...extra,
});

const questionnaire = (id, sessionId, requestJson, extra = {}) => ({
  id,
  sessionId,
  agentName: 'mavis',
  requestJson,
  status: 'pending',
  createdAt: 300,
  ...extra,
});

const planTask = (title, state, extra = {}) => ({ id: null, title, state, assignedTo: null, ...extra });

test('view-model', async (t) => {
  await t.test('健康度优先级：error > blocked > active > idle', () => {
    const base = { sessions: [], pendingQuestions: 0, goals: [], planTasks: [], activeTasks: 0 };

    assert.equal(computeHealth(base), 'idle');

    assert.equal(computeHealth({ ...base, sessions: [session('s1', 1, { status: 'started' })] }), 'active');
    assert.equal(computeHealth({ ...base, activeTasks: 2 }), 'active');

    assert.equal(computeHealth({ ...base, pendingQuestions: 1 }), 'blocked');
    assert.equal(computeHealth({ ...base, goals: [goal('g1', 's1', { status: 'paused' })] }), 'blocked');
    assert.equal(computeHealth({ ...base, planTasks: [planTask('卡住', 'blocked')] }), 'blocked');

    assert.equal(
      computeHealth({ ...base, sessions: [session('s1', 1, { status: 'error' })] }),
      'error',
    );
    assert.equal(
      computeHealth({
        ...base,
        sessions: [session('s1', 1, { status: 'error' })],
        pendingQuestions: 3,
      }),
      'error',
      'error 优先于 blocked',
    );
    assert.equal(
      computeHealth({ ...base, goals: [goal('g1', 's1', { status: 'paused', dismissedAt: 1 })] }),
      'idle',
      '被忽略的 goal 不算阻塞',
    );
  });

  await t.test('项目卡：名称取自路径末段，健康度与计数正确', () => {
    const projects = [project(1, 'D:/projects/alpha'), project(2, 'D:/projects/beta')];
    const sessions = [
      session('s1', 1, { status: 'started' }),
      session('s2', 1, { status: 'error', errorCode: 500, errorMessage: 'boom' }),
      session('s3', 2),
    ];
    const goals = [goal('g1', 's3', { status: 'paused' })];
    const questionnaires = [questionnaire('q1', 's3')];
    const plans = new Map([[1, { source: 'x', updatedAt: 10, tasks: [planTask('T', 'producing')] }]]);

    const cards = buildProjectCards({ projects, sessions, goals, questionnaires, plans });

    assert.equal(cards.length, 2);
    assert.equal(cards[0].id, 1);
    assert.equal(cards[0].name, 'alpha');
    assert.equal(cards[0].health, 'error');
    assert.equal(cards[0].erroredSessions, 1);
    assert.equal(cards[0].activeSessions, 1);

    assert.equal(cards[1].id, 2);
    assert.equal(cards[1].health, 'blocked', 'pending 问卷 + paused goal 属于阻塞');
    assert.equal(cards[1].pendingQuestions, 1);
  });

  await t.test('收件箱：严重度排序，已确认项仍保留但标记 acknowledged', () => {
    const projects = [project(1, 'D:/projects/alpha')];
    const sessions = [
      session('lead', 1, { status: 'error', errorCode: 501, errorMessage: '网络错误' }),
      session('q1', 1),
    ];
    const goals = [goal('g1', 'q1', { status: 'paused' })];
    const questionnaires = [
      questionnaire('ask1', 'q1', JSON.stringify({
        schemaVersion: 2,
        steps: [{ id: 's', question: '是否继续？', options: [] }],
      })),
    ];
    const plans = new Map([[1, { source: 'x', updatedAt: 10, tasks: [planTask('被阻塞的任务', 'blocked')] }]]);

    const items = buildInbox({ projects, sessions, goals, questionnaires, plans, now: NOW }, new Set());

    assert.equal(items.length, 4);
    // 严重度降序：三个 high 在前，medium 在后。
    assert.deepEqual(items.map((i) => i.severity), ['high', 'high', 'high', 'medium']);
    // 同为 high 时按时间倒序：问卷比会话异常更新。
    assert.equal(items[0].kind, 'questionnaire');
    assert.equal(items[1].kind, 'session-error');
    assert.equal(items[2].kind, 'plan-blocked');
    assert.equal(items[3].kind, 'goal-paused');
    assert.equal(items[1].body, '网络错误');

    const asked = items.find((i) => i.kind === 'questionnaire');
    assert.equal(asked.body, '是否继续？');

    const acked = buildInbox({ projects, sessions, goals, questionnaires, plans, now: NOW },
      new Set([asked.id]));
    assert.equal(acked.find((i) => i.kind === 'questionnaire').acknowledged, true);
    assert.equal(acked.find((i) => i.kind === 'session-error').acknowledged, false);
  });

  await t.test('Review Focus 4：问卷 JSON 损坏时降级为可读文案', () => {
    assert.equal(questionnaireBody('not json'), '无法解析该问卷内容');
    assert.equal(questionnaireBody(''), '无法解析该问卷内容');
    assert.equal(questionnaireBody('{"schemaVersion":2}'), '无法解析该问卷内容');
    assert.equal(
      questionnaireBody('{"schemaVersion":2,"steps":[{"id":"a","question":"问题一"},{"id":"b","question":"问题二"}]}'),
      '问题一 / 问题二',
    );
  });

  await t.test('收件箱：问卷损坏时条目依然存在', () => {
    const projects = [project(1, 'D:/projects/alpha')];
    const sessions = [session('s1', 1)];
    const items = buildInbox({
      projects,
      sessions,
      goals: [],
      questionnaires: [questionnaire('ask1', 's1', '{ broken')],
      plans: new Map(),
      now: NOW,
    });

    assert.equal(items.length, 1);
    assert.equal(items[0].kind, 'questionnaire');
    assert.equal(items[0].body, '无法解析该问卷内容');
  });

  await t.test('组织树：还原父子关系，负责人为根', () => {
    const sessions = [
      session('lead', 1, { agentName: 'mavis', sessionType: 'root' }),
      session('w1', 1, { parentSessionId: 'lead', purpose: 'local-background-task:bg_a' }),
      session('w2', 1, { parentSessionId: 'w1' }),
    ];

    const tree = buildOrgTree(sessions);

    assert.equal(tree.length, 1);
    assert.equal(tree[0].id, 'lead');
    assert.equal(tree[0].role, 'lead');
    assert.equal(tree[0].children.length, 1);
    assert.equal(tree[0].children[0].id, 'w1');
    assert.equal(tree[0].children[0].role, 'member');
    assert.equal(tree[0].children[0].purpose, 'local-background-task:bg_a');
    assert.equal(tree[0].children[0].children[0].id, 'w2');
  });

  await t.test('Review Focus 3：父会话缺失的孤儿节点提升为根，不丢失', () => {
    const sessions = [
      session('lead', 1),
      session('orphan', 1, { parentSessionId: 'gone' }),
    ];

    const tree = buildOrgTree(sessions);
    const ids = tree.flatMap((n) => [n.id, ...n.children.map((c) => c.id)]);

    assert.ok(ids.includes('orphan'), '孤儿节点不能丢');
    assert.equal(tree.length, 2);
    assert.ok(tree.some((n) => n.id === 'orphan' && n.role === 'lead'));
  });

  await t.test('组织树：自引用与环不会导致死循环', () => {
    const sessions = [
      session('a', 1, { parentSessionId: 'b' }),
      session('b', 1, { parentSessionId: 'a' }),
    ];
    const tree = buildOrgTree(sessions);
    assert.ok(Array.isArray(tree));
  });

  await t.test('KPI 只统计未确认的高/中优先级待决策', () => {
    const cards = [
      { id: 1, health: 'active' },
      { id: 2, health: 'error' },
      { id: 3, health: 'idle' },
    ];
    const inbox = [
      { severity: 'high', acknowledged: false },
      { severity: 'medium', acknowledged: false },
      { severity: 'low', acknowledged: false },
      { severity: 'high', acknowledged: true },
    ];

    const kpi = buildKpi(cards, inbox);

    assert.equal(kpi.projects, 3);
    assert.equal(kpi.active, 1);
    assert.equal(kpi.errors, 1);
    assert.equal(kpi.pendingDecisions, 2, 'low 优先级与已确认项都不计入');
  });

  await t.test('大哥很久没交班时，看板必须能说出「可能掉线」', () => {
    const config = { lastRunAt: NOW - 60 * 60_000, intervalMinutes: 15, autoDispatch: false };

    const fresh = buildDutyStatus({ config: { ...config, lastRunAt: NOW - 5 * 60_000 }, findings: [], now: NOW });
    assert.equal(fresh.stale, false, '刚交过班不算掉线');
    assert.equal(fresh.neverRan, false);
    assert.equal(fresh.ageMinutes, 5);

    const silent = buildDutyStatus({ config, findings: [], now: NOW });
    assert.equal(silent.stale, true, '一小时没有交班必须判定掉线');
    assert.equal(silent.neverRan, false);
    assert.equal(silent.staleAfterMinutes, 45);
  });

  await t.test('大哥从没交过班，也算掉线（而不是安静）', () => {
    const duty = buildDutyStatus({
      config: { lastRunAt: null, intervalMinutes: 15, autoDispatch: false },
      findings: [],
      now: NOW,
    });

    assert.equal(duty.stale, true, '没交过班和「没事可报」必须区分开');
    assert.equal(duty.neverRan, true);
    assert.equal(duty.ageMinutes, null);
  });

  await t.test('交班时间戳只看交班本身，不受结论条数影响', () => {
    const findings = [{ acknowledged: false }, { acknowledged: true }];
    const duty = buildDutyStatus({
      config: { lastRunAt: NOW - 10 * 60_000, intervalMinutes: 15, autoDispatch: false },
      findings,
      now: NOW,
    });

    assert.equal(duty.findings, 2);
    assert.equal(duty.openFindings, 1);
    assert.equal(duty.stale, false);
  });

  await t.test('掉线阈值：三个间隔，且不低于 45 分钟', () => {
    assert.equal(dutyStaleAfterMinutes(15), 45);
    assert.equal(dutyStaleAfterMinutes(30), 90);
    assert.equal(dutyStaleAfterMinutes(5), 45, '间隔很短时也要留出最低观察窗');
    assert.equal(dutyStaleAfterMinutes(0), 45, '非法间隔退回默认值');
    assert.equal(dutyStaleAfterMinutes(Number.NaN), 45);
  });

  await t.test('会话异常没有消息也没有错误码时，不显示 null', () => {
    const body = sessionErrorBody({ errorMessage: null, errorCode: null });
    assert.ok(!body.includes('null'), `不应出现 null：${body}`);
    assert.match(body, /未提供具体原因/);
  });

  await t.test('会话异常优先显示运行时给出的消息', () => {
    assert.equal(sessionErrorBody({ errorMessage: '网络错误', errorCode: 501 }), '网络错误');
    assert.equal(sessionErrorBody({ errorMessage: null, errorCode: 501 }), '错误码 501');
  });

  await t.test('项目名：取路径末段，容忍尾部斜杠', () => {
    assert.equal(projectName('D:/projects/alpha'), 'alpha');
    assert.equal(projectName('D:/projects/alpha/'), 'alpha');
    assert.equal(projectName('D:\\projects\\alpha'), 'alpha');
    assert.equal(projectName(''), '未知项目');
  });
});
