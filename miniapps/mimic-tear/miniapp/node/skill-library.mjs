import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { parseFrontmatter } from './skill-catalog.mjs';

/**
 * The reusable-skill registry.
 *
 * This is deliberately not the capability catalog (`skill-catalog.mjs` scans what is
 * installed). The catalog answers "which skills exist on this machine"; the registry answers
 * "which skill did we package for this kind of work, when was it last used, and is it still
 * on disk". Those are different questions — a skill can be installed and useless, and a
 * packaged skill can be missing from disk — and collapsing them into one list produces a
 * library that looks complete while dispatching the wrong thing.
 *
 * The registry is written by the boss (through `skill-cli.mjs`, which shares this store) and
 * read by the board, so the user can see the library the boss dispatches from.
 */

export const SKILL_LIBRARY_VERSION = 1;

/**
 * @typedef {'candidate'|'active'|'stale'|'retired'} SkillLibraryStatus
 * @typedef {{
 *   id: string,
 *   skillName: string,
 *   title: string,
 *   scope: 'global'|'agent'|'project',
 *   path: string,
 *   domain: string,
 *   triggers: string[],
 *   source: { projectId: number|null, sessionId: string|null, evidence: string },
 *   status: SkillLibraryStatus,
 *   createdAt: number,
 *   lastValidatedAt: number,
 *   lastUsedAt: number|null,
 *   usageCount: number,
 *   successCount: number,
 *   lastError: string|null,
 *   notes: string,
 * }} SkillLibraryEntry
 */

const VALID_STATUS = new Set(['candidate', 'active', 'stale', 'retired']);
const VALID_SCOPE = new Set(['global', 'agent', 'project']);

/**
 * Coerce to a number, or to null when there is no number.
 *
 * `Number(null)` is 0 and `Number.isFinite(0)` is true, so a plain finite check turns
 * "no project id" into "project 0" and "never used" into "used at the epoch". Both are
 * facts the registry must not invent.
 *
 * @param {any} value
 * @returns {number|null}
 */
function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Turn raw input into a registry entry, rejecting what cannot be dispatched.
 *
 * The registry is written by an agent reporting back after packaging a skill, so its input
 * is untrusted shape-wise: a missing skill name or an empty trigger list produces an entry
 * that can never be matched and never validated. Those are refused here, at the boundary,
 * rather than stored as noise the boss has to recognise later.
 *
 * @param {any} input
 * @param {{ now?: number, id?: string }} [options]
 * @returns {SkillLibraryEntry}
 */
export function normalizeEntry(input = {}, options = {}) {
  const now = options.now ?? Date.now();
  const skillName = String(input.skillName ?? input.name ?? '').trim();
  if (!skillName) throw new Error('注册表条目必须有 skillName —— 没有名字的技能既匹配不了也校验不了');

  const scope = VALID_SCOPE.has(input.scope) ? input.scope : 'global';
  const status = VALID_STATUS.has(input.status) ? input.status : 'active';
  const triggers = [...new Set(
    (Array.isArray(input.triggers) ? input.triggers : [])
      .map((trigger) => String(trigger ?? '').trim().toLowerCase())
      .filter(Boolean),
  )];

  const lastUsedAt = finiteOrNull(input.lastUsedAt);
  const usageCount = finiteOrNull(input.usageCount) ?? 0;
  const successCount = finiteOrNull(input.successCount) ?? 0;
  const createdAt = finiteOrNull(input.createdAt) ?? now;

  return {
    id: options.id ?? `sl_${now.toString(36)}_${randomBytes(4).toString('hex')}`,
    skillName,
    title: String(input.title ?? skillName).trim(),
    scope,
    path: String(input.path ?? '').trim(),
    domain: String(input.domain ?? '').trim().toLowerCase(),
    triggers,
    source: {
      projectId: finiteOrNull(input.source?.projectId),
      sessionId: input.source?.sessionId ? String(input.source.sessionId) : null,
      evidence: String(input.source?.evidence ?? '').trim(),
    },
    status,
    createdAt,
    lastValidatedAt: finiteOrNull(input.lastValidatedAt) ?? 0,
    lastUsedAt,
    usageCount,
    successCount,
    lastError: input.lastError ? String(input.lastError) : null,
    notes: String(input.notes ?? '').trim(),
  };
}

