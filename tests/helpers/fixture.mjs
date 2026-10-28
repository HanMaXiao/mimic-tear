import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Runtime-state schema subset used by RuntimeStore.
 * Mirrors the real `~/.minimax/v2/sqlite/runtime-state.sqlite` columns that the read model touches.
 */
const DDL = `
CREATE TABLE local_runtime_projects (
  project_id INTEGER PRIMARY KEY,
  project_kind TEXT,
  workspace_dir TEXT,
  pinned INTEGER,
  hidden INTEGER,
  order_index INTEGER,
  recent_at_ms INTEGER,
  latest_activity_at_ms INTEGER,
  session_count INTEGER,
  extra_data_json TEXT,
  created_at_ms INTEGER,
  updated_at_ms INTEGER
);
CREATE TABLE local_runtime_sessions (
  session_id TEXT PRIMARY KEY,
  record_json TEXT,
  updated_at_ms INTEGER,
  columnar_version INTEGER,
  agent_name TEXT,
  runtime TEXT,
  session_type TEXT,
  status TEXT,
  archived INTEGER,
  visibility TEXT,
  session_kind TEXT,
  purpose TEXT,
  purpose_kind TEXT,
  origin_cron_id TEXT,
  parent_session_id TEXT,
  workspace_dir TEXT,
  project_workspace_dir TEXT,
  is_default_workspace INTEGER,
  title TEXT,
  created_at_ms INTEGER,
  error_message TEXT,
  error_code INTEGER,
  extra_data_json TEXT,
  project_id INTEGER,
  history_relative_dir TEXT
);
CREATE TABLE local_runtime_thread_goals (
  goal_id TEXT PRIMARY KEY,
  session_id TEXT,
  objective TEXT,
  status TEXT,
  created_at_ms INTEGER,
  updated_at_ms INTEGER,
  tokens_used INTEGER,
  time_used_seconds INTEGER,
  token_budget INTEGER,
  kickoff_attachments_json TEXT,
  kickoff_state TEXT,
  objective_resources_json TEXT,
  turns_used INTEGER,
  reply_fingerprint TEXT,
  no_progress_streak INTEGER,
  last_verification TEXT,
  last_worker_proposal TEXT,
  status_reason TEXT,
  execution_wait_reason TEXT,
  execution_wait_since_ms INTEGER,
  execution_wait_epoch INTEGER,
  no_tool_streak INTEGER,
  dismissed_at_ms INTEGER
);
CREATE TABLE questionnaire_requests (
  request_id TEXT PRIMARY KEY,
  session_id TEXT,
  agent_name TEXT,
  msg_id TEXT,
  request_json TEXT,
  status TEXT,
  created_at INTEGER,
  answered_at INTEGER,
  reply_payload TEXT,
  injected_at INTEGER,
  dismissed_at INTEGER,
  origin_channel_context_json TEXT
);
CREATE TABLE local_runtime_background_tasks (
  task_id TEXT PRIMARY KEY,
  owner_session_id TEXT,
  kind TEXT,
  status TEXT,
  created_at_ms INTEGER,
  updated_at_ms INTEGER,
  ended_at_ms INTEGER,
  record_json TEXT,
  delivered_at_ms INTEGER
);
CREATE TABLE local_runtime_message_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  msg_id TEXT,
  role TEXT,
  turn_id TEXT,
  created_at_ms INTEGER,
  data_json TEXT,
  source TEXT,
  source_context_json TEXT
);
`;

