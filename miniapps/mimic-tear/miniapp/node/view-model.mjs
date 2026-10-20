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
 * @typedef {{ id:string, ownerSessionId:string, kind:string, status:string, createdAt:number,
 *             updatedAt:number, endedAt:number|null }} TaskRow
 * @typedef {{ id:string, sessionId:string, agentName:string, requestJson:string,
 *             status:string, createdAt:number }} QuestionnaireRow
 * @typedef {{ id:string|null, title:string, state:string, assignedTo:string|null }} PlanTask
 * @typedef {{ source:string, updatedAt:number, tasks:PlanTask[] }} PlanSnapshot
 * @typedef {{ id:number, name:string, path:string, sessionCount:number,
 *             lastActivityAt:number|null, health:Health, activeSessions:number,
 *             erroredSessions:number, pendingQuestions:number,
 *             goals:GoalRow[], planTasks:PlanTask[] }} ProjectCard
 * @typedef {{ id:string, kind:'questionnaire'|'goal-paused'|'session-error'|'plan-blocked'|'patrol',
 *             severity:'high'|'medium'|'low', projectId:number, projectName:string,
 *             sessionId:string|null, sessionTitle:string|null, title:string, body:string,
 *             createdAt:number, ageMinutes:number, acknowledged:boolean,
 *             handledBy:'user'|'boss'|null, handledReason:string }} InboxItem
 * @typedef {{ id:string, agentName:string, title:string, status:string,
 *             role:'lead'|'member', purpose:string|null, error:string|null,
 *             children:OrgNode[] }} OrgNode
 * @typedef {{ projects:number, active:number, pendingDecisions:number, errors:number }} Kpi
 * @typedef {{ lastRunAt:number|null, intervalMinutes:number, dutyIntervalMinutes:number,
 *             findings:number, openFindings:number, withdrawn:number,
 *             staleAfterMinutes:number, stale:boolean, neverRan:boolean,
 *             ageMinutes:number|null, missedRounds:number|null }} DutyStatus
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
 *           questionnaires: QuestionnaireRow[], tasks?: TaskRow[],
 *           plans: Map<number, PlanSnapshot|null> }} input
 * @returns {ProjectCard[]}
 */
export function buildProjectCards(input) {
  const projects = input.projects ?? [];
  const sessions = input.sessions ?? [];
  const goals = input.goals ?? [];
  const questionnaires = input.questionnaires ?? [];
  const tasks = input.tasks ?? [];
  const plans = input.plans ?? new Map();

  const sessionsByProject = groupBy(sessions, (s) => s.projectId);
  const goalsBySession = groupBy(goals, (g) => g.sessionId);
  const questionsBySession = groupBy(questionnaires, (q) => q.sessionId);
  const tasksByOwner = groupBy(tasks, (t) => t.ownerSessionId);

  return projects.map((project) => {
    const projectSessions = sessionsByProject.get(project.id) ?? [];

    const projectGoals = projectSessions.flatMap((s) => goalsBySession.get(s.id) ?? []);
    const projectQuestions = projectSessions.flatMap((s) => questionsBySession.get(s.id) ?? []);
    const pendingQuestions = projectQuestions.filter((q) => q.status !== 'answered' && q.status !== 'dismissed');

    const plan = plans.get(project.id) ?? null;
    const planTasks = plan?.tasks ?? [];

    // A running background task is in-flight work even when no session is marked started.
    const runningTasks = projectSessions
      .flatMap((s) => tasksByOwner.get(s.id) ?? [])
      .filter((t) => t.status !== 'succeeded' && t.status !== 'failed' && t.status !== 'canceled').length;

    const activeSessions = projectSessions.filter((s) => s.status === 'started').length;

    return {
      id: project.id,
      name: projectName(project.workspaceDir),
      path: project.workspaceDir,
      // The denormalised `session_count` on the project row counts root sessions only, while
      // the org tree shows every session. Using the real count keeps the two views consistent.
      sessionCount: projectSessions.length,
      lastActivityAt: project.latestActivityAt ?? projectSessions[0]?.updatedAt ?? null,
      health: computeHealth({
        sessions: projectSessions,
        pendingQuestions: pendingQuestions.length,
        goals: projectGoals,
        planTasks,
        activeTasks: runningTasks,
      }),
      activeSessions,
      erroredSessions: projectSessions.filter((s) => s.status === 'error' || s.errorCode != null).length,
      pendingQuestions: pendingQuestions.length,
      goals: projectGoals,
      planTasks,
      // When the plan state was last written. A plan log can be months old, and a task
      // state that old is a historical fact, not a live signal — the board must say so.
      planUpdatedAt: plan?.updatedAt ?? null,
    };
  });
}

