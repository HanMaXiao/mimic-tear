import {
  buildDutyStatus,
  buildInbox,
  buildKpi,
  buildOrgTree,
  buildPatrolBrief,
  buildProjectCards,
  parsePatrolReport,
  questionnaireShape,
  withDutyCards,
} from './view-model.mjs';
import { buildDutyRounds } from './duty-rounds.mjs';
import { DutyIntent } from './duty-intent.mjs';
import { ManagedProjects } from './managed-projects.mjs';
import { readAlerts } from './watchdog-alerts.mjs';

/**
 * The single domain service of the Mini App.
 *
 * Every read aggregates the runtime state; every write goes through this class. The Host
 * routes (HTTP, MCP, background refresh) all call into it, so there is exactly one place
 * where a business mutation is validated, committed and handed back for broadcast.
 */

/** How often the skill library is re-scanned so newly installed skills show up. */
const SKILL_REFRESH_MS = 10 * 60 * 1000;

/** A business error with an HTTP status and a stable machine code. */export class DomainError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {number} [status]
   */
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Runtime-internal workspaces.
 *
 * The runtime registers a workspace for every agent's default directory and for every
 * installed Mini App. Those are plumbing, not the user's projects, and listing them as
 * "workspace" rows makes the board look broken. They are filtered out and counted so the
 * page can say how many were hidden instead of silently dropping them.
 */
const INTERNAL_WORKSPACE = /[\\/]\.(?:minimax|mavis)[\\/](?:agents[\\/][^\\/]+[\\/](?:workspace|miniapps)|workspace)([\\/]|$)/i;

/**
 * @param {string} workspaceDir
 * @returns {boolean}
 */
export function isInternalWorkspace(workspaceDir) {
  return Boolean(workspaceDir) && INTERNAL_WORKSPACE.test(workspaceDir);
}

export class ProjectService {
  /**
   * @param {{
   *   store: import('./runtime-store.mjs').RuntimeStore,
   *   readPlan: (dir: string) => Promise<any>,
   *   skills: { skills: any[], failures: any[] },
   *   domains: any[],
   *   persistence: import('./persistence.mjs').Persistence,
   *   boss: { dispatch: (input: any) => Promise<any>, patrol: (input: any) => Promise<any> },
   *   patrol?: import('./patrol-store.mjs').PatrolStore,
   *   dutyIntent?: import('./duty-intent.mjs').DutyIntent,
   *   managed?: import('./managed-projects.mjs').ManagedProjects,
   *   refreshSkills?: () => Promise<{ skills: any[], failures: any[] }>,
   * }} deps
   */
  constructor(deps) {
    this.store = deps.store;
    this.readPlan = deps.readPlan;
    this.skillScan = deps.skills;
    this.domains = deps.domains;
    this.persistence = deps.persistence;
    this.boss = deps.boss;
    this.patrol = deps.patrol ?? null;
    // The duty intent and the jurisdiction list live in the same directory as the duty
    // config, so they are found next to it rather than injected twice.
    const sharedDir = deps.patrol?.dataDir ?? deps.dutyIntent?.dataDir ?? null;
    this.dutyIntent = deps.dutyIntent ?? (sharedDir ? new DutyIntent(sharedDir) : null);
    this.managed = deps.managed ?? (sharedDir ? new ManagedProjects(sharedDir) : null);
    this.refreshSkills = deps.refreshSkills ?? null;
    this.skillsScannedAt = Date.now();

    /** Cached aggregate, invalidated by the runtime revision. */
    this.cache = null;
  }