/**
 * Score one entry against a task description.
 *
 * Keyword hits are the evidence: a trigger that appears in the task is the only signal that
 * connects a task to a packaged skill. Longer triggers weigh more, because a two-character
 * trigger is the same kind of noise for every task and a specific one ("watchdog", "duty
 * heartbeat") is a real match. The skill name is the strongest signal when it appears
 * verbatim; the title is weaker, and the domain is weaker still.
 *
 * @param {SkillLibraryEntry} entry
 * @param {string} query lower-cased task text
 * @returns {{ score: number, matchedTriggers: string[] }}
 */
export function scoreEntry(entry, query) {
  const matched = [];
  let score = 0;

  for (const trigger of entry.triggers) {
    if (!query.includes(trigger)) continue;
    matched.push(trigger);
    score += 2 + Math.min(trigger.length, 12) / 4;
  }

  const name = entry.skillName.toLowerCase();
  if (query.includes(name)) {
    score += 5;
    matched.push(name);
  }

  const title = entry.title.toLowerCase();
  if (title && query.includes(title)) {
    score += 3;
    matched.push(entry.title);
  }

  if (entry.domain && query.includes(entry.domain)) score += 1;

  return { score: Math.round(score * 100) / 100, matchedTriggers: [...new Set(matched)] };
}

/**
 * The registry, stored next to the board's other state.
 *
 * Only the CLI writes this file and the board only reads it, so there is no second writer to
 * queue against. The write is still atomic (unique temp name + rename): a half-written
 * registry is worse than a missing one, because a missing one is obvious and a half-written
 * one reads as a smaller library.
 */
export class SkillLibraryStore {
  /** @param {string} dataDir */
  constructor(dataDir) {
    this.dataDir = resolve(dataDir);
    this.path = join(this.dataDir, 'skill-library.json');
  }

  /**
   * @returns {Promise<{ version: number, updatedAt: number, entries: SkillLibraryEntry[] }>}
   */
  async read() {
    const value = await readJson(this.path, null);
    if (!value || typeof value !== 'object') {
      return { version: SKILL_LIBRARY_VERSION, updatedAt: 0, entries: [] };
    }
    const entries = Array.isArray(value.entries) ? value.entries : [];
    return {
      version: Number(value.version) || SKILL_LIBRARY_VERSION,
      updatedAt: Number(value.updatedAt) || 0,
      // The stored id is kept: the boss addresses entries by id (`use`, `retire`, `remove`),
      // so an id that changes on every read would make those commands miss the entry they
      // were pointed at.
      entries: entries.map((entry) => normalizeEntry(entry, {
        now: Number(entry.createdAt) || Date.now(),
        id: entry.id,
      })),
    };
  }

  /** @returns {Promise<SkillLibraryEntry[]>} */
  async list() {
    return (await this.read()).entries;
  }

  /** @param {string} id */
  async get(id) {
    const entries = await this.list();
    return entries.find((entry) => entry.id === id) ?? null;
  }

  /** @param {string} skillName */
  async findBySkillName(skillName) {
    const entries = await this.list();
    return entries.find((entry) => entry.skillName === skillName) ?? null;
  }

  /**
   * Register a skill, or update the entry that already describes it.
   *
   * Upsert by skill name rather than by id: the same skill gets reported back more than once
   * (the owner agent creates it, then confirms the path, then confirms the triggers), and
   * each of those reports is the same skill, not a new one. Keying by id would turn one
   * packaged skill into three registry rows and the matching would offer all three.
   *
   * @param {any} input
   * @returns {Promise<{ entry: SkillLibraryEntry, created: boolean }>}
   */
  async upsert(input) {
    const existing = await this.findBySkillName(String(input?.skillName ?? input?.name ?? '').trim());
    const now = Date.now();
    const entry = normalizeEntry(input, {
      now,
      id: existing?.id,
    });
    if (existing) {
      // Usage counters are the boss's record of what actually happened; a re-report must not
      // reset them, and the creation time is a fact too.
      entry.createdAt = existing.createdAt;
      entry.usageCount = existing.usageCount;
      entry.successCount = existing.successCount;
      entry.lastUsedAt = existing.lastUsedAt;
      // Retirement is sticky: re-reporting a skill that was tried and rejected must not
      // quietly put it back into dispatch. Reviving it is a deliberate `status: 'active'`.
      if (existing.status === 'retired' && input.status !== 'active') {
        entry.status = 'retired';
      }
    }

    const library = await this.read();
    const entries = library.entries.filter((item) => item.id !== entry.id);
    entries.unshift(entry);
    await this.write(entries);
    return { entry, created: !existing };
  }

