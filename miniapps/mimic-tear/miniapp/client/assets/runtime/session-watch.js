/**
 * 会话实况：宿主会话观察。
 *
 * 这一层只做一件事：把宿主给出的会话状态与 turn 事件，变成看板能画的一张表。
 * 它不判断业务，也不替大哥下结论——它只回答三个问题：现在有哪些会话、每个会话在干什么、
 * 哪个会话在等着人回答。
 *
 * 数据全部来自宿主的三个接口（都在 `window.mcode.miniapp.agent` 上）：
 * - `sessions()`            当前可读取的会话清单（标题 + 状态）
 * - `session(id)`          单个会话的详情，含最后一条回复正文
 * - `observe({all:true})`  全局 turn 生命周期（turn.started / turn.finished）
 *
 * 「谁在等回答」不能靠全局观察拿到：`observe({all:true})` 不带工具生命周期，
 * 只有单会话观察 `observe({sessionId})` 才会给 `tool.started(name='ask_user')`。
 * 宿主一共给四个观察位，这里用一个全局位加最多三个单会话位——和桌宠的做法一致，
 * 剩下的位留给宿主自己。
 *
 * 纯函数（`normalizeSession`、`applyTurnEvent`）与宿主桥接分开写，
 * 这样状态机可以脱离浏览器直接测。
 */

/** 宿主给出的会话状态。 */
export const SESSION_STATUSES = Object.freeze(['idle', 'running', 'error', 'aborted']);

/** 单会话观察位上限。宿主总共给四个位，一个已经被全局观察占掉。 */
export const MAX_SESSION_WATCHES = 3;

/** 等待回答的判定延迟（毫秒）。工具刚起步时先等等，避免一闪而过。 */
const ASK_DELAY_MS = 120;

const codeOf = (error) => error?.code || error?.message || 'runtime_unavailable';

const isId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256;

const invalid = () => Object.assign(new Error('invalid_request'), { code: 'invalid_request' });

/**
 * 把宿主的一条会话记录收成看板用的形状。
 *
 * @param {any} raw
 * @returns {{sessionId:string, title:string, status:string, updatedAtMs:number}}
 */
export function normalizeSession(raw) {
  if (!raw || typeof raw !== 'object') throw invalid();
  if (!isId(raw.sessionId)) throw invalid();
  if (!SESSION_STATUSES.includes(raw.status)) throw invalid();
  if (!Number.isSafeInteger(raw.updatedAtMs) || raw.updatedAtMs < 0) throw invalid();
  if (raw.title !== undefined && typeof raw.title !== 'string') throw invalid();

  return {
    sessionId: raw.sessionId,
    title: (raw.title || '未命名对话').slice(0, 1000),
    status: raw.status,
    updatedAtMs: raw.updatedAtMs,
  };
}

/**
 * 会话详情：清单那条记录再加上最后一条回复正文。
 *
 * `lastAssistantText` 就是「最终回复」——宿主给每个 turn 都留着它。
 *
 * @param {any} raw
 * @returns {{sessionId:string, title:string, status:string, updatedAtMs:number,
 *            lastAssistantText:string|null, error:string|null}}
 */
export function normalizeSessionDetail(raw) {
  const row = normalizeSession(raw);
  return {
    ...row,
    lastAssistantText: typeof raw.lastAssistantText === 'string' ? raw.lastAssistantText : null,
    error: typeof raw.error?.message === 'string' ? raw.error.message : null,
  };
}

/**
 * 把一个 turn 事件折进会话表。
 *
 * 这是整层唯一的写入口：清单、事件两条来源最后都落到同一张表上，
 * 所以「事件比清单新」还是「清单比事件新」这种时序问题只有一个地方要判断。
 *
 * @param {Map<string, any>} rows 现有的会话表
 * @param {any} event 宿主的 turn 事件
 * @param {number} now 当前时间（毫秒）
 * @returns {Map<string, any>} 新的会话表（不改传入的那张）
 */