  /**
   * The duty state: the facts, the decision that was made, and what the boss watches.
   *
   * The duty intent is deliberately not part of the runtime revision: a user who tells the
   * boss to rest has to see the board change right away, not on the next unrelated session
   * event. So the duty state is read fresh on every call and stamped onto the cards on the
   * way out — the cached snapshot stays a snapshot.
   *
   * @param {{config?:any, findings?:any[], dismissed?:any[]}} [input]
   * @returns {Promise<any>}
   */
  async dutyBlock(input = {}) {
    const [intent, managedEntries] = await Promise.all([
      this.dutyIntent ? this.dutyIntent.read() : null,
      this.managed ? this.managed.list() : [],
    ]);
    const watching = new Set(managedEntries.map((entry) => entry.name));
    const duty = buildDutyStatus({
      config: input.config ?? await this.getPatrolConfig(),
      findings: input.findings ?? [],
      dismissed: input.dismissed ?? [],
      intent,
      now: Date.now(),
    });
    return { ...duty, watching: [...watching] };
  }

  /**
   * The current duty intent — what the boss was told to do, and by whom.
   *
   * @returns {Promise<{ intent: any, duty: any }>}
   */
  async getDutyIntent() {
    const [intent, duty] = await Promise.all([
      this.dutyIntent ? this.dutyIntent.read() : null,
      this.dutyBlock(),
    ]);
    return { intent, duty };
  }

  /**
   * Record the decision about the boss's duty.
   *
   * "Resting" is a decision with a reason, not a switch somebody flipped: the intent keeps
   * who asked for it and since when, so the board can say *why* the boss is off duty.
   *
   * @param {{mode?:string, requestedBy?:string, note?:string}} input
   * @returns {Promise<{ intent: any, duty: any }>}
   */
  async setDutyIntent(input = {}) {
    if (!this.dutyIntent) {
      throw new DomainError('duty_intent_unavailable', '当前运行时没有值班意图通道', 501);
    }
    const mode = input?.mode === 'resting' ? 'resting' : 'on-duty';
    const requestedBy = typeof input?.requestedBy === 'string' && input.requestedBy.trim()
      ? input.requestedBy.trim()
      : null;
    const note = typeof input?.note === 'string' ? input.note : '';
    const intent = await this.dutyIntent.setMode(mode, { requestedBy, note });
    return { intent, duty: await this.dutyBlock() };
  }

  /**
   * The boss's proactive patrol settings.
   * @returns {Promise<any>}
   */
  async getPatrolConfig() {
    if (!this.patrol) {
      return {
        enabled: false,
        intervalMinutes: 15,
        dutyIntervalMinutes: 30,
        lastRunAt: null,
        lastBoardPatrolAt: null,
        lastSignature: null,
      };
    }
    return this.patrol.getConfig();
  }

  /**
   * The duty rounds, grouped for the conversation.
   *
   * The duty boss runs on its own cron session, so the Host chat side panel (which shows
   * one session) never shows the rounds. These are the rounds the user wants to see.
   *
   * @param {{ limit?:number }} [options]
   * @returns {Promise<import('./duty-rounds.mjs').DutyRound[]>}
   */
  async getDutyRounds(options = {}) {
    if (!this.patrol) return [];
    const findings = await this.patrol.list();
    return buildDutyRounds(findings, { limit: options.limit ?? 20 });
  }

  /**
   * The watchdog's alert log — the channel that survives a closed board.
   *
   * The file is written whether or not the notification landed, so it is the only record of
   * what the watchdog saw while nobody was looking. The board reads it back and shows the
   * last few entries.
   *
   * @param {{ limit?:number }} [options]
   * @returns {Promise<{ alerts: import('./watchdog-alerts.mjs').AlertRecord[] }>}
   */
  async getWatchdogAlerts(options = {}) {
    const dir = this.patrol?.dataDir ?? null;
    if (!dir) return { alerts: [] };
    return { alerts: await readAlerts(dir, options.limit ?? 20) };
  }

  /**
   * The boss's conversation, read back from the runtime.
   *
   * The transcript is the Host's, not the Mini App's: the same session shows up in the
   * Host chat side panel and here. Reading it back is what lets the Mini App show what was
   * said in the side panel — and what makes the transcript survive a page reload.
   *
   * @returns {Promise<Array<{id:string, role:string, text:string, source:string, createdAt:number}>>}
   */
  async getChatHistory() {
    const stored = await this.persistence.getBossSession();
    if (!stored?.sessionId) return [];
    const messages = this.store.listSessionMessages(stored.sessionId);
    // The boss's own turns are the interesting half; the user's side is already on screen.
    return messages;
  }

