/**
 * 决策收件箱的构建规则。
 *
 * 这个模块同时是**收件箱条目的共享判定口径**：严重度顺序、条目年龄、哪些条目算「需要你
 * 处理」。这三样以前各被算两遍（view-model 一份、project-service 一份），两边迟早会漂：
 * 排序写歪了，KPI 的待决策数就会和「需你处理」列表对不上；年龄写歪了，条目会显示成
 * 「-3 分钟」。
 *
 * 现在它们只有这一份实现，两侧都从这里取。
 */

import { groupBy } from './collections.mjs';
import { projectName } from './project-scope.mjs';
import { isUnresolvedQuestion, questionnaireBody } from './questionnaire-rules.mjs';

/**
 * @typedef {{ id:string, kind:'questionnaire'|'goal-paused'|'session-error'|'plan-blocked'|'patrol',
 *             severity:'high'|'medium'|'low', projectId:number, projectName:string,
 *             sessionId:string|null, sessionTitle:string|null, title:string, body:string,
 *             createdAt:number, ageMinutes:number, acknowledged:boolean,
 *             handledBy:'user'|'boss'|null, handledReason:string,
 *             source?:import('./conclusion-source.mjs').ConclusionSource }} InboxItem
 * @typedef {{ id:number, name:string, path:string, sessionCount:number,
 *             lastActivityAt:number|null, health:string, activeSessions:number,
 *             erroredSessions:number, pendingQuestions:number,
 *             goals:any[], planTasks:any[] }} ProjectCard
 * @typedef {{ projects:number, active:number, pendingDecisions:number, errors:number }} Kpi
 */

/** 收件箱的严重度，从最急到最不急。 */
const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

/**
 * 一个严重度的排序位次。
 *
 * 未知严重度没有位次——和以前一样，它在比较里表现为「排不出来」，于是保持原有相对顺序。
 *
 * @param {string} severity
 * @returns {number|undefined}
 */
export function severityRank(severity) {
  return SEVERITY_ORDER[severity];
}

/**
 * 收件箱条目的排序比较：先严重度，同一严重度再按时间倒序。
 *
 * @param {InboxItem} a
 * @param {InboxItem} b
 * @returns {number}
 */
export function compareBySeverity(a, b) {
  const bySeverity = severityRank(a.severity) - severityRank(b.severity);
  if (bySeverity !== 0) return bySeverity;
  return b.createdAt - a.createdAt;
}

/**
 * 按严重度排好序的收件箱条目。
 *
 * @param {InboxItem[]} items
 * @returns {InboxItem[]}
 */
export function sortBySeverity(items) {
  return [...(items ?? [])].sort(compareBySeverity);
}

/**
 * 一个条目有多老了（分钟）。
 *
 * 收件箱里的条目和看板自己巡检出来的条目都用这一份算法，所以同一条结论在两个视图里的
 * 「多久以前」不会差一分钟。
 *
 * @param {number} timestamp
 * @param {number} [now]
 * @returns {number}
 */
export function ageMinutes(timestamp, now = Date.now()) {
  if (!timestamp) return 0;
  return Math.max(0, Math.round((now - timestamp) / 60000));
}

/**
 * 「需你处理」的那部分条目：不是 low，而且还没被确认。
 *
 * KPI 的待决策数与总览的「需你处理」列表读的是同一个判定——这两者曾经各写一遍，于是出现过
 * 徽标说 3 条、列表里却只有 2 条的情况。
 *
 * @param {InboxItem[]} items
 * @returns {InboxItem[]}
 */
export function selectAttentionItems(items) {
  return (items ?? []).filter((item) => item.severity !== 'low' && !item.acknowledged);
}

/**
 * 构建决策收件箱：所有等着大老板拍板的东西。
 *
 * @param {{ projects: any[], sessions: any[], goals: any[],
 *           questionnaires: any[], plans: Map<number, any|null>, now?: number }} input
 * @param {Set<string>} [acked] 用户已经确认过的条目 id
 * @param {Map<string,string>} [dismissed] 大哥排除掉的条目 id 与理由
 * @returns {InboxItem[]}
 */