  /**
   * @param {string} id
   * @param {Partial<SkillLibraryEntry>} patch
   * @returns {Promise<SkillLibraryEntry | null>}
   */
  async update(id, patch) {
    const library = await this.read();
    const index = library.entries.findIndex((entry) => entry.id === id);
    if (index === -1) return null;
    const merged = normalizeEntry({ ...library.entries[index], ...patch }, {
      now: Date.now(),
      id: library.entries[index].id,
    });
    // The counters are facts about what actually happened. A patch that does not mention
    // them keeps the recorded value; a patch that does — `recordUse` bumping the count —
    // must be allowed through, otherwise "record a use" silently records nothing.
    if (patch.createdAt === undefined) merged.createdAt = library.entries[index].createdAt;
    if (patch.usageCount === undefined) merged.usageCount = library.entries[index].usageCount;
    if (patch.successCount === undefined) merged.successCount = library.entries[index].successCount;
    if (patch.lastUsedAt === undefined) merged.lastUsedAt = library.entries[index].lastUsedAt;
    const entries = [...library.entries];
    entries[index] = merged;
    await this.write(entries);
    return merged;
  }

  /**
   * Retire an entry: it stays in the registry as a record of what was tried, but it is no
   * longer offered for dispatch.
   *
   * Retiring is not deleting. A skill that was packaged and then proved useless is exactly
   * the evidence the boss needs to avoid packaging it again.
   *
   * @param {string} id
   * @param {string} reason
   * @returns {Promise<SkillLibraryEntry | null>}
   */
  async retire(id, reason) {
    const entry = await this.get(id);
    if (!entry) return null;
    return this.update(id, {
      status: 'retired',
      notes: reason ? `${entry.notes ? `${entry.notes}\n` : ''}${reason}` : entry.notes,
    });
  }

  /** @param {string} id */
  async remove(id) {
    const library = await this.read();
    const entries = library.entries.filter((entry) => entry.id !== id);
    if (entries.length === library.entries.length) return false;
    await this.write(entries);
    return true;
  }

  /**
   * Record that a skill was dispatched, and how it went.
   *
   * @param {string} id
   * @param {{ success?: boolean }} [outcome]
   * @returns {Promise<SkillLibraryEntry | null>}
   */
  async recordUse(id, outcome = {}) {
    const entry = await this.get(id);
    if (!entry) return null;
    return this.update(id, {
      usageCount: entry.usageCount + 1,
      successCount: outcome.success ? entry.successCount + 1 : entry.successCount,
      lastUsedAt: Date.now(),
    });
  }

  /**
   * Rank the active entries against a task description.
   *
   * @param {string} text
   * @param {{ limit?: number }} [options]
   * @returns {Promise<(SkillLibraryEntry & { score: number, matchedTriggers: string[] })[]>}
   */
  async match(text, options = {}) {
    const limit = options.limit ?? 5;
    const query = String(text ?? '').toLowerCase().trim();
    if (!query) return [];

    const entries = await this.list();
    const scored = [];
    for (const entry of entries) {
      // A stale entry points at a skill that is no longer there, and a retired one was
      // tried and rejected. Offering either is how the boss re-dispatches a known-bad skill.
      if (entry.status !== 'active') continue;
      const { score, matchedTriggers } = scoreEntry(entry, query);
      if (score <= 0) continue;
      scored.push({ ...entry, score, matchedTriggers });
    }

    scored.sort((a, b) => b.score - a.score || (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0));
    return scored.slice(0, limit);
  }