  /**
   * How many messages the boss's session holds.
   *
   * The count is the cheap change detector: when it moves, something was said — in the
   * Mini App or in the Host chat side panel.
   *
   * @returns {Promise<number>}
   */
  async getChatMessageCount() {
    const stored = await this.persistence.getBossSession();
    if (!stored?.sessionId) return 0;
    return this.store.countSessionMessages(stored.sessionId);
  }

  /**
   * Update the boss's proactive patrol settings.
   * @param {{ enabled?: boolean, intervalMinutes?: number }} patch
   */
  async setPatrolConfig(patch) {
    if (!this.patrol) {
      throw new DomainError('patrol_unavailable', '当前部署不支持主动巡检', 501);
    }
    return this.patrol.setConfig(patch ?? {});
  }

  /**
   * Run one proactive patrol and record what the boss found.
   *
   * The board supplies the facts; the boss supplies the judgment. Findings are persisted so
   * a patrol that ran while the board was closed still shows up when it reopens.
   */
  async runPatrol() {
    if (!this.patrol) {
      throw new DomainError('patrol_unavailable', '当前部署不支持主动巡检', 501);
    }

    const snapshot = await this.snapshot();
    const brief = buildPatrolBrief(snapshot);
    const config = await this.patrol.getConfig();

    // Unique per run, so a repeated patrol never re-delivers the same proposal.
    this.patrolRunKey = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    const outcome = await this.boss.patrol({ brief });

    const report = parsePatrolReport(outcome.text);
    /** @type {any[]} */
    const findings = [];

    for (const item of report.items) {
      const card = snapshot.cards.find((c) => c.name === item.projectName);
      findings.push({
        projectId: card?.id ?? null,
        projectName: item.projectName,
        severity: item.severity,
        title: item.summary.length > 60 ? `${item.summary.slice(0, 60)}…` : item.summary,
        body: item.summary,
      });
    }

    if (findings.length === 0) {
      // Nothing parsed: keep the raw reply as a single finding so the patrol is never silent.
      findings.push({
        projectId: null,
        projectName: null,
        severity: 'medium',
        title: report.conclusion || '大哥巡检结论',
        body: outcome.text || outcome.error || '本轮巡检没有产生结论。',
      });
    }

    const created = [];
    for (const finding of findings) {
      created.push(await this.patrol.add(finding));
    }

    // The boss proposes; the board dispatches. Whether to propose at all is the boss's own
    // judgement — there is no switch that turns dispatching on or off. Proposals go through
    // the same validated path as a manual dispatch, so a project or session the boss named
    // wrongly is rejected here instead of being delivered.
    const executed = [];
    for (const [index, proposal] of report.proposals.entries()) {
      const card = snapshot.cards.find((c) => c.name === proposal.projectName);
      if (!card) {
        executed.push({ proposal, ok: false, error: `找不到项目 ${proposal.projectName}` });
        continue;
      }
      try {
        const { record } = await this.prepareDispatch({
          projectId: card.id,
          sessionId: proposal.sessionId,
          instruction: proposal.instruction,
          idempotencyKey: `patrol:${this.patrolRunKey}:${index}`,
        });
        const result = await this.runDispatch(record);
        executed.push({ proposal, ok: result.delivered, error: result.error });
      } catch (error) {
        executed.push({ proposal, ok: false, error: error?.message ?? String(error) });
      }
    }

    // The board's own patrol stamp. Deliberately NOT lastRunAt: that one means "the duty
    // boss handed over", and a board-triggered patrol must never be able to refresh it —
    // otherwise a dead duty boss still shows as "on duty" for another threshold window.
    await this.patrol.setConfig({
      lastBoardPatrolAt: Date.now(),
      lastSignature: this.inboxSignature(snapshot),
    });

    return {
      runAt: Date.now(),
      conclusion: report.conclusion,
      dispatches: report.dispatches,
      proposals: report.proposals,
      executed,
      findings: created,
      error: outcome.error,
    };
  }

