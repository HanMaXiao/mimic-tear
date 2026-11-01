/**
 * 板面这一侧的「轮次」：能异步起，也能停。
 *
 * ## 要解决的是什么
 *
 * 大哥只有一条会话，巡检轮次、派工、跟大老板说话全都跑在它上面。而宿主在会话正忙时，
 * 对新的 `agent.run` **直接拒绝**（`BUSY` / `session_busy`）——除非调用方说清楚要排队
 * 还是插话（`whenBusy`）。在没有任何轮次登记的地方，「大哥正忙着」等于
 * **「大老板说的话丢了」**。
 *
 * 所以这里给每个在跑的轮次登记一条：
 *
 * - **start** —— 轮次是后台的。登记完立刻返回，调用方不等它跑完。
 * - **stop** —— 每条轮次带一个 `AbortController`；叫停就是 abort，宿主会把那一轮标成
 *   `aborted`（也可能以 `REQUEST_CANCELLED` 拒绝——两种都算叫停）。
 * - **whenBusy 策略** —— 会话正忙时新指令怎么办，由**在跑的是哪一类轮次**决定，
 *   见 {@link resolveWhenBusy}。
 *
 * ## slot 是干什么的
 *
 * 同一个 slot 上已经有在跑的轮次时，再起一轮会被**跳过**（返回 `skipped`）。这是心跳
 * 补偿那套 slot 机制的同一个思路：一件事在一个槽位上只能有一份在跑，重叠的启动直接
 * 跳过，而不是排着队等着跑第二遍。
 *
 * ## 被叫停的轮次算什么
 *
 * **不算结论**。它没跑完，产出不可信——但**要留痕**：轮次状态是 `aborted`，页面看得见。
 * 静默消失是最坏的一种丢数据。
 */

/** 轮次的状态。 */
export const ROUND_STATUSES = ['running', 'finished', 'aborted', 'error'];

/** 轮次结束时最多留多少条记录。 */
const KEEP_ROUNDS = 20;

/**
 * 会话正忙时，新指令该怎么办。
 *
 * 判据是**在跑的全是哪一类轮次**，不是「有没有在跑」：
 *
 * - 全是 `patrol`（巡检轮次）：它只读事实、不改文件。插话是安全的——正在跑的那一轮在
 *   下一个输入点读到它，**不打断**任何人的工作。
 * - 只要有一轮可能是 `dispatch` / `chat`：它们可能在改文件。插话会打断对方改到一半的
 *   东西（主规格 §3.5），所以排队。宁可等，不切人家改到一半的文件。
 * - 没有在跑：正常起一轮，不用 `whenBusy`。
 *
 * @param {string[]|string|null|undefined} activeKinds 在跑的轮次是哪几类
 * @returns {'queue'|'steer'|undefined} 传给宿主的 `whenBusy`；`undefined` 表示不用传
 */
export function resolveWhenBusy(activeKinds) {
  const kinds = (Array.isArray(activeKinds) ? activeKinds : [activeKinds])
    .map((kind) => String(kind ?? '').trim())
    .filter(Boolean);
  if (!kinds.length) return undefined;
  if (kinds.every((kind) => kind === 'patrol')) return 'steer';
  return 'queue';
}

/**
 * 一轮在跑的活。
 *
 * @typedef {{
 *   id: string,
 *   kind: string,
 *   slot: string,
 *   sessionId: string,
 *   status: string,
 *   startedAt: number,
 *   endedAt: number|null,
 *   error: string|null,
 * }} RoundSummary
 */

/**
 * 在跑的轮次登记表。
 *
 * 这份状态**只在内存里**：它是「这一轮正在跑」的进程内事实，不是需要落盘的业务状态。
 * 板面重启后没有「正在跑」这回事——宿主那边的会话轮次也跟着没了。
 */
export class RoundControl {
  /** @type {Map<string, any>} */
  #rounds = new Map();

  /** @type {Map<string, string>} slot -> roundId */
  #slots = new Map();

  /** @type {number} */
  #counter = 0;