/**
 * Build the decision inbox: everything that is waiting on the boss.
 *
 * @param {{ projects: ProjectRow[], sessions: SessionRow[], goals: GoalRow[],
 *           questionnaires: QuestionnaireRow[], plans: Map<number, PlanSnapshot|null> }} input
 * @param {Set<string>} [acked] ids the user already acknowledged
 * @param {Map<string,string>} [dismissed] ids the boss ruled out, with the reason
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
 * How long the board waits before it declares the boss missing.
 *
 * The boss hands over on its own schedule: the duty cron runs every
 * `dutyIntervalMinutes`. The warning has to sit between two of those periods — any
 * shorter and a healthy boss trips it, any longer and a dead one stays quiet for half
 * an hour. The floor keeps a very fast duty from flapping the board.
 *
 * The duty period is a separate number from the board's own patrol interval on purpose:
 * mixing them up is how a 60-minute duty ends up flagged as "the boss went quiet" on
 * every single round.
 *
 * @param {number} dutyIntervalMinutes
 * @returns {number} minutes
 */
export function dutyStaleAfterMinutes(dutyIntervalMinutes) {
  const minutes = Number(dutyIntervalMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) return 45;
  return Math.max(Math.ceil(minutes * 1.5), 45);
}

/**
 * Whether the boss is actually watching, and what to say about it.
 *
 * A board that only prints "last patrol: 4 hours ago" cannot tell "nothing is wrong" from
 * "nobody is watching" — and those two look identical until you know the boss died. So the
 * duty state carries its own liveness verdict: a boss that has not filed a round in time is
 * `stale`, and the client says so in words instead of a timestamp.
 *
 * @param {{config:{lastRunAt:number|null,intervalMinutes:number,
 *                 dutyIntervalMinutes?:number},
 *          findings:Array<{acknowledged:boolean, acknowledgedBy?:string|null}>,
 *          dismissed?:Array<{id:string, reason?:string}>,
 *          now?:number}} input
 * @returns {{lastRunAt:number|null, intervalMinutes:number, dutyIntervalMinutes:number,
 *            findings:number, openFindings:number, withdrawn:number,
 *            dismissed:number, staleAfterMinutes:number, stale:boolean, neverRan:boolean,
 *            ageMinutes:number|null, missedRounds:number|null}}
 */
export function buildDutyStatus(input) {
  const config = input?.config ?? {};
  const findings = input?.findings ?? [];
  const dismissed = input?.dismissed ?? [];
  const now = input?.now ?? Date.now();
  const intervalMinutes = Number(config.intervalMinutes) > 0 ? Number(config.intervalMinutes) : 15;
  const dutyIntervalMinutes = Number(config.dutyIntervalMinutes) > 0 ? Number(config.dutyIntervalMinutes) : 30;
  const staleAfterMinutes = dutyStaleAfterMinutes(dutyIntervalMinutes);
  const lastRunAt = typeof config.lastRunAt === 'number' ? config.lastRunAt : null;
  const ageMinutes = lastRunAt === null ? null : Math.floor((now - lastRunAt) / 60_000);

  return {
    lastRunAt,
    intervalMinutes,
    dutyIntervalMinutes,
    findings: findings.length,
    openFindings: findings.filter((finding) => !finding.acknowledged).length,
    // Conclusions the boss retracted itself. They leave the attention list, so the board has
    // to say how many were withdrawn — otherwise the boss could quietly clear your desk.
    withdrawn: findings.filter((finding) => finding.acknowledgedBy === 'boss').length,
    // Raw runtime items the boss ruled out (a session error it proved is a leftover).
    dismissed: dismissed.length,
    staleAfterMinutes,
    stale: lastRunAt === null || ageMinutes > staleAfterMinutes,
    neverRan: lastRunAt === null,
    ageMinutes,
    // How many duty rounds were missed since the last handover. 0 means "on time".
    // This is what tells the boss that its previous round never landed, so it can
    // report the gap instead of silently carrying on as if nothing happened.
    missedRounds: ageMinutes === null ? null : Math.max(0, Math.ceil(ageMinutes / dutyIntervalMinutes) - 1),
  };
}

/**
 * Build the fact sheet the boss reasons over during a proactive patrol.
 *
 * The board owns the facts; the boss owns the judgment. This keeps the split honest — the
 * Mini App never decides what matters, it only reports what is true.
 *
 * @param {any} snapshot
 * @returns {string}
 */
