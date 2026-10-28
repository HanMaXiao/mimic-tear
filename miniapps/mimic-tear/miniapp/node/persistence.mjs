import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { readJsonArray, updateJsonArray, writeJsonAtomic } from './json-ledger.mjs';

/**
 * Durable state owned by the Mini App.
 *
 * Everything lives under the Host-provided `dataDir`, never in the workspace package and
 * never in the runtime database. Files are written through a temporary file plus rename so
 * a crash mid-write cannot leave a half-written JSON document behind.
 *
 * The write discipline for the ledger files lives in `json-ledger.mjs` — one
 * implementation, shared with the duty path (`patrol-store.mjs`), because
 * `dispatches.json` has two writers in two processes and both do read-modify-write. See
 * that module for what happens when they do not coordinate.
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
    this.dispatchesPath = join(dataDir, 'dispatches.json');
    this.acksPath = join(dataDir, 'acks.json');
    // The boss's own screening of the raw runtime items (a session error it proved is a
    // leftover, a blocked plan task that is not actually blocked). Kept apart from the
    // user's own "标记已知" so the two never get confused.
    this.dismissedPath = join(dataDir, 'dismissed.json');
    this.bossSessionPath = join(dataDir, 'boss-session.json');
  }

  /** @returns {Promise<DispatchRecord[]>} */
  async listDispatches() {
    return readJsonArray(this.dispatchesPath);
  }

  /**
   * Store one dispatch record, merging it into the ledger.
   *
   * @param {DispatchRecord} record
   */
  async saveDispatch(record) {
    await updateJsonArray(this.dispatchesPath, (all) => {
      const index = all.findIndex((d) => d.id === record.id);
      if (index === -1) all.push(record);
      else all[index] = record;
      return all;
    }, record.id);
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
    return readJsonArray(this.acksPath);
  }

  /** @param {string} id */
  async addAck(id) {
    await updateJsonArray(this.acksPath, (all) => {
      if (!all.includes(id)) all.push(id);
      return all;
    }, id);
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
    const value = await readJsonArray(this.dismissedPath);
    return Array.isArray(value) ? value : [];
  }

  /**
   * @param {string} id the inbox item id, e.g. `session-error:mvs_…`
   * @param {string} reason why it is not a problem
   * @returns {Promise<DismissedRecord[]>}
   */
  async addDismissed(id, reason) {
    await updateJsonArray(this.dismissedPath, (all) => {
      const existing = all.find((entry) => entry.id === id);
      if (existing) {
        existing.reason = reason;
        existing.at = Date.now();
      } else {
        all.push({ id, reason, at: Date.now() });
      }
      return all;
    }, id);
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
    const value = await readJson(this.bossSessionPath, null);
    if (!value) return null;
    if (typeof value === 'string') return { sessionId: value, agent: 'boss' };
    if (typeof value.sessionId !== 'string') return null;
    return { sessionId: value.sessionId, agent: typeof value.agent === 'string' ? value.agent : 'boss' };
  }

  /**
   * @param {{ sessionId: string, agent: string }} session
   */
  async setBossSession(session) {
    await writeJsonAtomic(this.bossSessionPath, session);
    return session;
  }
}

async function readJson(path, fallback) {
  try {
    const raw = await readFile(path, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (error) {
    // A missing file is normal — nothing has been written yet. A file that exists but
    // cannot be parsed is NOT: the state is damaged, and reporting it as "nothing here"
    // is how a dispatch record that exists on disk silently reads back as missing —
    // which breaks the board's idempotency, because the same instruction would then be
    // delivered twice. So a damaged file is an error, not an empty list.
    if (error?.code === 'ENOENT') return fallback;
    throw new Error(`读不了 ${path}：${error?.message ?? String(error)}（文件已损坏，不要当成「没有记录」）`);
  }
}

