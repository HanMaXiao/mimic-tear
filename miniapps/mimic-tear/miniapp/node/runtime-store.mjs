import { DatabaseSync } from 'node:sqlite';

/**
 * Read-only access model over the MiniMax Code runtime state database.
 *
 * The database is owned by the running runtime; this class NEVER opens it for writing.
 * Every read method degrades to an empty result and records the reason in `lastError()`
 * instead of throwing, so a missing or locked database can never break the page.
 */

/** Terminal states for background tasks. Anything else is considered in-flight. */
const TASK_TERMINAL_STATES = ['succeeded', 'failed', 'canceled'];

const PROJECT_SQL = `
  SELECT project_id, project_kind, workspace_dir, pinned, hidden, order_index,
         recent_at_ms, latest_activity_at_ms, session_count
    FROM local_runtime_projects
   WHERE workspace_dir IS NOT NULL AND hidden = 0
   ORDER BY COALESCE(latest_activity_at_ms, 0) DESC, project_id ASC
`;

const SESSION_SQL = `
  SELECT session_id, agent_name, status, title, workspace_dir, purpose, purpose_kind,
         parent_session_id, session_type, session_kind, origin_cron_id, visibility,
         created_at_ms, updated_at_ms, error_code, error_message, project_id
    FROM local_runtime_sessions
   WHERE archived = 0
`;

const GOAL_SQL = `
  SELECT goal_id, session_id, objective, status, created_at_ms, updated_at_ms,
         tokens_used, time_used_seconds, status_reason, last_verification, dismissed_at_ms
    FROM local_runtime_thread_goals
   ORDER BY updated_at_ms DESC
`;

const QUESTIONNAIRE_SQL = `
  SELECT request_id, session_id, agent_name, request_json, status, created_at
    FROM questionnaire_requests
`;

const TASK_SQL = `
  SELECT task_id, owner_session_id, kind, status, created_at_ms, updated_at_ms, ended_at_ms
    FROM local_runtime_background_tasks
`;

const REVISION_SQL = `
  SELECT
    (SELECT COUNT(*) FROM local_runtime_sessions WHERE archived = 0) AS session_count,
    (SELECT COUNT(*) FROM local_runtime_sessions WHERE archived = 0 AND status = 'started') AS running_sessions,
    (SELECT COUNT(*) FROM local_runtime_sessions WHERE archived = 0 AND status = 'error') AS errored_sessions,
    (SELECT COALESCE(MAX(updated_at_ms), 0) FROM local_runtime_sessions) AS session_max,
    (SELECT COUNT(*) FROM questionnaire_requests WHERE status NOT IN ('answered', 'dismissed')) AS pending_questions,
    (SELECT COALESCE(MAX(created_at), 0) FROM questionnaire_requests) AS question_max,
    (SELECT COUNT(*) FROM local_runtime_thread_goals) AS goal_count,
    (SELECT COALESCE(MAX(updated_at_ms), 0) FROM local_runtime_thread_goals) AS goal_max,
    (SELECT COUNT(*) FROM local_runtime_background_tasks WHERE status NOT IN ('succeeded', 'failed', 'canceled')) AS active_tasks,
    (SELECT COUNT(*) FROM local_runtime_projects WHERE workspace_dir IS NOT NULL AND hidden = 0) AS project_count,
    (SELECT COALESCE(MAX(latest_activity_at_ms), 0) FROM local_runtime_projects) AS project_max
`;

/**
 * Conversation rows for one session.
 *
 * The transcript lives in the runtime database, not in the Mini App. That is what makes the
 * Host chat side panel and the Mini App two views of one thread: the panel shows the same
 * session, and the Mini App can read back what was said there.
 */
const MESSAGE_SQL = `
  SELECT msg_id, role, turn_id, created_at_ms, data_json, source
    FROM local_runtime_message_rows
   WHERE session_id = ?
   ORDER BY created_at_ms ASC
`;

/**
 * Pull the readable text out of a stored message payload.
 *
 * The payload is JSON with the body under `msg_content`, but a malformed row must not
 * take the whole transcript down — an unreadable message becomes an empty one.
 *
 * @param {unknown} dataJson
 * @returns {string}
 */
