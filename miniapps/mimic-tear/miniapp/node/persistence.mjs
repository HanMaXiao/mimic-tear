import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Durable state owned by the Mini App.
 *
 * Everything lives under the Host-provided `dataDir`, never in the workspace package and
 * never in the runtime database. Files are written through a temporary file plus rename so
 * a crash mid-write cannot leave a half-written JSON document behind.
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
    return readJson(this.dispatchesPath, []);
  }

  /** @param {DispatchRecord} record */
  async saveDispatch(record) {
    const all = await this.listDispatches();
    const index = all.findIndex((d) => d.id === record.id);
    if (index === -1) all.push(record);
    else all[index] = record;
    await writeJson(this.dispatchesPath, all);
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
    return readJson(this.acksPath, []);
  }

  /** @param {string} id */
  async addAck(id) {
    const acks = await this.listAcks();
    if (!acks.includes(id)) acks.push(id);
    await writeJson(this.acksPath, acks);
    return acks;
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
    const value = await readJson(this.dismissedPath, []);
    return Array.isArray(value) ? value : [];
  }

  /**
   * @param {string} id the inbox item id, e.g. `session-error:mvs_…`
   * @param {string} reason why it is not a problem
   * @returns {Promise<DismissedRecord[]>}
   */
  async addDismissed(id, reason) {
    const dismissed = await this.listDismissed();
    const existing = dismissed.find((entry) => entry.id === id);
    if (existing) {
      existing.reason = reason;
      existing.at = Date.now();
    } else {
      dismissed.push({ id, reason, at: Date.now() });
    }
    await writeJson(this.dismissedPath, dismissed);
    return dismissed;
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
    await writeJson(this.bossSessionPath, session);
    return session;
  }
}

async function readJson(path, fallback) {
  try {
    const raw = await readFile(path, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), 'utf8');
  await rename(temporary, path);
}

function dirname(path) {
  const index = path.lastIndexOf('\\') > path.lastIndexOf('/')
    ? path.lastIndexOf('\\')
    : path.lastIndexOf('/');
  return index <= 0 ? path.slice(0, 2) : path.slice(0, index);
}