  /**
   * One conversation turn with the boss.
   *
   * This is the board's front door: the user talks to the boss the way they talk to any
   * other agent. The turn runs on the boss's own session, so the conversation and the duty
   * rounds share one memory — which is what makes "I can see what the boss is doing" true.
   *
   * @param {string} text
   * @param {(event: any) => void} [onEvent] receives the runtime's run events
   * @returns {Promise<any>}
   */
  async chat(text, onEvent) {
    if (!this.boss) {
      throw new DomainError('chat_unavailable', '当前运行时未开放 agent 能力，无法对话', 501);
    }
    const outcome = await this.boss.chat({ text }, onEvent);
    this.cache = null;
    return outcome;
  }

  /**
   * Answer a question the boss paused on, and let its turn continue.
   *
   * @param {{ requestId: string, answers: any[], sessionId?: string }} input
   * @param {(event: any) => void} [onEvent]
   * @returns {Promise<any>}
   */
  async answerChatQuestion(input, onEvent) {
    if (!this.boss) {
      throw new DomainError('chat_unavailable', '当前运行时未开放 agent 能力，无法对话', 501);
    }
    const outcome = await this.boss.answerQuestion(input, onEvent);
    this.cache = null;
    return outcome;
  }

  /**
   * A cheap signature of the decision-relevant state, used to decide whether a patrol run
   * would have anything new to look at.
   * @param {any} [snapshot]
   */
  inboxSignature(snapshot) {
    const state = snapshot ?? this.cache;
    if (!state) return 'empty';
    return JSON.stringify(state.inbox.map((item) => [item.id, item.severity, item.title]));
  }

  /**
   * Everything the overview needs: KPI, project cards and the attention list.
   * @returns {Promise<import('./view-model.mjs').Overview>}
   */
  async getOverview() {
    const snapshot = await this.snapshot();
    const inbox = await this.collectInbox(snapshot);
    const patrolConfig = await this.getPatrolConfig();
    const findings = this.patrol ? await this.patrol.list() : [];
    const dismissed = await this.persistence.listDismissed();
    const duty = await this.dutyBlock({ config: patrolConfig, findings, dismissed });
    // The alert log rides along with the duty state: one line on the overview can say
    // "the boss went quiet at 03:20" without the user having to open the log.
    const alerts = await this.getWatchdogAlerts({ limit: 3 });
    return {
      generatedAt: Date.now(),
      kpi: buildKpi(snapshot.cards, inbox),
      // The cards carry the duty state: a project says whether the boss watches it, and
      // whether the boss is on duty at all.
      projects: withDutyCards(snapshot.cards, duty, duty.watching),
      // Acknowledged items are known already: showing them here would make the count
      // disagree with the KPI and the inbox badge.
      attention: inbox.filter((item) => item.severity !== 'low' && !item.acknowledged),
      internalProjectCount: snapshot.internalProjectCount,
      dataWarning: snapshot.dataWarning,
      // Whether the boss is on duty, when it last reported, and whether it has gone quiet.
      duty: { ...duty, alerts: alerts.alerts },
    };
  }