export function applyTurnEvent(rows, event, now) {
  const next = new Map(rows);
  if (!event || !isId(event.sessionId)) return next;

  if (event.type === 'turn.started') {
    const previous = next.get(event.sessionId);
    next.set(event.sessionId, {
      ...(previous ?? { sessionId: event.sessionId, title: '未命名对话', needsAnswer: false }),
      title: typeof event.title === 'string' && event.title ? event.title.slice(0, 1000) : previous?.title ?? '未命名对话',
      status: 'running',
      updatedAtMs: now,
      running: true,
    });
    return next;
  }

  if (event.type === 'turn.finished') {
    if (!['finished', 'error', 'aborted'].includes(event.status)) return next;
    const previous = next.get(event.sessionId);
    if (!previous) return next;
    next.set(event.sessionId, {
      ...previous,
      status: event.status === 'finished' ? 'idle' : event.status,
      updatedAtMs: now,
      running: false,
      // 一轮跑完不等于「已经有结果可看」：正文要另外读，正文读到之前先记着。
      resultPending: event.status === 'finished',
    });
    return next;
  }

  return next;
}

/**
 * 工具事件里，只有 `ask_user` 表示「这个会话在等一个人回答」。
 *
 * @param {any} event
 * @returns {boolean}
 */
export function isAskEvent(event) {
  return Boolean(event) && event.name === 'ask_user';
}

/**
 * 把运行时的待答卡合进会话快照。
 *
 * 「等回答」有两个来源：**事件**（`tool.started(name='ask_user')`，快，但只覆盖订阅之后
 * 新起的提问）和**运行时待答卡**（准，且是持久状态——页面关过、重载过都还在）。
 * 取并集，事件负责快，运行时负责准。
 *
 * @param {any} snapshot
 * @param {Set<string>} pendingAsks 还在等回答的会话 id
 * @returns {any}
 */
export function mergePendingAsks(snapshot, pendingAsks) {
  const asks = pendingAsks instanceof Set ? pendingAsks : new Set();
  const sessions = (snapshot?.sessions ?? []).map((row) => ({
    ...row,
    needsAnswer: Boolean(row.needsAnswer) || asks.has(row.sessionId),
  }));
  return { ...snapshot, sessions };
}

/**
 * 观察宿主的会话，并把变化交给回调。
 *
 * @param {{agent:any, onChange:Function, onTick?:Function, now?:Function, requestId?:Function}} options
 *   `onTick` 挂在同一个轮询节拍上：客户端只应该有一个定时器——
 *   多一个就多一份「页面关了还在跑」的机会。
 */