  /**
   * 起一个后台轮次。
   *
   * **不等它跑完**：返回的句柄里带着 `promise`，跑完了自己 resolve。
   *
   * @param {{
   *   kind: string,
   *   slot?: string,
   *   sessionId?: string,
   *   onEvent?: (event:any) => void,
   *   run: (signal: AbortSignal, ctx: {onEvent: (event:any) => void}) => Promise<any>,
   * }} input
   * @returns {{
   *   id: string, kind: string, slot: string, status: string,
   *   skipped: boolean, reason: string|null,
   *   promise: Promise<{status:string, result:any, error:string|null}>,
   * }}
   */
  start(input) {
    const kind = String(input?.kind ?? '').trim() || 'unknown';
    const slot = String(input?.slot ?? '').trim();

    if (slot) {
      const existingId = this.#slots.get(slot);
      const existing = existingId ? this.#rounds.get(existingId) : null;
      if (existing && existing.status === 'running') {
        // 同一个槽位上已经有一份在跑了：直接跳过，不排第二遍。
        return {
          id: existing.id,
          kind: existing.kind,
          slot,
          status: 'running',
          skipped: true,
          reason: 'slot_busy',
          promise: existing.promise,
        };
      }
    }

    const id = `rnd_${Date.now().toString(36)}_${(this.#counter += 1).toString(36)}`;
    const controller = new AbortController();
    /** @type {Array<(event:any) => void>} */
    const listeners = [];
    /** @type {any} */
    const round = {
      id,
      kind,
      slot,
      sessionId: String(input?.sessionId ?? ''),
      status: 'running',
      startedAt: Date.now(),
      endedAt: null,
      error: null,
      result: null,
      controller,
      listeners,
      // 同毫秒起的两轮，`startedAt` 分不出先后——用序号兜底，排序才稳定。
      seq: this.#counter,
      promise: null,
    };

    const onEvent = (event) => {
      // 这一轮自己的监听者优先（它通常是把事件往页面上送的那个）。
      if (typeof input?.onEvent === 'function') {
        try {
          input.onEvent(event);
        } catch {
          // 监听者自己坏了，不该把轮次带崩——事件只是转述给页面看的。
        }
      }
      for (const listener of listeners) {
        try {
          listener(event);
        } catch {
          // 同上。
        }
      }
    };

    round.promise = (async () => {
      try {
        const result = await input.run(controller.signal, { onEvent });
        // 叫停是**大老板按的**：信号被 abort 了，这一轮就不算跑完——
        // 哪怕 run 自己说它成功（它可能是在被叫停的那一刻才把结果交出来的）。
        if (controller.signal.aborted || result?.status === 'aborted') {
          round.status = 'aborted';
          round.result = result;
          round.error = result?.error ?? '这一轮被叫停了。';
        } else {
          round.status = 'finished';
          round.result = result ?? null;
        }
        return { status: round.status, result: round.result, error: round.error };
      } catch (error) {
        const aborted = controller.signal.aborted || error?.code === 'REQUEST_CANCELLED';
        round.status = aborted ? 'aborted' : 'error';
        round.error = error?.message ?? String(error);
        return { status: round.status, result: null, error: round.error };
      } finally {
        round.endedAt = Date.now();
        if (slot && this.#slots.get(slot) === id) this.#slots.delete(slot);
        this.#trim();
      }
    })();

    this.#rounds.set(id, round);
    if (slot) this.#slots.set(slot, id);
    this.#trim();

    return {
      id,
      kind,
      slot,
      status: 'running',
      skipped: false,
      reason: null,
      promise: round.promise,
    };
  }

  /**
   * 叫停一轮。
   *
   * 叫停 = abort。宿主会把那一轮标成 `aborted`，或者以 `REQUEST_CANCELLED` 拒绝——
   * 两种都算「停了」，都被记成 `aborted`。
   *
   * @param {string} id
   * @returns {{stopped: boolean, reason: string, id: string|null, status: string|null}}
   */
  stop(id) {
    const round = this.#rounds.get(String(id ?? '').trim());
    if (!round) return { stopped: false, reason: 'not_found', id: null, status: null };
    if (round.status !== 'running') {
      return { stopped: false, reason: 'not_running', id: round.id, status: round.status };
    }
    round.controller.abort();
    return { stopped: true, reason: 'aborted', id: round.id, status: 'running' };
  }

  /**
   * 把一个监听者挂到某轮上——用来让插话进这一轮的对话也能收到这一轮的事件。
   *
   * @param {string} id
   * @param {(event:any) => void} listener
   * @returns {() => void} 摘掉监听者的函数
   */
  attach(id, listener) {
    const round = this.#rounds.get(String(id ?? '').trim());
    if (!round || typeof listener !== 'function') return () => {};
    round.listeners.push(listener);
    return () => {
      const index = round.listeners.indexOf(listener);
      if (index >= 0) round.listeners.splice(index, 1);
    };
  }

  /**
   * 某条会话上正在跑的轮次。
   *
   * @param {string} sessionId
   * @returns {any[]} 在跑的轮次（按开始时间排）
   */
  activeForSession(sessionId) {
    const id = String(sessionId ?? '').trim();
    if (!id) return [];
    return [...this.#rounds.values()]
      .filter((round) => round.status === 'running' && round.sessionId === id)
      .sort((a, b) => (a.startedAt - b.startedAt) || (a.seq - b.seq));
  }

  /**
   * 某个槽位上在跑的轮次。
   *
   * @param {string} slot
   * @returns {any|null}
   */
  active(slot) {
    const id = this.#slots.get(String(slot ?? '').trim());
    return id ? this.#rounds.get(id) ?? null : null;
  }

  /**
   * 一轮的状态。
   *
   * @param {string} id
   * @returns {RoundSummary|null}
   */
  get(id) {
    const round = this.#rounds.get(String(id ?? '').trim());
    if (!round) return null;
    return this.#summarize(round);
  }

  /**
   * 全部轮次，最新的在前。
   *
   * @param {{limit?:number}} [options]
   * @returns {RoundSummary[]}
   */
  list(options = {}) {
    const limit = Number(options.limit) || 20;
    return [...this.#rounds.values()]
      .sort((a, b) => (b.startedAt - a.startedAt) || (b.seq - a.seq))
      .slice(0, limit)
      .map((round) => this.#summarize(round));
  }

  /**
   * @param {any} round
   * @returns {RoundSummary}
   */
  #summarize(round) {
    return {
      id: round.id,
      kind: round.kind,
      slot: round.slot,
      sessionId: round.sessionId,
      status: round.status,
      startedAt: round.startedAt,
      endedAt: round.endedAt,
      error: round.error,
    };
  }

  /**
   * 只留最近的若干条，跑完的旧轮次不占着内存。
   * @returns {void}
   */
  #trim() {
    const finished = [...this.#rounds.values()]
      .filter((round) => round.status !== 'running')
      .sort((a, b) => ((a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt)) || (a.seq - b.seq));
    while (this.#rounds.size > KEEP_ROUNDS && finished.length) {
      const oldest = finished.shift();
      this.#rounds.delete(oldest.id);
    }
  }
}
