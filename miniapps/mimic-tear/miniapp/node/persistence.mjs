import { BoardStateStore } from './board-state.mjs';

/**
 * Durable state owned by the Mini App.
 *
 * Everything lives under the Host-provided `dataDir`, never in the workspace package and
 * never in the runtime database. Files are written through a temporary file plus rename so
 * a crash mid-write cannot leave a half-written JSON document behind.
 *
 * ## 这些账现在住在哪
 *
 * **一个 store，一个文件，一把锁**（`board-state.mjs`）。原来它们是四个文件，而其中
 * 派工账有**两个写者、两个进程**——看板的派工路径和值班路径各写各的，都做读-改-写。
 * 那出过真事故：并发写毁掉过记录，而幂等键就在账里，丢一条就可能把同一条指令重投一次。
 *
 * 收口之后两个写者写的是同一段、锁的是同一把锁，写路径也只剩一条。
 *
 * 写纪律住在 `json-ledger.mjs`——一份实现，值班路径（`patrol-store.mjs`）也用它。
 */

/**
 * @typedef {{ id:string, idempotencyKey:string, projectId:number, projectName:string,
 *             targetSessionId:string|null, instruction:string,
 *             status:'queued'|'running'|'done'|'error', bossSessionId:string|null,
 *             text:string, error:string|null, createdAt:number, updatedAt:number }} DispatchRecord
 * @typedef {{ id:string, reason:string, at:number }} DismissedRecord
 */
export class Persistence {
  /** @param {string} dataDir */
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.state = new BoardStateStore(dataDir);
  }

  /** @returns {Promise<DispatchRecord[]>} */
  async listDispatches() {
    return this.state.section('dispatches');
  }

  /**
   * Store one dispatch record, merging it into the ledger.
   *
   * @param {DispatchRecord} record
   */
  async saveDispatch(record) {
    await this.state.update((state) => {
      const all = [...state.dispatches];
      const index = all.findIndex((d) => d.id === record.id);
      if (index === -1) all.push(record);
      else all[index] = record;
      return { ...state, dispatches: all };
    });
    return record;
  }

  /**
   * @param {string} idempotencyKey
   * @returns {Promise<DispatchRecord | null>}
   */
  async findDispatchByKey(idempotencyKey) {
    const all = await this.listDispatches();
    return all.find((d) => d.idempotencyKey === idempotencyKey) ?? null;
  }

  /** @returns {Promise<string[]>} */
  async listAcks() {
    return this.state.section('acks');
  }

  /** @param {string} id */
  async addAck(id) {
    await this.state.update((state) => {
      const all = [...state.acks];
      if (!all.includes(id)) all.push(id);
      return { ...state, acks: all };
    });
    return this.listAcks();
  }

  /**
   * Runtime items the boss has ruled out.
   *
   * The board's inbox mixes the boss's own conclusions with raw runtime items (session
   * errors, blocked plan tasks, paused goals). The boss can withdraw its own conclusions, but
   * it could not rule out a raw item it had proved was a leftover — so those stayed on the
   * user's desk forever. This is that missing half.
   *
   * @returns {Promise<DismissedRecord[]>}
   */
  async listDismissed() {
    return this.state.section('dismissed');
  }

  /**
   * @param {string} id the inbox item id, e.g. `session-error:mvs_…`
   * @param {string} reason why it is not a problem
   * @returns {Promise<DismissedRecord[]>}
   */
  async addDismissed(id, reason) {
    await this.state.update((state) => {
      const all = [...state.dismissed];
      const existing = all.find((entry) => entry.id === id);
      if (existing) {
        existing.reason = reason;
        existing.at = Date.now();
      } else {
        all.push({ id, reason, at: Date.now() });
      }
      return { ...state, dismissed: all };
    });
    return this.listDismissed();
  }

  /**
   * The boss session, with the agent that owns it.
   *
   * The agent matters: a fallback turn runs as the primary agent, and persisting that
   * session as "the boss session" would make every later dispatch run on the primary
   * agent forever. A bare string is accepted for files written by earlier versions.
   *
   * @returns {Promise<{ sessionId: string, agent: string } | null>}
   */
  async getBossSession() {
    return this.state.section('bossSession');
  }

  /**
   * @param {{ sessionId: string, agent: string }} session
   */
  async setBossSession(session) {
    await this.state.setSection('bossSession', session);
    return session;
  }
}
