/**
 * Pure view-model functions.
 *
 * Everything in this module is a pure function over plain rows: no IO, no clock reads, no
 * mutation. That keeps the aggregation rules (health priority, inbox severity, org-tree
 * shape) directly testable without a runtime, a database, or a filesystem.
 */

/**
 * @typedef {'active'|'idle'|'blocked'|'error'} Health
 * @typedef {{ id:number, kind:string, workspaceDir:string, pinned:boolean, hidden:boolean,
 *             orderIndex:number, recentAt:number|null, latestActivityAt:number|null,
 *             sessionCount:number }} ProjectRow
 * @typedef {{ id:string, agentName:string, status:string, title:string, workspaceDir:string,
 *             purpose:string|null, purposeKind:string|null, parentSessionId:string|null,
 *             sessionType:string, visibility:string, createdAt:number, updatedAt:number,
 *             errorCode:number|null, errorMessage:string|null, projectId:number|null }} SessionRow
 * @typedef {{ id:string, sessionId:string, objective:string, status:string, createdAt:number,
 *             updatedAt:number, tokensUsed:number, timeUsedSeconds:number,
 *             statusReason:string|null, lastVerification:string|null,
 *             dismissedAt:number|null }} GoalRow
 * @typedef {{ id:string, sessionId:string, agentName:string, requestJson:string,
 *             status:string, createdAt:number }} QuestionnaireRow
 * @typedef {{ id:string|null, title:string, state:string, assignedTo:string|null }} PlanTask
 * @typedef {{ source:string, updatedAt:number, tasks:PlanTask[] }} PlanSnapshot
 * @typedef {{ id:number, name:string, path:string, sessionCount:number,
 *             lastActivityAt:number|null, health:Health, activeSessions:number,
 *             erroredSessions:number, pendingQuestions:number,
 *             goals:GoalRow[], planTasks:PlanTask[] }} ProjectCard
 * @typedef {{ id:string, kind:'questionnaire'|'goal-paused'|'session-error'|'plan-blocked',
 *             severity:'high'|'medium'|'low', projectId:number, projectName:string,
 *             sessionId:string|null, sessionTitle:string|null, title:string, body:string,
 *             createdAt:number, ageMinutes:number, acknowledged:boolean }} InboxItem
 * @typedef {{ id:string, agentName:string, title:string, status:string,
 *             role:'lead'|'member', purpose:string|null, error:string|null,
 *             children:OrgNode[] }} OrgNode
 * @typedef {{ projects:number, active:number, pendingDecisions:number, errors:number }} Kpi
 */

/** Inbox severities, ordered from most to least urgent. */
const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

/**
 * Health of a project, decided by the first matching rule.
 *
 * The order encodes urgency: a project that has errored outranks one that is merely waiting,
 * and a project with nothing running is idle rather than blocked.
 *
 * @param {{ sessions: SessionRow[], pendingQuestions: number, goals: GoalRow[],
 *           planTasks: PlanTask[], activeTasks: number }} input
 * @returns {Health}
 */
export function computeHealth(input) {
  const sessions = input.sessions ?? [];
  const goals = input.goals ?? [];
  const planTasks = input.planTasks ?? [];

  if (sessions.some((s) => s.status === 'error' || s.errorCode != null)) return 'error';
  if ((input.pendingQuestions ?? 0) > 0) return 'blocked';
  if (goals.some((g) => g.status === 'paused' && g.dismissedAt == null)) return 'blocked';
  if (planTasks.some((t) => t.state === 'blocked')) return 'blocked';
  if (sessions.some((s) => s.status === 'started')) return 'active';
  if ((input.activeTasks ?? 0) > 0) return 'active';
  return 'idle';
}

/**
 * Build the project cards shown on the overview.
 *
 * @param {{ projects: ProjectRow[], sessions: SessionRow[], goals: GoalRow[],
 *           questionnaires: QuestionnaireRow[], plans: Map<number, PlanSnapshot|null> }} input
 * @returns {ProjectCard[]}
 */
export function buildProjectCards(input) {
  const projects = input.projects ?? [];
  const sessions = input.sessions ?? [];
  const goals = input.goals ?? [];
  const questionnaires = input.questionnaires ?? [];
  const plans = input.plans ?? new Map();

  const sessionsByProject = groupBy(sessions, (s) => s.projectId);
  const goalsBySession = groupBy(goals, (g) => g.sessionId);
  const questionsBySession = groupBy(questionnaires, (q) => q.sessionId);

  return projects.map((project) => {
    const projectSessions = sessionsByProject.get(project.id) ?? [];
    const sessionIds = new Set(projectSessions.map((s) => s.id));

    const projectGoals = projectSessions.flatMap((s) => goalsBySession.get(s.id) ?? []);
    const projectQuestions = projectSessions.flatMap((s) => questionsBySession.get(s.id) ?? []);
    const pendingQuestions = projectQuestions.filter((q) => q.status !== 'answered' && q.status !== 'dismissed');

    const plan = plans.get(project.id) ?? null;
    const planTasks = plan?.tasks ?? [];

    const activeTasks = projectSessions.filter((s) => s.status === 'started').length;

    return {
      id: project.id,
      name: projectName(project.workspaceDir),
      path: project.workspaceDir,
      sessionCount: project.sessionCount || projectSessions.length,
      lastActivityAt: project.latestActivityAt ?? projectSessions[0]?.updatedAt ?? null,
      health: computeHealth({
        sessions: projectSessions,
        pendingQuestions: pendingQuestions.length,
        goals: projectGoals,
        planTasks,
        activeTasks,
      }),
      activeSessions: activeTasks,
      erroredSessions: projectSessions.filter((s) => s.status === 'error' || s.errorCode != null).length,
      pendingQuestions: pendingQuestions.length,
      goals: projectGoals,
      planTasks,
    };
  });
}