function extractMessageText(dataJson) {
  if (typeof dataJson !== 'string' || !dataJson) return '';
  try {
    const parsed = JSON.parse(dataJson);
    if (parsed && typeof parsed.msg_content === 'string') return parsed.msg_content;
    if (parsed && typeof parsed.content === 'string') return parsed.content;
    if (typeof parsed === 'string') return parsed;
    return '';
  } catch {
    return '';
  }
}

export class RuntimeStore {
  /** @type {DatabaseSync | null} */
  #db = null;
  /** @type {string | null} */
  #error = null;

  /**
   * @param {string} dbPath absolute path of the runtime state database
   */
  static open(dbPath) {
    const store = new RuntimeStore();
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      // node:sqlite opens lazily: a file that exists but is not a SQLite database only
      // fails on the first real statement. Force a schema read here so `isAvailable()`
      // reflects reality instead of a merely successful file open.
      db.prepare('SELECT count(*) AS c FROM sqlite_master').get();
      store.#db = db;
    } catch (error) {
      store.#error = `无法打开运行时状态库：${error?.message ?? String(error)}（路径：${dbPath}）`;
    }
    return store;
  }

  close() {
    try {
      this.#db?.close();
    } catch {
      /* already closed */
    }
    this.#db = null;
  }

  /** True when the database was opened successfully. */
  isAvailable() {
    return this.#db !== null;
  }

  /** Last failure reason, or null. Surfaced to the page as a data warning. */
  lastError() {
    return this.#error;
  }

  /**
   * Cheap change detector. Compared against the previous value to decide whether the
   * aggregated snapshot needs to be rebuilt and broadcast.
   */
  revision() {
    if (!this.#db) return 'unavailable';
    try {
      const row = this.#db.prepare(REVISION_SQL).get();
      return [
        row.session_count, row.running_sessions, row.errored_sessions, row.session_max,
        row.pending_questions, row.question_max, row.goal_count, row.goal_max, row.active_tasks,
        row.project_count, row.project_max,
      ].join('.');
    } catch (error) {
      this.#error = `读取运行时状态失败：${error?.message ?? String(error)}`;
      return 'error';
    }
  }

  listProjects() {
    return this.#query(PROJECT_SQL, [], (row) => ({
      id: row.project_id,
      kind: row.project_kind,
      workspaceDir: row.workspace_dir,
      pinned: row.pinned === 1,
      hidden: row.hidden === 1,
      orderIndex: row.order_index,
      recentAt: row.recent_at_ms,
      latestActivityAt: row.latest_activity_at_ms,
      sessionCount: row.session_count ?? 0,
    }));
  }

  /**
   * All non-archived sessions.
   *
   * This is intentionally NOT scoped to visible projects: the runtime's own notion of a
   * project (default project, plugin workspaces, hidden entries) is policy the domain
   * service owns. The service filters by the visible project id set.
   *
   * @param {number | null | undefined} projectId restrict to one project; omit for all
   */
  listSessions(projectId) {
    const filter = projectId === null || projectId === undefined
      ? ''
      : ' AND project_id = ?';
    const params = filter ? [projectId] : [];
    return this.#query(`${SESSION_SQL}${filter} ORDER BY updated_at_ms DESC`, params, (row) => ({
      id: row.session_id,
      agentName: row.agent_name,
      status: row.status,
      title: row.title,
      workspaceDir: row.workspace_dir,
      purpose: row.purpose,
      purposeKind: row.purpose_kind,
      parentSessionId: row.parent_session_id,
      sessionType: row.session_type,
      // The two fields the Host uses to decide whether a session belongs to the user's
      // conversation list: a scheduled run and a peek are never the user's own chat.
      sessionKind: row.session_kind,
      originCronId: row.origin_cron_id,
      visibility: row.visibility,
      createdAt: row.created_at_ms,
      updatedAt: row.updated_at_ms,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      projectId: row.project_id,
    }));
  }

  /**
   * The scheduled runs of one cron, oldest first.
   *
   * The runtime keeps every attempt forever, so this table is the permanent record of
   * what the scheduler actually did — unlike the handover stamp, which the next handover
   * overwrites. That difference is the whole point: a gap in the duty schedule is only
   * visible here.
   *
   * @param {string} cronId
   * @returns {Array<{id:string, cronId:string, sessionId:string|null, status:string,
   *                  createdAt:number, deliveredAt:number|null, failedAt:number|null,
   *                  errorCode:number|null, error:string|null, retryAt:number|null,
   *                  retryAttempt:number}>}
   */
  listCronRuns(cronId) {
    const id = String(cronId ?? '').trim();
    if (!id) return [];
    return this.listCronRunsFor([id]);
  }

  /**
   * The scheduled runs of several crons at once, oldest first.
   *
   * The duty cron was re-pointed on 2026-10-22 and the runtime created a new definition
   * for it, so the evidence for one duty chain lives under two cron ids. Reading them
   * together is what keeps the cumulative missed rounds from resetting at a re-point.
   *
   * @param {string[]} cronIds
   * @returns {Array<{id:string, cronId:string, sessionId:string|null, status:string,
   *                  createdAt:number, deliveredAt:number|null, failedAt:number|null,
   *                  errorCode:number|null, error:string|null, retryAt:number|null,
   *                  retryAttempt:number}>}
   */
  listCronRunsFor(cronIds) {
    const ids = (Array.isArray(cronIds) ? cronIds : [cronIds])
      .map((value) => String(value ?? '').trim())
      .filter(Boolean);
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(', ');
    return this.#query(
      `SELECT run_id, cron_id, session_id, status, created_at_ms, delivered_at_ms,
              failed_at_ms, error_code, error, retry_at_ms, retry_attempt
         FROM local_runtime_v2_cron_runs
        WHERE cron_id IN (${placeholders})
        ORDER BY created_at_ms ASC`,
      ids,
      (row) => ({
        id: row.run_id,
        cronId: row.cron_id,
        sessionId: row.session_id ?? null,
        status: row.status ?? 'unknown',
        createdAt: row.created_at_ms ?? 0,
        deliveredAt: row.delivered_at_ms ?? null,
        failedAt: row.failed_at_ms ?? null,
        errorCode: row.error_code ?? null,
        error: row.error ?? null,
        retryAt: row.retry_at_ms ?? null,
        retryAttempt: row.retry_attempt ?? 0,
      }),
    );
  }

  /**
   * The cron definitions, newest first.
   *
   * `deleted_at_ms` is what separates a live cron from one that has been replaced: the
   * scheduler re-points by creating a new definition and deleting the old one, so both
   * generations stay in this table.
   *
   * @returns {Array<{cronId:string, schedulerId:string|null, agentName:string|null, name:string,
   *                  targetSessionId:string|null, sessionTargetMode:string|null, revision:number|null,
   *                  deletedAt:number|null, createdAt:number|null, updatedAt:number|null}>}
   */
  listCronDefinitions() {
    return this.#query(
      `SELECT cron_id, scheduler_id, agent_name, name, target_session_id, session_target_mode,
              revision, deleted_at_ms, created_at_ms, updated_at_ms
         FROM local_runtime_v2_cron_definitions
        ORDER BY created_at_ms DESC`,
      [],
      (row) => ({
        cronId: row.cron_id,
        schedulerId: row.scheduler_id ?? null,
        agentName: row.agent_name ?? null,
        name: row.name ?? '',
        targetSessionId: row.target_session_id ?? null,
        sessionTargetMode: row.session_target_mode ?? null,
        revision: row.revision ?? null,
        deletedAt: row.deleted_at_ms ?? null,
        createdAt: row.created_at_ms ?? null,
        updatedAt: row.updated_at_ms ?? null,
      }),
    );
  }

  listGoals() {
    return this.#query(GOAL_SQL, [], (row) => ({
      id: row.goal_id,
      sessionId: row.session_id,
      objective: row.objective,
      status: row.status,
      createdAt: row.created_at_ms,
      updatedAt: row.updated_at_ms,
      tokensUsed: row.tokens_used ?? 0,
      timeUsedSeconds: row.time_used_seconds ?? 0,
      statusReason: row.status_reason,
      lastVerification: row.last_verification,
      dismissedAt: row.dismissed_at_ms,
    }));
  }

  /**
   * @param {boolean} pendingOnly when true, only questionnaires still awaiting an answer
   */
  listQuestionnaires(pendingOnly) {
    // `expired` means the card's window closed — it can no longer be answered, so it is
    // not "waiting for an answer". Leaving it in the pending set is what pinned a project
    // at `blocked` for a card nobody could ever click.
    const filter = pendingOnly
      ? " WHERE status NOT IN ('answered', 'dismissed', 'expired')"
      : '';
    return this.#query(`${QUESTIONNAIRE_SQL}${filter} ORDER BY created_at DESC`, [], (row) => ({
      id: row.request_id,
      sessionId: row.session_id,
      agentName: row.agent_name,
      requestJson: row.request_json,
      status: row.status,
      createdAt: row.created_at,
    }));
  }

  /** In-flight background tasks (bash, tool calls, …) owned by any session. */
  listActiveTasks() {
    const placeholders = TASK_TERMINAL_STATES.map(() => '?').join(', ');
    return this.#query(
      `${TASK_SQL} WHERE status NOT IN (${placeholders}) ORDER BY updated_at_ms DESC LIMIT 200`,
      TASK_TERMINAL_STATES,
      (row) => ({
        id: row.task_id,
        ownerSessionId: row.owner_session_id,
        kind: row.kind,
        status: row.status,
        createdAt: row.created_at_ms,
        updatedAt: row.updated_at_ms,
        endedAt: row.ended_at_ms,
      }),
    );
  }

  /**
   * The conversation of one session, oldest first.
   *
   * Only the plain text of each message is kept: the raw payload also carries thinking,
   * token accounting and context telemetry, none of which belongs on the page.
   *
   * @param {string} sessionId
   * @returns {Array<{id:string, role:string, text:string, source:string, createdAt:number}>}
   */
  listSessionMessages(sessionId) {
    const id = String(sessionId ?? '').trim();
    if (!id) return [];
    return this.#query(MESSAGE_SQL, [id], (row) => ({
      id: row.msg_id ?? '',
      role: row.role ?? '',
      text: extractMessageText(row.data_json),
      // 'miniapp' = said through the Mini App; 'communication' = said in the Host chat.
      source: row.source ?? '',
      createdAt: row.created_at_ms ?? 0,
    }));
  }

  /**
   * How many messages a session holds.
   *
   * This is the cheap change detector: a count that moves means something was said, whether
   * in the Mini App or in the Host chat side panel.
   *
   * @param {string} sessionId
   * @returns {number}
   */
  countSessionMessages(sessionId) {
    const id = String(sessionId ?? '').trim();
    if (!id || !this.#db) return 0;
    try {
      const row = this.#db
        .prepare('SELECT COUNT(*) AS c FROM local_runtime_message_rows WHERE session_id = ?')
        .get(id);
      return Number(row?.c ?? 0);
    } catch (error) {
      this.#error = `读取会话消息数失败：${error?.message ?? String(error)}`;
      return 0;
    }
  }

  /**
   * 这个库的「数据版本号」：别的连接改过这个库，它就会变。
   *
   * SQLite 给的廉价变更信号——读一下就完了，不扫表。本机运行时库已经几百 MB，
   * 每 3 秒去 COUNT 一遍会话消息数太贵，先用这个挡一道：没人写过，对话就不可能变。
   *
   * @returns {number|null} 拿不到就是 `null`——调用方要按「不知道」处理，
   *   宁可多查一次也不能漏掉一条消息
   */
  dataVersion() {
    if (!this.#db) return null;
    try {
      const row = this.#db.prepare('PRAGMA data_version').get();
      const value = Number(row?.data_version);
      return Number.isFinite(value) ? value : null;
    } catch (error) {
      this.#error = `读取运行时数据版本失败：${error?.message ?? String(error)}`;
      return null;
    }
  }

  /**
   * Run a read query, mapping rows and swallowing failures into `lastError()`.
   * @param {string} sql
   * @param {unknown[]} params
   * @param {(row: Record<string, unknown>) => unknown} mapRow
   */
  #query(sql, params, mapRow) {
    if (!this.#db) return [];
    try {
      const statement = this.#db.prepare(sql);
      const rows = params.length ? statement.all(...params) : statement.all();
      return rows.map(mapRow);
    } catch (error) {
      this.#error = `读取运行时状态失败：${error?.message ?? String(error)}`;
      return [];
    }
  }
}