export function buildInbox(input, acked, dismissed) {
  const acknowledged = acked ?? new Set();
  const ruledOut = dismissed ?? new Map();
  const projects = input.projects ?? [];
  const sessions = input.sessions ?? [];
  const goals = input.goals ?? [];
  const questionnaires = input.questionnaires ?? [];
  const plans = input.plans ?? new Map();

  const projectById = new Map(projects.map((p) => [p.id, p]));
  const sessionById = new Map(sessions.map((s) => [s.id, s]));
  const sessionsByProject = groupBy(sessions, (s) => s.projectId);

  /** @type {InboxItem[]} */
  const items = [];
  const now = input.now ?? Date.now();

  const push = (item) => {
    if (!item.projectId) return;
    if (!projectById.has(item.projectId)) return;
    const reason = ruledOut.get(item.id);
    items.push({
      ...item,
      acknowledged: acknowledged.has(item.id) || reason !== undefined,
      // Who cleared it, and why — so an item that left the desk is never a silent one.
      handledBy: acknowledged.has(item.id) ? 'user' : (reason !== undefined ? 'boss' : null),
      handledReason: reason ?? '',
    });
  };

  // A session that errored out is the most urgent thing in the system.
  for (const session of sessions) {
    if (session.status !== 'error' && session.errorCode == null) continue;
    push({
      id: `session-error:${session.id}`,
      kind: 'session-error',
      severity: 'high',
      projectId: session.projectId ?? 0,
      projectName: projectName(projectById.get(session.projectId)?.workspaceDir ?? ''),
      sessionId: session.id,
      sessionTitle: session.title,
      title: `会话异常：${session.title || session.id}`,
      body: sessionErrorBody(session),
      createdAt: session.updatedAt,
      ageMinutes: ageMinutes(session.updatedAt, now),
    });
  }

  // A questionnaire is the boss's own question coming back.
  for (const questionnaire of questionnaires) {
    // An expired card can never be answered, so it is not a decision waiting for anyone.
    // Without this it shows up as a high-severity item that only a manual `dismiss` can
    // clear — work the board creates for itself and then has to be cleaned up by hand.
    if (!isUnresolvedQuestion(questionnaire.status)) continue;
    const session = sessionById.get(questionnaire.sessionId);
    push({
      id: `questionnaire:${questionnaire.id}`,
      kind: 'questionnaire',
      severity: 'high',
      projectId: session?.projectId ?? 0,
      projectName: projectName(projectById.get(session?.projectId)?.workspaceDir ?? ''),
      sessionId: session?.id ?? null,
      sessionTitle: session?.title ?? null,
      title: 'agent 请求你确认',
      body: questionnaireBody(questionnaire.requestJson),
      requestId: questionnaire.id,
      requestJson: questionnaire.requestJson,
      createdAt: questionnaire.createdAt,
      ageMinutes: ageMinutes(questionnaire.createdAt, now),
    });
  }

  // A paused goal is work that stopped and is waiting for a decision.
  for (const goal of goals) {
    if (goal.status !== 'paused' || goal.dismissedAt != null) continue;
    const session = sessionById.get(goal.sessionId);
    push({
      id: `goal-paused:${goal.id}`,
      kind: 'goal-paused',
      severity: 'medium',
      projectId: session?.projectId ?? 0,
      projectName: projectName(projectById.get(session?.projectId)?.workspaceDir ?? ''),
      sessionId: session?.id ?? null,
      sessionTitle: session?.title ?? null,
      title: 'Goal 已暂停',
      body: goal.objective || '（无目标描述）',
      createdAt: goal.updatedAt,
      ageMinutes: ageMinutes(goal.updatedAt, now),
    });
  }

  // A blocked plan task is a concrete piece of work that cannot move.
  for (const [projectId, plan] of plans) {
    if (!plan) continue;
    for (const task of plan.tasks) {
      if (task.state !== 'blocked') continue;
      push({
        id: `plan-blocked:${projectId}:${task.id ?? task.title}`,
        kind: 'plan-blocked',
        severity: 'high',
        projectId,
        projectName: projectName(projectById.get(projectId)?.workspaceDir ?? ''),
        sessionId: null,
        sessionTitle: null,
        title: '计划任务被阻塞',
        body: task.title,
        createdAt: plan.updatedAt,
        ageMinutes: ageMinutes(plan.updatedAt, now),
      });
    }
  }

  return sortBySeverity(items);
}

/**
 * 总览顶部的几个计数器。
 *
 * @param {ProjectCard[]} cards
 * @param {InboxItem[]} inbox
 * @returns {Kpi}
 */
export function buildKpi(cards, inbox) {
  const projectCards = cards ?? [];
  const items = inbox ?? [];
  return {
    projects: projectCards.length,
    active: projectCards.filter((c) => c.health === 'active').length,
    pendingDecisions: selectAttentionItems(items).length,
    errors: projectCards.filter((c) => c.health === 'error').length,
  };
}

/**
 * 会话失败时给人看的一句话。
 *
 * 运行时有时记了失败却没给消息、也没给错误码，所以兜底文案不能显示成 "null"。
 *
 * @param {any} session
 * @returns {string}
 */
export function sessionErrorBody(session) {
  if (session.errorMessage && session.errorMessage.trim()) return session.errorMessage;
  if (session.errorCode != null) return `错误码 ${session.errorCode}`;
  return '运行时未提供具体原因（会话状态为异常）';
}