  /**
   * The decision inbox: runtime items plus whatever the boss's patrol found.
   *
   * The overview and the inbox page must read from the SAME list, otherwise the badge
   * count and the page content disagree.
   *
   * @param {any} snapshot
   * @returns {Promise<any[]>}
   */
  async collectInbox(snapshot) {
    const runtimeItems = snapshot.inbox;

    const patrolItems = this.patrol
      ? (await this.patrol.list()).map((finding) => ({
        id: `patrol:${finding.id}`,
        kind: 'patrol',
        severity: finding.severity,
        projectId: finding.projectId ?? 0,
        projectName: finding.projectName ?? '全局',
        sessionId: null,
        sessionTitle: null,
        title: finding.title,
        body: finding.body,
        createdAt: finding.createdAt,
        ageMinutes: ageInMinutes(finding.createdAt),
        acknowledged: finding.acknowledged,
        // 'user' = 大老板点过「标记已知」；'boss' = 大哥撤回了自己的结论（已不适用）。
        handledBy: finding.acknowledgedBy ?? null,
        handledReason: finding.note ?? '',
      }))
      : [];

    // A pending question carries its answerable shape plus whatever the boss already decided,
    // so the page can offer "answer with the boss's choice" instead of a bare toast.
    const answered = this.patrol ? await this.patrol.listAnswered() : [];
    const answeredByRequest = new Map(answered.map((entry) => [entry.requestId, entry]));

    const items = [...patrolItems, ...runtimeItems].map((item) => {
      if (item.kind !== 'questionnaire') return item;
      const shape = questionnaireShape(item.requestJson ?? '');
      const decision = answeredByRequest.get(item.requestId);
      return {
        ...item,
        requestId: item.requestId,
        stepIds: shape.stepIds,
        options: shape.options,
        recommendation: decision
          ? {
            optionIds: decision.optionIds ?? [],
            answer: decision.answer ?? '',
            rationale: decision.rationale ?? '',
            decidedAt: decision.answeredAt,
          }
          : null,
      };
    });

    items.sort((a, b) => {
      const order = { high: 0, medium: 1, low: 2 };
      const bySeverity = order[a.severity] - order[b.severity];
      if (bySeverity !== 0) return bySeverity;
      return b.createdAt - a.createdAt;
    });
    return items;
  }

  /**
   * The decision inbox.
   * @returns {Promise<{ items: any[] }>}
   */
  async getInbox() {
    const snapshot = await this.snapshot();
    return { items: await this.collectInbox(snapshot) };
  }

  /** @returns {Promise<{ projects: any[] }>} */
  async getProjects() {
    const snapshot = await this.snapshot();
    const duty = await this.dutyBlock();
    return { projects: withDutyCards(snapshot.cards, duty, duty.watching) };
  }

  /**
   * Full detail of one project: org tree, goals, questions, tasks and plan.
   * @param {number} id
   * @returns {Promise<any | null>}
   */
  async getProject(id) {
    const snapshot = await this.snapshot();
    const card = snapshot.cards.find((c) => c.id === id);
    if (!card) return null;

    const sessions = snapshot.sessions.filter((s) => s.projectId === id);
    const sessionIds = new Set(sessions.map((s) => s.id));
    const goals = snapshot.goals.filter((g) => sessionIds.has(g.sessionId));
    const questions = snapshot.questionnaires.filter((q) => sessionIds.has(q.sessionId));
    const plan = snapshot.plans.get(id) ?? null;
    const duty = await this.dutyBlock();

    return {
      project: withDutyCards([card], duty, duty.watching)[0],
      orgTree: buildOrgTree(sessions),
      goals,
      questions,
      tasks: snapshot.tasks.filter((t) => sessionIds.has(t.ownerSessionId)),
      plan,
      duty,
    };
  }

  /**
   * The capability library: what the boss knows and can schedule.
   *
   * The scan is refreshed periodically — a snapshot taken at startup would never show a skill
   * installed later, and the boss's knowledge is exactly what changes when you install one.
   *
   * @returns {Promise<{ groups: any[], unmapped: any[], total: number, failures: number, scannedAt: number }>}
   */
  async getSkills() {
    const { classify } = await import('./skill-catalog.mjs');
    await this.#refreshSkillsIfStale();
    const { groups, unmapped } = classify(this.skillScan.skills, this.domains);
    return {
      groups,
      unmapped,
      total: this.skillScan.skills.length,
      failures: this.skillScan.failures.length,
      scannedAt: this.skillsScannedAt,
    };
  }

