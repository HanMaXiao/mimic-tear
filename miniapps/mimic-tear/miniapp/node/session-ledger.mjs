/**
 * 会话账本。
 *
 * 派工之前要回答的是三个问题：**现在谁在跑、谁在等回答、每个会话最后说了什么**。
 * 没有一份现成的表能同时回答它们：
 *
 * - 板面「会话实况」页读的是宿主给的会话清单（`agent.sessions()`），那是**页面**的桥接，
 *   agent 侧够不着；
 * - `patrol-cli facts` 给的是项目卡和卡，只覆盖板面管辖的可见项目，也没有正文。
 *
 * 这一层把运行时的三张表（会话、待答卡、消息）拼成一张表，**口径与宿主给用户看的那份一致**：
 * 根对话、可见、非 cron、非 peek、非 Mini App 自己开的会话。
 *
 * 口径为什么必须跟宿主一致：大哥在板面上看到的会话，和大哥在 CLI 里读到的会话，
 * 得是**同一批**。否则「板面说这个会话在跑，CLI 里查不到」这种矛盾会变成常态，
 * 而这种矛盾最费时间——因为它看起来像「数据有问题」，其实是两边口径不同。
 */

/** 宿主不列入「用户的对话列表」的会话类型。 */
const EXCLUDED_SESSION_KINDS = new Set(['peek', 'cron']);

/**
 * 运行时的会话状态 → 对外的说法。
 *
 * 运行时管的是 `started`，用户看到的是「进行中」——宿主用的是这张表，这里跟它一致。
 */
const STATUS = Object.freeze({
  started: 'running',
  idle: 'idle',
  error: 'error',
  aborted: 'aborted',
  interrupted: 'aborted',
});

/**
 * 把运行时的会话状态翻成对外的说法。
 *
 * @param {string|null|undefined} status
 * @returns {'running'|'idle'|'error'|'aborted'}
 */
export function normalizeStatus(status) {
  return STATUS[status] ?? 'idle';
}

/**
 * 这个会话在「用户的对话列表」里吗？
 *
 * 这是宿主的口径（`session-observe.js` 的 `listObservableSessions`）：
 * 可见、不是被委派的子会话、不是定时任务的产物、不是 peek、不是 Mini App 自己开的。
 *
 * @param {any} session
 * @returns {boolean}
 */
export function isListedSession(session) {
  if (!session || typeof session !== 'object') return false;
  if (session.visibility !== 'visible') return false;
  if (session.parentSessionId) return false;
  if (session.sessionKind && EXCLUDED_SESSION_KINDS.has(session.sessionKind)) return false;
  if (session.originCronId) return false;
  // A Mini App's own session is hidden from the user's list — the board's own session
  // is one of those.
  if (typeof session.purpose === 'string' && session.purpose.startsWith('miniapp:')) return false;
  return true;
}

/**
 * 最后一条助手回复。
 *
 * 这就是宿主 `agent.session(id)` 给的 `lastAssistantText`：一轮里助手说的最后一段话。
 *
 * @param {Array<{role?:string, text?:string}>} messages
 * @returns {string|null}
 */
export function lastAssistantReply(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'assistant') continue;
    if (typeof message.text !== 'string') continue;
    const text = message.text.trim();
    if (text) return text;
  }
  return null;
}

/**
 * 把已经读出来的数据拼成账本。
 *
 * 纯函数：读库在外面，这样口径可以脱离运行时单独验。
 *
 * @param {{sessions:Array<any>, questionnaires?:Array<any>, lastReplies?:Map<string,string>,
 *          projectNames?:Map<number,string>, now?:number}} input
 * @returns {{generatedAt:number, sessions:Array<any>, counts:object, waiting:Array<string>,
 *            questionnaires:Array<any>}}
 */
export function buildSessionLedger({
  sessions,
  questionnaires = [],
  lastReplies = new Map(),
  projectNames = new Map(),
  now = Date.now(),
}) {
  /** @type {Map<string, Array<any>>} */
  const waitingBySession = new Map();
  const pendingQuestionnaires = [];
  for (const questionnaire of questionnaires) {
    if (!questionnaire?.sessionId) continue;
    if (!waitingBySession.has(questionnaire.sessionId)) waitingBySession.set(questionnaire.sessionId, []);
    waitingBySession.get(questionnaire.sessionId).push(questionnaire);
    pendingQuestionnaires.push(questionnaire);
  }

  const rows = [];
  for (const session of sessions) {
    if (!isListedSession(session)) continue;
    const waiting = waitingBySession.get(session.id) ?? [];
    const status = normalizeStatus(session.status);
    rows.push({
      id: session.id,
      title: session.title || '未命名对话',
      agentName: session.agentName ?? null,
      status,
      running: status === 'running',
      updatedAt: session.updatedAt ?? 0,
      projectId: session.projectId ?? null,
      projectName: projectNames.get(session.projectId) ?? null,
      needsAnswer: waiting.length > 0,
      waitingRequestIds: waiting.map((entry) => entry.id),
      lastReply: lastReplies.get(session.id) ?? null,
      error: session.errorMessage ?? null,
    });
  }

  rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  const counts = { total: rows.length, running: 0, idle: 0, error: 0, waiting: 0 };
  for (const row of rows) {
    if (row.status === 'running') counts.running += 1;
    else if (row.status === 'error') counts.error += 1;
    else counts.idle += 1;
    if (row.needsAnswer) counts.waiting += 1;
  }

  return {
    generatedAt: now,
    sessions: rows,
    counts,
    waiting: rows.filter((row) => row.needsAnswer).map((row) => row.id),
    questionnaires: pendingQuestionnaires,
  };
}

/**
 * 从运行时库读一份账本。
 *
 * @param {any} store 运行时存储（只读）
 * @param {{includeReplies?:boolean, projectNames?:Map<number,string>, now?:number}} [options]
 * @returns {{generatedAt:number, sessions:Array<any>, counts:object, waiting:Array<string>,
 *            questionnaires:Array<any>}}
 */
export function readSessionLedger(store, options = {}) {
  const { includeReplies = false, projectNames = new Map(), now = Date.now() } = options;
  const sessions = store.listSessions();
  const questionnaires = store.listQuestionnaires(true);

  const lastReplies = new Map();
  if (includeReplies) {
    for (const session of sessions) {
      if (!isListedSession(session)) continue;
      const reply = lastAssistantReply(store.listSessionMessages(session.id));
      if (reply) lastReplies.set(session.id, reply);
    }
  }

  return buildSessionLedger({ sessions, questionnaires, lastReplies, projectNames, now });
}