  /**
   * Check that every registered skill is still on disk and still the skill we registered.
   *
   * The point is not to maintain a list of files — the machine can be scanned for that. The
   * point is to catch the two failures that are invisible from the file list: a skill whose
   * file is gone, and a skill whose file was renamed behind the registry's back. Both leave
   * a registry entry that dispatches to nothing.
   *
   * @param {{ now?: number }} [options]
   * @returns {Promise<{
   *   checked: number, ok: number, stale: number, retired: number, candidates: number,
   *   problems: { id: string, skillName: string, reason: string }[],
   * }>}
   */
  async validate(options = {}) {
    const now = options.now ?? Date.now();
    const library = await this.read();
    const problems = [];
    let ok = 0;
    let stale = 0;
    let retired = 0;
    let candidates = 0;

    const entries = [];
    for (const entry of library.entries) {
      // A candidate has not been packaged yet, so it has no file to check. Validating it
      // would mark it broken and turn "识别到但还没封装" into "已失效" — two different
      // facts, and only the first one is true.
      if (entry.status === 'candidate') {
        candidates += 1;
        entries.push({ ...entry, lastValidatedAt: now });
        continue;
      }

      const problem = await this.#inspect(entry);
      const next = { ...entry, lastValidatedAt: now };

      if (entry.status === 'retired') {
        retired += 1;
        next.lastError = problem;
      } else if (problem) {
        stale += 1;
        next.status = 'stale';
        next.lastError = problem;
        problems.push({ id: entry.id, skillName: entry.skillName, reason: problem });
      } else {
        ok += 1;
        // A stale entry whose file came back is usable again. A retired one stays retired —
        // it was rejected for a reason that a returning file does not undo.
        next.status = 'active';
        next.lastError = null;
      }

      entries.push(next);
    }

    await this.write(entries);
    return { checked: entries.length, ok, stale, retired, candidates, problems };
  }

  /**
   * @returns {Promise<{ total: number, active: number, stale: number, retired: number, candidates: number, domains: string[] }>}
   */
  async stats() {
    const entries = await this.list();
    const domains = [...new Set(entries.map((entry) => entry.domain).filter(Boolean))];
    return {
      total: entries.length,
      active: entries.filter((entry) => entry.status === 'active').length,
      stale: entries.filter((entry) => entry.status === 'stale').length,
      retired: entries.filter((entry) => entry.status === 'retired').length,
      candidates: entries.filter((entry) => entry.status === 'candidate').length,
      domains,
    };
  }

  /**
   * Check one entry against the filesystem.
   *
   * @param {SkillLibraryEntry} entry
   * @returns {Promise<string|null>} the problem, or null when the entry is fine
   */
  async #inspect(entry) {
    if (!entry.path) return '未登记技能文件路径，无法校验';
    try {
      await stat(entry.path);
    } catch {
      return `技能文件不存在：${entry.path}`;
    }
    try {
      const raw = await readFile(entry.path, 'utf8');
      const meta = parseFrontmatter(raw);
      if (meta.name && meta.name !== entry.skillName) {
        return `技能名与注册名不一致（文件内为 ${meta.name}）`;
      }
    } catch (error) {
      return `技能文件读不出来：${error?.message ?? error}`;
    }
    return null;
  }

  /** @param {SkillLibraryEntry[]} entries */
  async write(entries) {
    await mkdir(this.dataDir, { recursive: true });
    const payload = `${JSON.stringify({
      version: SKILL_LIBRARY_VERSION,
      updatedAt: Date.now(),
      entries,
    }, null, 2)}\n`;

    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const temporary = `${this.path}.${process.pid}.${Date.now()}.${randomBytes(6).toString('hex')}.tmp`;
      try {
        await writeFile(temporary, payload, 'utf8');
        await rename(temporary, this.path);
        return;
      } catch (error) {
        lastError = error;
        await rm(temporary, { force: true }).catch(() => {});
        await delay(20 * (attempt + 1));
      }
    }
    throw lastError;
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

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