/**
 * Build the decision inbox: everything that is waiting on the boss.
 *
 * @param {{ projects: ProjectRow[], sessions: SessionRow[], goals: GoalRow[],
 *           questionnaires: QuestionnaireRow[], plans: Map<number, PlanSnapshot|null> }} input
 * @param {Set<string>} [acked] ids the user already acknowledged
 * @returns {InboxItem[]}
 */
export function buildInbox(input, acked) {
  const acknowledged = acked ?? new Set();
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
    items.push({ ...item, acknowledged: acknowledged.has(item.id) });
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
    if (questionnaire.status === 'answered' || questionnaire.status === 'dismissed') continue;
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

  items.sort((a, b) => {
    const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (bySeverity !== 0) return bySeverity;
    return b.createdAt - a.createdAt;
  });

  return items;
}

/**
 * Rebuild the org tree from the runtime's parent/child session links.
 *
 * A session whose parent is missing from the set (deleted, or living in another project)
 * is promoted to a root so no node is ever lost.
 *
 * @param {SessionRow[]} sessions
 * @returns {OrgNode[]}
 */
export function buildOrgTree(sessions) {
  const list = sessions ?? [];
  const byId = new Map(list.map((s) => [s.id, s]));
  const childIds = new Set(list.map((s) => s.parentSessionId).filter(Boolean));

  /** @type {Map<string, OrgNode[]>} */
  const childrenOf = new Map();
  /** @type {OrgNode[]} */
  const roots = [];

  for (const session of list) {
    const node = {
      id: session.id,
      agentName: session.agentName,
      title: session.title || session.id,
      status: session.status,
      role: 'member',
      purpose: session.purpose,
      error: session.errorMessage || (session.errorCode != null ? `错误码 ${session.errorCode}` : null),
      children: [],
    };

    const parentId = session.parentSessionId;
    if (parentId && byId.has(parentId) && parentId !== session.id) {
      if (!childrenOf.has(parentId)) childrenOf.set(parentId, []);
      childrenOf.get(parentId).push(node);
    } else {
      node.role = 'lead';
      roots.push(node);
    }
  }

  const attach = (node) => {
    const children = childrenOf.get(node.id) ?? [];
    node.children = children;
    for (const child of children) attach(child);
  };
  for (const root of roots) attach(root);

  // Sessions that are their own parent's descendant but whose parent vanished are already
  // roots; guard against cycles so a malformed link cannot hang the page.
  const visited = new Set();
  const walk = (node) => {
    if (visited.has(node.id)) {
      node.children = [];
      return;
    }
    visited.add(node.id);
    for (const child of node.children) walk(child);
  };
  for (const root of roots) walk(root);

  void childIds;
  return roots;
}

/**
 * Headline counters for the overview.
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
    pendingDecisions: items.filter((i) => !i.acknowledged && i.severity !== 'low').length,
    errors: projectCards.filter((c) => c.health === 'error').length,
  };
}

/**
 * Human-readable reason for a failed session.
 *
 * The runtime sometimes records a failure without a message or an error code, so the
 * fallback must not print "null".
 *
 * @param {SessionRow} session
 * @returns {string}
 */
export function sessionErrorBody(session) {
  if (session.errorMessage && session.errorMessage.trim()) return session.errorMessage;
  if (session.errorCode != null) return `错误码 ${session.errorCode}`;
  return '运行时未提供具体原因（会话状态为异常）';
}

/**
 * Extract the human-readable question text from a questionnaire payload.
 *
 * The payload shape changes between runtime versions, so parsing failures degrade to a
 * readable placeholder instead of throwing.
 *
 * @param {string} requestJson
 * @returns {string}
 */
export function questionnaireBody(requestJson) {
  const fallback = '无法解析该问卷内容';
  if (!requestJson) return fallback;

  let parsed;
  try {
    parsed = JSON.parse(requestJson);
  } catch {
    return fallback;
  }
  if (!parsed || typeof parsed !== 'object') return fallback;

  const steps = Array.isArray(parsed.steps) ? parsed.steps : null;
  if (!steps || steps.length === 0) {
    const title = typeof parsed.title === 'string' ? parsed.title : '';
    return title || fallback;
  }

  const questions = steps
    .map((step) => (step && typeof step.question === 'string' ? step.question : ''))
    .filter((text) => text.length > 0);
  if (questions.length === 0) return fallback;
  return questions.join(' / ');
}

/** Display name of a project: the last path segment. */
export function projectName(workspaceDir) {
  if (!workspaceDir) return '未知项目';
  const normalized = workspaceDir.replace(/[\\/]+$/, '');
  const segments = normalized.split(/[\\/]/);
  return segments[segments.length - 1] || normalized;
}

function ageMinutes(timestamp, now) {
  if (!timestamp) return 0;
  return Math.max(0, Math.round((now - timestamp) / 60000));
}

function groupBy(items, keyOf) {
  /** @type {Map<any, any[]>} */
  const groups = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (key == null) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}