export function createSessionWatch({ agent, onChange, onTick, now = Date.now, requestId = () => `mimic-tear-watch-${globalThis.crypto.randomUUID()}` }) {
  let disposed = false;
  let observer = null;
  let timer = null;
  let sequence = 0;

  /** @type {Map<string, any>} */
  const rows = new Map();
  /** @type {Map<string, {requestId:string, timer:any, needsAnswer:boolean, failed:boolean}>} */
  const watches = new Map();

  let state = {
    availability: 'connecting',
    sessions: [],
    selectedSessionId: null,
    detail: null,
    detailLoading: false,
    error: null,
  };

  const emit = () => {
    if (disposed) return;
    const sessions = [...rows.values()].sort(
      (a, b) => Number(b.updatedAtMs || 0) - Number(a.updatedAtMs || 0) || String(a.sessionId).localeCompare(String(b.sessionId)),
    );
    state = { ...state, sessions };
    onChange({ ...state, sessions: sessions.map((row) => ({ ...row })), detail: state.detail ? { ...state.detail } : null });
  };

  const fail = (error) => {
    if (disposed) return;
    clearGlobalObserver();
    state = {
      availability: codeOf(error) === 'not_permitted' ? 'not_permitted' : 'unavailable',
      sessions: [],
      selectedSessionId: null,
      detail: null,
      detailLoading: false,
      error: codeOf(error),
    };
    emit();
  };

  const clearGlobalObserver = () => {
    if (!observer) return;
    const previous = observer;
    observer = null;
    try {
      Promise.resolve(agent?.cancel?.(previous.requestId)).catch(() => {});
    } catch {
      // 取消失败不影响页面：观察位会自己释放，只是慢一点。
    }
  };

  const onTurnEvent = (event) => {
    if (disposed || !event) return;
    if (!['turn.started', 'turn.finished'].includes(event.type)) return;
    // `applyTurnEvent` 返回新表，不改传入的那张——这样事件流和清单读可以共用一张表，
    // 谁先谁后都不会把另一边的信息抹掉。
    const updated = applyTurnEvent(rows, event, now());
    rows.clear();
    for (const [id, row] of updated) rows.set(id, row);
    emit();
    if (state.selectedSessionId === event.sessionId) void readDetail(state.selectedSessionId);
  };

  const startGlobalObserver = () => {
    const request = { requestId: requestId(), cancelled: false };
    observer = request;
    let subscription;
    try {
      subscription = agent.observe({ all: true, requestId: request.requestId }, { onEvent: onTurnEvent });
    } catch (error) {
      observer = null;
      fail(error);
      return false;
    }
    Promise.resolve(subscription).then(
      () => { if (observer === request) { observer = null; fail({ code: 'runtime_unavailable' }); } },
      (error) => { if (observer === request) { observer = null; fail(error); } },
    );
    return true;
  };

  /**
   * 单会话观察：只为「等回答」这件事服务。
   *
   * @param {string} sessionId
   */
  const startWatch = (sessionId) => {
    if (watches.has(sessionId) || watches.size >= MAX_SESSION_WATCHES) return;
    const watch = { requestId: `mimic-tear-ask-${now().toString(36)}-${++sequence}`, timer: null, needsAnswer: false, failed: false };
    watches.set(sessionId, watch);

    const onEvent = (event) => {
      if (disposed || watches.get(sessionId) !== watch) return;
      if (!event || event.sessionId !== sessionId) return;
      if (!['tool.started', 'tool.finished'].includes(event.type)) return;
      if (!isAskEvent(event)) return;

      const row = rows.get(sessionId);
      if (!row) return;

      if (event.type === 'tool.started') {
        if (watch.needsAnswer) return;
        watch.timer = setTimeout(() => {
          watch.timer = null;
          if (disposed || watches.get(sessionId) !== watch) return;
          watch.needsAnswer = true;
          rows.set(sessionId, { ...row, needsAnswer: true });
          emit();
        }, ASK_DELAY_MS);
        return;
      }

      if (watch.timer) { clearTimeout(watch.timer); watch.timer = null; }
      if (!watch.needsAnswer) return;
      watch.needsAnswer = false;
      rows.set(sessionId, { ...rows.get(sessionId), needsAnswer: false });
      emit();
    };

    let operation;
    try {
      operation = agent.observe({ sessionId, requestId: watch.requestId }, { onEvent });
    } catch (error) {
      operation = Promise.reject(error);
    }
    void Promise.resolve(operation).then(
      () => { if (watches.get(sessionId) === watch) { watches.delete(sessionId); emit(); } },
      () => { if (watches.get(sessionId) === watch) { watches.delete(sessionId); emit(); } },
    );
  };

  const stopWatch = (sessionId) => {
    const watch = watches.get(sessionId);
    if (!watch) return;
    watches.delete(sessionId);
    if (watch.timer) clearTimeout(watch.timer);
    try {
      Promise.resolve(agent?.cancel?.(watch.requestId)).catch(() => {});
    } catch {
      // 同上：取消失败不影响页面。
    }
  };

  /**
   * 单会话观察位只留给「正在跑」的会话——跑完了就没什么可等的了。
   */
  const reconcileWatches = () => {
    const running = [...rows.values()].filter((row) => row.status === 'running' && row.needsAnswer !== undefined);
    const wanted = running
      .sort((a, b) => Number(b.updatedAtMs || 0) - Number(a.updatedAtMs || 0))
      .slice(0, MAX_SESSION_WATCHES)
      .map((row) => row.sessionId);
    for (const sessionId of [...watches.keys()]) {
      if (!wanted.includes(sessionId)) stopWatch(sessionId);
    }
    for (const sessionId of wanted) startWatch(sessionId);
  };

  /**
   * 读一个会话的详情：最后一条回复正文。
   *
   * @param {string} sessionId
   */
  const readDetail = async (sessionId) => {
    if (!sessionId || disposed) return;
    state = { ...state, detailLoading: true };
    emit();
    try {
      const raw = await agent.session(sessionId);
      if (disposed || state.selectedSessionId !== sessionId) return;
      if (!raw) {
        rows.delete(sessionId);
        state = { ...state, detail: null, detailLoading: false, error: 'session_not_found' };
        emit();
        return;
      }
      const detail = normalizeSessionDetail(raw);
      const row = rows.get(sessionId);
      rows.set(sessionId, { ...(row ?? detail), ...detail, needsAnswer: row?.needsAnswer ?? false });
      state = { ...state, detail, detailLoading: false, error: null };
      emit();
    } catch (error) {
      if (disposed) return;
      if (codeOf(error) === 'not_permitted' || codeOf(error) === 'runtime_unavailable') {
        fail(error);
        return;
      }
      state = { ...state, detail: null, detailLoading: false, error: codeOf(error) };
      emit();
    }
  };

  /**
   * 读一遍会话清单。
   */
  const readSnapshot = async () => {
    if (disposed) return;
    try {
      const result = await agent.sessions();
      if (disposed) return;
      if (!result || !Array.isArray(result.sessions)) throw invalid();
      const incoming = result.sessions.map((raw) => normalizeSession(raw));
      const seen = new Set();
      for (const row of incoming) {
        if (seen.has(row.sessionId)) continue;
        seen.add(row.sessionId);
        const previous = rows.get(row.sessionId);
        // 事件流比清单新：一个正在跑的会话不能被清单里的旧状态盖回 idle；
        // 但清单若给出的是终态（出错 / 中止），那也是真的，事件流没跟上不算数。
        const running = row.status === 'running' || (previous?.running === true && row.status === 'idle');
        rows.set(row.sessionId, {
          ...row,
          status: running ? 'running' : row.status,
          needsAnswer: previous?.needsAnswer ?? false,
          running,
        });
      }
      for (const sessionId of [...rows.keys()]) {
        if (!seen.has(sessionId) && rows.get(sessionId)?.running !== true) rows.delete(sessionId);
      }
      state = { ...state, availability: 'ready', error: null };
      emit();
      reconcileWatches();
    } catch (error) {
      if (disposed) return;
      if (codeOf(error) === 'not_permitted' || codeOf(error) === 'runtime_unavailable') {
        fail(error);
        return;
      }
      state = { ...state, availability: 'ready', error: codeOf(error) };
      emit();
    }
  };

  return {
    /**
     * 连上宿主，开始观察。
     */
    async start() {
      if (disposed) return;
      if (!agent || ['sessions', 'session', 'observe', 'cancel'].some((name) => typeof agent[name] !== 'function')) {
        fail({ code: 'unsupported' });
        return;
      }
      if (!startGlobalObserver()) return;
      await readSnapshot();
      // 清单是快照，事件是流。宿主不会因为事件停下来就重发清单，所以这里定期补一次，
      // 让「别的窗口里新开的对话」也能出现在这张表上。
      timer = setInterval(() => {
        void readSnapshot();
        onTick?.();
      }, 5000);
    },

    /**
     * 重新读一遍。
     */
    async refresh() {
      if (disposed) return;
      await readSnapshot();
    },

    /**
     * 选中一个会话并读它的最终回复。
     *
     * @param {string} sessionId
     */
    select(sessionId) {
      if (disposed) return;
      if (!rows.has(sessionId)) {
        state = { ...state, selectedSessionId: null, detail: null, detailLoading: false, error: 'session_not_found' };
        emit();
        return;
      }
      state = { ...state, selectedSessionId: sessionId, detail: null, detailLoading: false };
      emit();
      void readDetail(sessionId);
    },

    /**
     * 停掉一切观察。
     */
    dispose() {
      if (disposed) return;
      disposed = true;
      if (timer) clearInterval(timer);
      timer = null;
      clearGlobalObserver();
      for (const sessionId of [...watches.keys()]) stopWatch(sessionId);
      rows.clear();
    },
  };
}