/** Create an isolated temp directory. Caller is responsible for cleanup. */
export function tmpDir(prefix = 'mimic-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Remove a temp directory tree, ignoring failures. */
export function cleanupDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

const QUESTIONNAIRE = JSON.stringify({
  schemaVersion: 2,
  id: 'ask_fixture_1',
  mode: 'questionnaire',
  steps: [
    {
      id: 'q1',
      question: '是否把这条任务排到明天？',
      selectionMode: 'single',
      allowOther: true,
      options: [
        { id: 'yes', label: '是' },
        { id: 'no', label: '否' },
      ],
    },
  ],
});

/**
 * The runtime's cron tables.
 *
 * The duty chain lives in the runtime's own database: the scheduler writes the run log
 * there, and the watchdog reads it back to tell "nothing went wrong" from "nothing ran".
 * The definitions table belongs to the same story — a chain resolved by name has to see
 * which definition is alive, or it reads "no runs" and calls it "all quiet".
 *
 * The column list is what `RuntimeStore` selects, so it must not drift from there.
 * This DDL used to live inside `tests/duty-evidence.test.mjs`; it lives here now so
 * that the shape has exactly one source.
 */
const CRON_DDL = `
CREATE TABLE local_runtime_v2_cron_runs (
  run_id TEXT PRIMARY KEY,
  cron_id TEXT,
  session_id TEXT,
  status TEXT,
  created_at_ms INTEGER,
  delivered_at_ms INTEGER,
  failed_at_ms INTEGER,
  error_code INTEGER,
  error TEXT,
  retry_at_ms INTEGER,
  retry_attempt INTEGER
);
CREATE TABLE local_runtime_v2_cron_definitions (
  cron_id TEXT PRIMARY KEY,
  scheduler_id TEXT,
  agent_name TEXT,
  name TEXT,
  target_session_id TEXT,
  session_target_mode TEXT,
  revision INTEGER,
  deleted_at_ms INTEGER,
  created_at_ms INTEGER,
  updated_at_ms INTEGER
);
`;

/**
 * Build a cron-state database carrying a cron's definition and its run log.
 *
 * Additive to this fixture on purpose: the runtime-state tables above are read by every
 * test file, so their columns are frozen. The cron tables are a separate family and get
 * their own factory rather than being folded into `makeRuntimeDb`.
 *
 * @param {string} dir directory to create the db in
 * @param {{
 *   cronId?: string,
 *   sessionId?: string,
 *   definition?: { schedulerId?: string, agentName?: string, name?: string,
 *                  targetSessionId?: string, deletedAtMs?: number|null } | false,
 *   runs?: Array<{ id: string, status: string, createdAt: number, deliveredAt?: number|null,
 *                  failedAt?: number|null, errorCode?: number|null, error?: string|null,
 *                  retryAt?: number|null, retryAttempt?: number }>,
 * }} [options]
 * @returns {string} absolute path of the created database
 */
export function makeCronDb(dir, options = {}) {
  const {
    cronId = 'cron-test',
    sessionId = 'sess-cron',
    definition = {},
    runs = [],
  } = options;

  const dbPath = join(dir, 'cron-state.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(CRON_DDL);

  // The definition has to exist: a chain that resolves by name and finds no definition
  // reads "no runs" and calls it "nothing went wrong".
  if (definition !== false) {
    db.prepare(
      `INSERT INTO local_runtime_v2_cron_definitions
         (cron_id, scheduler_id, agent_name, name, target_session_id, deleted_at_ms)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      cronId,
      definition.schedulerId ?? 'sched-test',
      definition.agentName ?? 'boss',
      definition.name ?? '测试定时任务',
      definition.targetSessionId ?? sessionId,
      definition.deletedAtMs ?? null,
    );
  }

  const insert = db.prepare(
    `INSERT INTO local_runtime_v2_cron_runs
       (run_id, cron_id, session_id, status, created_at_ms, delivered_at_ms,
        failed_at_ms, error_code, error, retry_at_ms, retry_attempt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const run of runs) {
    insert.run(
      run.id, cronId, sessionId, run.status,
      run.createdAt, run.deliveredAt ?? null,
      run.failedAt ?? null, run.errorCode ?? null, run.error ?? null,
      run.retryAt ?? null, run.retryAttempt ?? 0,
    );
  }

  db.close();
  return dbPath;
}

/**
 * Build a runtime-state database populated with representative rows.
 * @param {string} dir directory to create the db in
 * @returns {string} absolute path of the created database
 */
export function makeRuntimeDb(dir) {
  const dbPath = join(dir, 'runtime-state.sqlite');
  const db = new DatabaseSync(dbPath);

  db.exec(DDL);

  const projects = db.prepare(
    `INSERT INTO local_runtime_projects
       (project_id, project_kind, workspace_dir, pinned, hidden, order_index,
        recent_at_ms, latest_activity_at_ms, session_count, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  projects.run(1, 'workspace', 'D:/projects/alpha', 0, 0, 0, 1000, 5000, 3, 1, 5000);
  projects.run(2, 'workspace', 'D:/projects/beta', 0, 0, 1, 2000, 9000, 2, 1, 9000);
  projects.run(3, 'workspace', 'D:/projects/hidden', 0, 1, 2, 3000, 9500, 1, 1, 9500);
  projects.run(4, 'default', null, 0, 0, 3, 4000, 9800, 4, 1, 9800);

  const sessions = db.prepare(
    `INSERT INTO local_runtime_sessions
       (session_id, agent_name, status, archived, visibility, session_type, purpose,
        parent_session_id, workspace_dir, title, created_at_ms, updated_at_ms,
        error_code, error_message, project_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // alpha: one lead + two members
  sessions.run('sess-alpha-lead', 'mavis', 'started', 0, 'visible', 'root', null, null,
    'D:/projects/alpha', 'Alpha 主会话', 100, 5000, null, null, 1);
  sessions.run('sess-alpha-w1', 'worker', 'idle', 0, 'visible', 'child', 'local-background-task:bg_a',
    'sess-alpha-lead', 'D:/projects/alpha', 'Alpha 子任务', 100, 4000, null, null, 1);
  sessions.run('sess-alpha-w2', 'explore', 'error', 0, 'visible', 'child', 'local-task:turn_1',
    'sess-alpha-lead', 'D:/projects/alpha', 'Alpha 另一个子任务', 100, 4500, 50113, 'net::ERR_IO', 1);
  // beta: one lead + one member whose parent lives in another project (orphan)
  sessions.run('sess-beta-lead', 'mavis', 'idle', 0, 'visible', 'root', null, null,
    'D:/projects/beta', 'Beta 主会话', 200, 9000, null, null, 2);
  sessions.run('sess-beta-orphan', 'worker', 'idle', 0, 'visible', 'child', 'local-task:turn_2',
    'sess-alpha-lead', 'D:/projects/beta', 'Beta 孤儿子任务', 200, 8500, null, null, 2);
  // archived + hidden-project rows that must never surface
  sessions.run('sess-archived', 'mavis', 'idle', 1, 'visible', 'root', null, null,
    'D:/projects/alpha', '已归档', 100, 3000, null, null, 1);
  sessions.run('sess-hidden', 'mavis', 'idle', 0, 'visible', 'root', null, null,
    'D:/projects/hidden', '隐藏项目会话', 300, 9500, null, null, 3);

  const goals = db.prepare(
    `INSERT INTO local_runtime_thread_goals
       (goal_id, session_id, objective, status, created_at_ms, updated_at_ms,
        tokens_used, time_used_seconds, status_reason, last_verification, dismissed_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  goals.run('goal-1', 'sess-alpha-lead', '把 alpha 的登录页重做完备', 'active',
    100, 5000, 12345, 678, null, null, null);
  goals.run('goal-2', 'sess-beta-lead', '把 beta 的存档系统做完', 'paused',
    200, 9000, 22222, 910, 'awaiting_user_decision', null, null);
  goals.run('goal-3', 'sess-beta-lead', '已被忽略的旧目标', 'paused',
    200, 8000, 100, 10, null, null, 8888);

  const questionnaires = db.prepare(
    `INSERT INTO questionnaire_requests
       (request_id, session_id, agent_name, request_json, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  questionnaires.run('ask-1', 'sess-alpha-lead', 'mavis', QUESTIONNAIRE, 'pending', 7000);
  questionnaires.run('ask-2', 'sess-beta-lead', 'mavis', QUESTIONNAIRE, 'answered', 6000);
  questionnaires.run('ask-3', 'sess-beta-lead', 'mavis', QUESTIONNAIRE, 'dismissed', 5000);
  // An expired card: its window closed, nobody can click it any more. It must not count
  // as a pending question, and it must not raise a decision item on the board.
  questionnaires.run('ask-4', 'sess-alpha-lead', 'mavis', QUESTIONNAIRE, 'expired', 4000);

  const tasks = db.prepare(
    `INSERT INTO local_runtime_background_tasks
       (task_id, owner_session_id, kind, status, created_at_ms, updated_at_ms, ended_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  tasks.run('bg-run', 'sess-alpha-lead', 'bash', 'running', 9000, 9500, null);
  tasks.run('bg-ok', 'sess-alpha-lead', 'bash', 'succeeded', 8000, 8500, 8500);
  tasks.run('bg-fail', 'sess-beta-lead', 'bash', 'failed', 7000, 7500, 7500);
  tasks.run('bg-cancel', 'sess-beta-lead', 'bash', 'canceled', 6000, 6500, 6500);

  // Conversation rows. Two of them come through the Mini App's own channel and one through
  // the Host chat — the same session, two doors in.
  const messages = db.prepare(
    `INSERT INTO local_runtime_message_rows
       (session_id, msg_id, role, turn_id, created_at_ms, data_json, source)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const message = (content, at, source, role) => JSON.stringify({
    msg_id: `m-${at}`,
    role,
    msg_type: 1,
    timestamp: at,
    msg_content: content,
    turn_id: 'turn-1',
  });
  messages.run('sess-alpha-lead', 'm-1', 'user', 'turn-1', 1000,
    message('从 Mini App 说的话', 1000, 'miniapp', 'user'), 'miniapp');
  messages.run('sess-alpha-lead', 'm-2', 'assistant', 'turn-1', 1100,
    message('大哥的回复', 1100, 'miniapp', 'assistant'), 'miniapp');
  messages.run('sess-alpha-lead', 'm-3', 'user', 'turn-2', 2000,
    message('从宿主侧栏说的话', 2000, 'communication', 'user'), 'communication');

  db.close();
  return dbPath;
}
