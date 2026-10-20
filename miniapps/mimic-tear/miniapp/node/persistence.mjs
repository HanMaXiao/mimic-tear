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
 */
export class Persistence {
  /** @param {string} dataDir */
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.dispatchesPath = join(dataDir, 'dispatches.json');
    this.acksPath = join(dataDir, 'acks.json');
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