export function buildPatrolBrief(snapshot) {
  const cards = snapshot?.cards ?? [];
  const inbox = snapshot?.inbox ?? [];
  const lines = [];

  lines.push('## 项目总览');
  if (cards.length === 0) lines.push('（没有可见项目）');
  for (const card of cards) {
    const active = card.goals.filter((g) => g.status === 'active').length;
    lines.push(
      `- ${card.name} | 状态 ${card.health} | 会话 ${card.sessionCount} | Goal ${active}/${card.goals.length}`
      + ` | 待决策 ${card.pendingQuestions} | 计划任务 ${card.planTasks.length}`,
    );
  }

  lines.push('');
  lines.push('## 待决策项');
  if (inbox.length === 0) lines.push('（没有待决策项）');
  for (const item of inbox) {
    lines.push(`- [${item.severity}] ${item.kind} | ${item.projectName} | ${item.title} | ${item.body}`);
  }

  const planLines = [];
  for (const card of cards) {
    for (const task of card.planTasks) {
      planLines.push(`- ${card.name} | ${task.state} | ${task.title} | 负责 ${task.assignedTo ?? '未指派'}`);
    }
  }
  if (planLines.length > 0) {
    lines.push('');
    lines.push('## 计划任务');
    lines.push(...planLines);
  }

  return lines.join('\n');
}

/**
 * Parse the boss's patrol report.
 *
 * The format is a convention, not a contract, so parsing is deliberately tolerant: an
 * unparseable reply still becomes one finding carrying the raw text.
 *
 * @param {string} text
 * @returns {{ conclusion: string, items: { projectName: string, severity: 'high'|'medium'|'low', summary: string }[],
 *             dispatches: { projectName: string, instruction: string }[],
 *             proposals: { projectName: string, sessionId: string|null, instruction: string }[] }}
 */
export function parsePatrolReport(text) {
  const result = { conclusion: '', items: [], dispatches: [], proposals: [] };
  if (!text) return result;

  let section = 'report';
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    const conclusion = /^巡检结论\s*[:：]\s*(.+)$/.exec(line);
    if (conclusion) {
      result.conclusion = conclusion[1].trim();
      continue;
    }
    if (/^(我已派工|已派工|已投递)\s*[:：]?$/.test(line)) {
      section = 'dispatch';
      continue;
    }
    if (/^(我建议派工|建议派工|待派工)\s*[:：]?$/.test(line)) {
      section = 'proposal';
      continue;
    }
    if (/^(需要大老板决策|待大老板决策|需你决策)\s*[:：]?$/.test(line)) {
      section = 'report';
      continue;
    }

    const item = /^-\s*项目\s*[:：]\s*(.+?)\s*\|\s*级别\s*[:：]\s*(high|medium|low)\s*\|\s*摘要\s*[:：]\s*(.+)$/.exec(line);
    if (item) {
      result.items.push({
        projectName: item[1].trim(),
        severity: /** @type {'high'|'medium'|'low'} */ (item[2]),
        summary: item[3].trim(),
      });
      continue;
    }

    const proposal = /^-\s*项目\s*[:：]\s*(.+?)\s*\|\s*会话\s*[:：]\s*(.+?)\s*\|\s*指令\s*[:：]\s*(.+)$/.exec(line);
    if (proposal) {
      const session = proposal[2].trim();
      result.proposals.push({
        projectName: proposal[1].trim(),
        sessionId: session && session !== '无' && session !== '-' ? session : null,
        instruction: proposal[3].trim(),
      });
      continue;
    }

    if (section === 'dispatch') {
      const dispatch = /^-\s*(.+?)\s*[:：]\s*(.+)$/.exec(line);
      if (dispatch) {
        result.dispatches.push({ projectName: dispatch[1].trim(), instruction: dispatch[2].trim() });
      }
    }
  }

  return result;
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
 * Extract the answerable shape of a questionnaire: its step ids, question text and options.
 *
 * Options carry a `recommended` flag, which is exactly the "推荐答案" the boss should prefer.
 *
 * @param {string} requestJson
 * @returns {{ stepIds: string[], options: { id: string, label: string, recommended: boolean }[] }}
 */
export function questionnaireShape(requestJson) {
  const empty = { stepIds: [], options: [] };
  let parsed;
  try {
    parsed = JSON.parse(requestJson);
  } catch {
    return empty;
  }
  const steps = Array.isArray(parsed?.steps) ? parsed.steps : [];
  const stepIds = steps.map((step) => step?.id).filter((id) => typeof id === 'string');
  const options = steps
    .flatMap((step) => (Array.isArray(step?.options) ? step.options : []))
    .map((option) => ({
      id: option?.id ?? '',
      label: option?.label ?? '',
      recommended: option?.recommended === true,
    }))
    .filter((option) => option.id);
  return { stepIds, options };
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
