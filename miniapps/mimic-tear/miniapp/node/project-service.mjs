import {
  buildInbox,
  buildKpi,
  buildOrgTree,
  buildProjectCards,
} from './view-model.mjs';

/**
 * The single domain service of the Mini App.
 *
 * Every read aggregates the runtime state; every write goes through this class. The Host
 * routes (HTTP, MCP, background refresh) all call into it, so there is exactly one place
 * where a business mutation is validated, committed and handed back for broadcast.
 */

/** A business error with an HTTP status and a stable machine code. */
export class DomainError extends Error {
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
   *   boss: { dispatch: (input: any) => Promise<any> },
   * }} deps
   */
  constructor(deps) {
    this.store = deps.store;
    this.readPlan = deps.readPlan;
    this.skillScan = deps.skills;
    this.domains = deps.domains;
    this.persistence = deps.persistence;
    this.boss = deps.boss;

    /** Cached aggregate, invalidated by the runtime revision. */
    this.cache = null;
  }

  /**
   * Everything the overview needs: KPI, project cards and the attention list.
   * @returns {Promise<import('./view-model.mjs').Overview>}
   */
  async getOverview() {
    const snapshot = await this.snapshot();
    return {
      generatedAt: Date.now(),
      kpi: buildKpi(snapshot.cards, snapshot.inbox),
      projects: snapshot.cards,
      // Acknowledged items are known already: showing them here would make the count
      // disagree with the KPI and the inbox badge.
      attention: snapshot.inbox.filter((item) => item.severity !== 'low' && !item.acknowledged),
      internalProjectCount: snapshot.internalProjectCount,
      dataWarning: snapshot.dataWarning,
    };
  }

  /** @returns {Promise<{ items: any[] }>} */
  async getInbox() {
    const snapshot = await this.snapshot();
    return { items: snapshot.inbox };
  }

  /** @returns {Promise<{ projects: any[] }>} */
  async getProjects() {
    const snapshot = await this.snapshot();
    return { projects: snapshot.cards };
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

    return {
      project: card,
      orgTree: buildOrgTree(sessions),
      goals,
      questions,
      tasks: snapshot.tasks.filter((t) => sessionIds.has(t.ownerSessionId)),
      plan,
    };
  }

  /**
   * The capability library: what the boss knows and can schedule.
   * @returns {Promise<{ groups: any[], unmapped: any[], total: number, failures: number }>}
   */
  async getSkills() {
    const { classify } = await import('./skill-catalog.mjs');
    const { groups, unmapped } = classify(this.skillScan.skills, this.domains);
    return {
      groups,
      unmapped,
      total: this.skillScan.skills.length,
      failures: this.skillScan.failures.length,
    };
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
    const cards = buildProjectCards({ projects: visibleProjects, sessions, goals, questionnaires, plans });
    const inbox = buildInbox({ projects: visibleProjects, sessions, goals, questionnaires, plans }, acks);

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
