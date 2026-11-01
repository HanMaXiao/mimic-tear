import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { projectName } from './view-model.mjs';

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
 * @typedef {{ name:string, reason:string, since:number, addedAt:number,
 *             projectId?:number, path?:string }} ManagedProject
 */

/** Why an entry was added — always the user's words, never the boss's guess. */
const REASON_REQUIRED = '添加管辖项目必须写明理由（大老板的原话或指示）';

/**
 * 项目名 → 运行时里的那个项目。
 *
 * 名单里写的是**项目名**，运行时认的是**项目 id**（`workspace_dir` 的末段）。两者要对上，
 * 名字才是管辖的依据。
 *
 * 精确匹配优先；差一点的名字（大小写不同、互相包含）只当**候选**，不当匹配——乱猜比不猜更糟。
 *
 * @param {string} name
 * @param {Array<{ id:number, workspaceDir:string }>} projects
 * @returns {{ project: { id:number, name:string, path:string }|null, candidates: string[] }}
 */
export function matchManagedProject(name, projects) {
  const wanted = String(name ?? '').trim();
  const rows = (projects ?? []).map((project) => ({
    id: project.id,
    name: projectName(project.workspaceDir),
    path: project.workspaceDir,
  }));
  const exact = rows.find((row) => row.name === wanted) ?? null;
  if (exact) return { project: exact, candidates: [] };

  const needle = wanted.toLowerCase();
  const candidates = rows
    .map((row) => row.name)
    .filter((candidate) => {
      const lower = candidate.toLowerCase();
      return lower === needle || lower.includes(needle) || needle.includes(lower);
    });
  return { project: null, candidates: [...new Set(candidates)] };
}

/**
 * 把名单条目对着**运行时的项目集**解析一遍。
 *
 * **为什么要有这一步**：`ManagedProjects.list()` 给的是**名单本身**（名字、理由、时间），
 * 它不知道运行时有哪个项目——所以「这条授权还落在哪个项目上」这件事，必须拿项目集来解析。
 * 解析完才有 `matched`（这条授权指着的东西真的存在吗）与 `projectName`（它叫什么）。
 *
 * **这个解析曾经有两份口径**：CLI 自己算了一份（`patrol-cli.mjs`），板面侧却直接拿
 * `list()` 的原始条目去用——原始条目里**没有 `matched`**，于是板面算出来的管辖名单永远是空的，
 * 每一条项目事件都被判成「不在管辖范围」，**直通从来没有真的投出去过**。
 * 单测没抓到，是因为测试注入的是一个**带 `matched` 的假名单**，形状和真实模块不一样。
 *
 * 所以它必须**只有这一份实现**，两边共用。
 *
 * @param {Array<any>} entries 名单条目（`ManagedProjects.list()` 的原样输出）
 * @param {Array<{ id:number, workspaceDir:string }>} projects 运行时的项目集
 * @returns {Array<object>} 解析后的条目
 */
export function resolveManagedEntries(entries, projects) {
  return (entries ?? []).map((entry) => {
    const resolved = matchManagedProject(entry?.name, projects);
    return {
      ...entry,
      matched: resolved.project !== null,
      projectId: resolved.project?.id ?? entry?.projectId ?? null,
      projectName: resolved.project?.name ?? null,
      path: resolved.project?.path ?? entry?.path ?? null,
    };
  });
}

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
   * @param {{ projectId?:number, path?:string }} [resolution] where that name actually points
   * @returns {Promise<ManagedProject[]>}
   */
  async add(name, reason, resolution = {}) {
    const projectName = String(name ?? '').trim();
    const why = String(reason ?? '').trim();
    if (!projectName) throw new Error('必须写明项目名');
    if (!why) throw new Error(REASON_REQUIRED);

    const all = await this.list();
    const existing = all.find((entry) => entry.name === projectName);
    if (existing) {
      existing.reason = why;
      existing.addedAt = Date.now();
      // The resolution is refreshed on a re-grant too: re-granting is how a wrong
      // name gets corrected, so it must be able to overwrite the old pointer.
      if (resolution.projectId != null) existing.projectId = resolution.projectId;
      if (resolution.path) existing.path = resolution.path;
    } else {
      all.push({
        name: projectName,
        reason: why,
        since: Date.now(),
        addedAt: Date.now(),
        ...(resolution.projectId != null ? { projectId: resolution.projectId } : {}),
        ...(resolution.path ? { path: resolution.path } : {}),
      });
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