  /**
   * Re-scan the skill libraries when the snapshot is older than the refresh window.
   */
  async #refreshSkillsIfStale() {
    if (!this.refreshSkills) return;
    const age = Date.now() - (this.skillsScannedAt ?? 0);
    if (age < SKILL_REFRESH_MS) return;
    this.skillScan = await this.refreshSkills();
    this.skillsScannedAt = Date.now();
  }

  /**
   * Acknowledge an inbox item so it stops counting as a pending decision.
   * @param {string} itemId
   * @returns {Promise<{ ok: boolean }>}
   */
  async ack(itemId) {
    if (!itemId || typeof itemId !== 'string') {
      throw new DomainError('invalid_item_id', '缺少收件箱条目 ID');
    }
    if (itemId.startsWith('patrol:')) {
      if (!this.patrol) {
        throw new DomainError('patrol_unavailable', '当前部署不支持主动巡检', 501);
      }
      const found = await this.patrol.ack(itemId.slice('patrol:'.length));
      this.cache = null;
      return { ok: found };
    }
    await this.persistence.addAck(itemId);
    this.cache = null;
    return { ok: true };
  }

  /**
   * Send an instruction to a project.
   *
   * The idempotency key makes a repeated submission a no-op: the same key never reaches the
   * target session twice.
   *
   * @param {{ projectId:number, sessionId:string|null, instruction:string, idempotencyKey:string }} input
   * @returns {Promise<any>}
   */
  async dispatch(input) {
    const { record, duplicate } = await this.prepareDispatch(input);
    if (duplicate) {
      return {
        dispatchId: record.id,
        status: record.status,
        bossSessionId: record.bossSessionId,
        text: record.text,
        error: record.error,
        delivered: record.status === 'done',
        duplicate: true,
      };
    }
    return this.runDispatch(record);
  }

  /**
   * Validate a dispatch and persist it as `queued`, without contacting the boss yet.
   *
   * Splitting preparation from execution lets the page get an id immediately and watch the
   * outcome over SSE, instead of holding an HTTP request open for a whole agent turn.
   *
   * @param {{ projectId:number, sessionId:string|null, instruction:string, idempotencyKey:string }} input
   * @returns {Promise<{ record: any, duplicate: boolean }>}
   */
  async prepareDispatch(input) {
    const projectId = Number(input?.projectId);
    const instruction = typeof input?.instruction === 'string' ? input.instruction.trim() : '';
    const idempotencyKey = typeof input?.idempotencyKey === 'string' ? input.idempotencyKey.trim() : '';

    if (!Number.isFinite(projectId)) {
      throw new DomainError('invalid_project_id', '缺少有效的项目 ID');
    }
    if (!instruction) {
      throw new DomainError('empty_instruction', '下达的指令不能为空');
    }
    if (!idempotencyKey) {
      throw new DomainError('missing_idempotency_key', '缺少幂等键');
    }

    const existing = await this.persistence.findDispatchByKey(idempotencyKey);
    if (existing) return { record: existing, duplicate: true };

    const snapshot = await this.snapshot();
    const card = snapshot.cards.find((c) => c.id === projectId);
    if (!card) {
      throw new DomainError('unknown_project', '项目不存在或不可见', 404);
    }

    const targetSessionId = input.sessionId ?? null;
    const targetSession = targetSessionId
      ? snapshot.sessions.find((s) => s.id === targetSessionId && s.projectId === projectId)
      : null;
    if (targetSessionId && !targetSession) {
      throw new DomainError('unknown_session', '目标会话不存在或不属于该项目', 404);
    }

    const now = Date.now();
    const record = {
      id: `dsp_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      idempotencyKey,
      projectId,
      projectName: card.name,
      targetSessionId,
      instruction,
      status: 'queued',
      bossSessionId: null,
      text: '',
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.persistence.saveDispatch(record);
    return { record, duplicate: false };
  }

  /**
   * Hand a prepared dispatch to the boss and record the outcome.
   * @param {any} record
   * @returns {Promise<any>}
   */
  async runDispatch(record) {
    const snapshot = await this.snapshot();
    const card = snapshot.cards.find((c) => c.id === record.projectId);
    const targetSession = record.targetSessionId
      ? snapshot.sessions.find((s) => s.id === record.targetSessionId)
      : null;

    record.status = 'running';
    record.updatedAt = Date.now();
    await this.persistence.saveDispatch(record);

    let outcome;
    try {
      outcome = await this.boss.dispatch({
        projectId: record.projectId,
        projectName: card?.name ?? record.projectName,
        projectPath: card?.path ?? '',
        sessionId: targetSession?.id ?? null,
        sessionTitle: targetSession?.title ?? null,
        instruction: record.instruction,
      });
    } catch (error) {
      record.status = 'error';
      record.error = error?.message ?? String(error);
      record.updatedAt = Date.now();
      await this.persistence.saveDispatch(record);
      return {
        dispatchId: record.id,
        status: 'error',
        bossSessionId: null,
        text: '',
        error: record.error,
        delivered: false,
        duplicate: false,
      };
    }

    record.status = outcome?.delivered ? 'done' : 'error';
    record.bossSessionId = outcome?.bossSessionId ?? null;
    record.text = outcome?.text ?? '';
    record.error = outcome?.error ?? null;
    record.updatedAt = Date.now();
    await this.persistence.saveDispatch(record);

    return {
      dispatchId: record.id,
      status: record.status,
      bossSessionId: record.bossSessionId,
      text: record.text,
      error: record.error,
      delivered: Boolean(outcome?.delivered),
      duplicate: false,
    };
  }

  /**
   * A single dispatch record.
   * @param {string} id
   */
  async getDispatch(id) {
    const all = await this.persistence.listDispatches();
    return all.find((d) => d.id === id) ?? null;
  }

  /**
   * The runtime revision the current snapshot was built from.
   * @returns {string}
   */
  currentRevision() {
    return this.store.revision();
  }

  /**
   * Aggregate the runtime state, reusing the cached result while the runtime revision holds.
   */
  async snapshot() {
    const revision = this.store.revision();
    if (this.cache && this.cache.revision === revision) return this.cache;

    const projects = this.store.listProjects();
    const visibleProjects = projects.filter((p) => !isInternalWorkspace(p.workspaceDir));
    const visibleIds = new Set(visibleProjects.map((p) => p.id));
    const allSessions = this.store.listSessions();
    const sessions = allSessions.filter((s) => visibleIds.has(s.projectId));
    const goals = this.store.listGoals();
    const questionnaires = this.store.listQuestionnaires(false);
    const tasks = this.store.listActiveTasks();

    const plans = new Map();
    await Promise.all(visibleProjects.map(async (project) => {
      try {
        plans.set(project.id, await this.readPlan(project.workspaceDir));
      } catch {
        plans.set(project.id, null);
      }
    }));

    const acks = new Set(await this.persistence.listAcks());
    // Items the boss ruled out, with the reason. They leave the attention list but the
    // reason travels with them, so nothing ever leaves the desk silently.
    const dismissed = new Map(
      (await this.persistence.listDismissed()).map((entry) => [entry.id, entry.reason ?? '']),
    );
    const cards = buildProjectCards({ projects: visibleProjects, sessions, goals, questionnaires, plans });
    const inbox = buildInbox(
      { projects: visibleProjects, sessions, goals, questionnaires, plans },
      acks,
      dismissed,
    );

    this.cache = {
      revision,
      projects: visibleProjects,
      sessions,
      goals,
      questionnaires,
      tasks,
      plans,
      cards,
      inbox,
      internalProjectCount: projects.length - visibleProjects.length,
      dataWarning: this.store.lastError(),
    };
    return this.cache;
  }
}

function ageInMinutes(timestamp) {
  if (!timestamp) return 0;
  return Math.max(0, Math.round((Date.now() - timestamp) / 60000));
}