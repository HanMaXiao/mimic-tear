import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The jurisdiction list: which projects the boss is allowed to manage.
 *
 * The boss is a chief, not an owner. It manages the projects the user explicitly names —
 * a project the user asked it to start and watch, or a project already running that the
 * user asked it to watch. Everything else is out of bounds, however broken or long-idle it
 * looks.
 *
 * Why this is state and not a prompt rule:
 *
 * - A prompt rule says "don't touch projects you weren't told to manage", but a prompt is
 *   re-read every round and can be overwritten by whoever edited it last. The list survives
 *   rounds and changes only by an explicit act with a stated reason.
 * - The list is what makes the boundary *checkable*. The boss can be asked "which projects
 *   are you managing?" and the answer comes from a file, not from a recollection.
 *
 * @typedef {{ name:string, reason:string, since:number, addedAt:number }} ManagedProject
 */

/** Why an entry was added — always the user's words, never the boss's guess. */
const REASON_REQUIRED = '添加管辖项目必须写明理由（大老板的原话或指示）';

export class ManagedProjects {
  /** @param {string} dataDir */
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.path = join(dataDir, 'managed-projects.json');
  }

  /**
   * The projects currently under the boss's jurisdiction.
   *
   * @returns {Promise<ManagedProject[]>}
   */
  async list() {
    const value = await readJson(this.path, []);
    return Array.isArray(value) ? value.filter((entry) => entry && typeof entry.name === 'string') : [];
  }

  /**
   * Put a project under the boss's management.
   *
   * @param {string} name project name
   * @param {string} reason why — the user's instruction, quoted
   * @returns {Promise<ManagedProject[]>}
   */
  async add(name, reason) {
    const projectName = String(name ?? '').trim();
    const why = String(reason ?? '').trim();
    if (!projectName) throw new Error('必须写明项目名');
    if (!why) throw new Error(REASON_REQUIRED);

    const all = await this.list();
    const existing = all.find((entry) => entry.name === projectName);
    if (existing) {
      existing.reason = why;
      existing.addedAt = Date.now();
    } else {
      all.push({ name: projectName, reason: why, since: Date.now(), addedAt: Date.now() });
    }
    await this.#write(all);
    return all;
  }

  /**
   * Take a project out of the boss's management.
   *
   * @param {string} name project name
   * @param {string} reason why
   * @returns {Promise<ManagedProject[]>}
   */
  async remove(name, reason) {
    const projectName = String(name ?? '').trim();
    const why = String(reason ?? '').trim();
    if (!projectName) throw new Error('必须写明项目名');
    if (!why) throw new Error(REASON_REQUIRED);

    const all = await this.list();
    const next = all.filter((entry) => entry.name !== projectName);
    await this.#write(next);
    return next;
  }

  /**
   * Whether the boss may manage this project.
   *
   * An empty name is never managed: a blank key must not match a blank entry.
   *
   * @param {string} name
   * @returns {Promise<boolean>}
   */
  async isManaged(name) {
    const projectName = String(name ?? '').trim();
    if (!projectName) return false;
    const all = await this.list();
    return all.some((entry) => entry.name === projectName);
  }

  /**
   * The names on the list — for the boss to check a project against.
   *
   * @returns {Promise<string[]>}
   */
  async names() {
    return (await this.list()).map((entry) => entry.name);
  }

  /**
   * @param {ManagedProject[]} entries
   */
  async #write(entries) {
    await mkdir(this.dataDir, { recursive: true });
    const temp = `${this.path}.${process.pid}.${Date.now().toString(36)}.tmp`;
    await writeFile(temp, JSON.stringify(entries, null, 2), 'utf8');
    await rename(temp, this.path);
  }
}

/**
 * @param {string} path
 * @param {any} fallback
 * @returns {Promise<any>}
 */
async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}
