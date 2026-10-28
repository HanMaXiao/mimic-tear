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
  normalizeConclusionSource,
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

  await t.test('过期的问卷不算未解决：它不能钉住项目，也不能在收件箱里变成待办', () => {
    const projects = [project(1, 'D:/projects/alpha')];
    const sessions = [session('s1', 1)];
    // The card's window closed: it can no longer be clicked, so nobody is waiting on it.
    const questionnaires = [questionnaire('ask-1', 's1', '{}', { status: 'expired' })];

    const cards = buildProjectCards({ projects, sessions, goals: [], questionnaires, plans: new Map() });
    assert.equal(cards[0].pendingQuestions, 0, '过期卡不算待答');
    assert.equal(cards[0].health, 'idle', '一张过期卡不该把项目钉在 blocked');

    const inbox = buildInbox({ projects, sessions, goals: [], questionnaires, plans: new Map() }, new Set());
    assert.equal(
      inbox.some((item) => item.kind === 'questionnaire'),
      false,
      '过期卡不该在收件箱里变成一条要人拍板的待办',
    );

    // A genuinely pending card still behaves as before.
    const live = buildProjectCards({
      projects,
      sessions,
      goals: [],
      questionnaires: [questionnaire('ask-2', 's1', '{}', { status: 'pending' })],
      plans: new Map(),
    });
    assert.equal(live[0].pendingQuestions, 1, '真待答卡照常计数');
    assert.equal(live[0].health, 'blocked', '真待答卡照常阻塞');
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

  await t.test('大哥撤回的结论要单独计数——看板不能替它悄悄清场', () => {
    const duty = buildDutyStatus({
      config: {
        lastRunAt: NOW - 5 * 60_000,
        intervalMinutes: 15,
        dutyIntervalMinutes: 30,
      },
      findings: [
        { acknowledged: false },
        { acknowledged: false },
        { acknowledged: true, acknowledgedBy: 'boss' },
        { acknowledged: true, acknowledgedBy: 'user' },
      ],
      now: NOW,
    });

    assert.equal(duty.findings, 4);
    assert.equal(duty.openFindings, 2, '已确认的和已撤回的都不该再占着待办');
    assert.equal(duty.withdrawn, 1, '大哥撤回的要单独计数——否则它能悄悄清空你的桌面');
  });

  await t.test('大哥很久没交班时，看板必须能说出「可能掉线」', () => {
    const config = { lastRunAt: NOW - 60 * 60_000, intervalMinutes: 15, dutyIntervalMinutes: 30 };

    const fresh = buildDutyStatus({ config: { ...config, lastRunAt: NOW - 5 * 60_000 }, findings: [], now: NOW });
    assert.equal(fresh.stale, false, '刚交过班不算掉线');
    assert.equal(fresh.neverRan, false);
    assert.equal(fresh.ageMinutes, 5);
    assert.equal(fresh.missedRounds, 0, '刚交过班就不算漏轮');

    const silent = buildDutyStatus({ config, findings: [], now: NOW });
    assert.equal(silent.stale, true, '一小时没有交班必须判定掉线');
    assert.equal(silent.neverRan, false);
    assert.equal(silent.staleAfterMinutes, 45);
    assert.equal(silent.missedRounds, 1, '60 分钟里漏掉了一轮');
  });

  await t.test('漏了几轮要算得准：这是大哥自检「上一轮有没有交班」的依据', () => {
    const at = (ageMinutes) => buildDutyStatus({
      config: { lastRunAt: NOW - ageMinutes * 60_000, intervalMinutes: 15, dutyIntervalMinutes: 30 },
      findings: [],
      now: NOW,
    });

    assert.equal(at(0).missedRounds, 0);
    assert.equal(at(29).missedRounds, 0, '还没到下一轮');
    assert.equal(at(31).missedRounds, 1, '过了一轮没交班');
    assert.equal(at(60).missedRounds, 1);
    assert.equal(at(61).missedRounds, 2, '连着两轮都没交班');
    assert.equal(at(150).missedRounds, 4);

    const never = buildDutyStatus({
      config: { lastRunAt: null, intervalMinutes: 15, dutyIntervalMinutes: 30 },
      findings: [],
      now: NOW,
    });
    assert.equal(never.missedRounds, null, '从没交过班不算「漏了几轮」，那是另一回事');
  });

  await t.test('大哥从没交过班，也算掉线（而不是安静）', () => {
    const duty = buildDutyStatus({
      config: { lastRunAt: null, intervalMinutes: 15 },
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
      config: { lastRunAt: NOW - 10 * 60_000, intervalMinutes: 15 },
      findings,
      now: NOW,
    });

    assert.equal(duty.findings, 2);
    assert.equal(duty.openFindings, 1);
    assert.equal(duty.stale, false);
  });

  await t.test('掉线阈值跟着值班周期走，永远大于一个周期', () => {
    assert.equal(dutyStaleAfterMinutes(30), 45, '30 分钟一班 → 45 分钟后判定掉线');
    assert.equal(dutyStaleAfterMinutes(60), 90, '60 分钟一班必须是 90，否则每一轮都会被误报成掉线');
    assert.equal(dutyStaleAfterMinutes(15), 45, '间隔很短时也要留出最低观察窗');
    assert.equal(dutyStaleAfterMinutes(0), 45, '非法间隔退回默认值');
    assert.equal(dutyStaleAfterMinutes(Number.NaN), 45);

    for (const duty of [5, 10, 15, 30, 45, 60, 90, 120]) {
      const threshold = dutyStaleAfterMinutes(duty);
      assert.equal(threshold, Math.max(Math.ceil(duty * 1.5), 45), `周期 ${duty} 的阈值公式要对得上`);
      assert.ok(threshold > duty, `值班周期 ${duty} 分钟时阈值 ${threshold} 必须大于它，否则健康的班次也会被判掉线`);
    }
  });

  await t.test('掉线阈值按值班周期算，不看板板自己的巡检间隔', () => {
    const duty = buildDutyStatus({
      config: {
        lastRunAt: NOW - 70 * 60_000,
        intervalMinutes: 15,
        dutyIntervalMinutes: 60,
      },
      findings: [],
      now: NOW,
    });

    assert.equal(duty.staleAfterMinutes, 90, '阈值来自值班周期 60，不是看板的 15');
    assert.equal(duty.stale, false, '70 分钟没交班，但在 90 分钟阈值内不该算掉线');
    assert.equal(duty.dutyIntervalMinutes, 60);
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

  await t.test('结论的来源只有两种：值班交班与看板巡检', () => {
    assert.equal(normalizeConclusionSource('duty'), 'duty');
    assert.equal(normalizeConclusionSource('board'), 'board');
  });

  await t.test('旧结论没有来源字段：按 board 兜底，但不能被丢掉', () => {
    // A conclusion written before the field existed carries no origin. Dropping it
    // would take something off the user's desk without saying so, so it is kept and
    // reads as 'board' — the origin that produces conclusions with no duty round.
    assert.equal(normalizeConclusionSource(undefined), 'board');
    assert.equal(normalizeConclusionSource(null), 'board');
    assert.equal(normalizeConclusionSource(''), 'board');
    assert.equal(normalizeConclusionSource('胡写的'), 'board');
    assert.equal(normalizeConclusionSource(undefined, 'duty'), 'duty', '调用方可以自己定兜底');
  });

  await t.test('值班行的「N 条结论待你过目」不能把两种来源混在一起数', () => {
    const duty = buildDutyStatus({
      config: {
        lastRunAt: NOW - 5 * 60_000,
        intervalMinutes: 15,
        dutyIntervalMinutes: 30,
      },
      findings: [
        { acknowledged: false, source: 'duty' },
        { acknowledged: false, source: 'duty' },
        { acknowledged: false, source: 'board' },
        { acknowledged: false },
        { acknowledged: true, source: 'duty' },
      ],
      now: NOW,
    });

    assert.equal(duty.openFindings, 4, '总数不变——现有客户端读的还是这个字段');
    assert.equal(duty.dutyOpenFindings, 2, '值班交班产生的结论要单独数');
    assert.equal(duty.boardOpenFindings, 2, '看板自己巡检出来的与旧结论都算 board');
    assert.equal(duty.dutyOpenFindings + duty.boardOpenFindings, duty.openFindings, '两种来源加起来必须等于总数，不能凭空多出或漏掉一条');
  });

  await t.test('结论被确认或撤回之后，两种来源的待办数都要跟着减', () => {
    const duty = buildDutyStatus({
      config: {
        lastRunAt: NOW - 5 * 60_000,
        intervalMinutes: 15,
        dutyIntervalMinutes: 30,
      },
      findings: [
        { acknowledged: true, source: 'duty' },
        { acknowledged: true, source: 'board' },
      ],
      now: NOW,
    });

    assert.equal(duty.openFindings, 0);
    assert.equal(duty.dutyOpenFindings, 0);
    assert.equal(duty.boardOpenFindings, 0);
  });
});
