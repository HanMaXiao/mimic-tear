import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { buildVocabulary, repairMojibake } from './text-repair.mjs';

/**
 * Reads the Goal-mode plan state a project writes to `<project>/.mavis/plans/`.
 *
 * Two artifacts are combined:
 *  - `status*.log` / `launch.log` — the human-readable status block, authoritative for
 *    each task's current state (`producing` / `ready` / `blocked` / `done`).
 *  - `*-plan*.yaml` — the plan definition, used to enrich tasks with a stable id and
 *    the agent that owns the task.
 *
 * The YAML is read with a tolerant line scanner, not a YAML parser: the package must stay
 * dependency-free, and only three scalar keys are needed.
 */

const STATE_TOKENS = new Set(['producing', 'ready', 'blocked', 'done', 'failed']);

const TASK_LINE = /^\s*\S+\s+(.*?)\s+\[([a-zA-Z-]+)\]\s*(.*)$/;
const YAML_TASK_START = /^\s*-\s+([A-Za-z_][\w-]*)\s*:\s*(.*)$/;
const YAML_KEY = /^\s+([A-Za-z_][\w-]*)\s*:\s*(.*)$/;
const BLOCK_SCALAR = /^[|>][-+]?\d*$/;

/**
 * @typedef {'producing'|'ready'|'blocked'|'done'|'failed'|'unknown'} PlanTaskState
 * @typedef {{ id: string|null, title: string, state: PlanTaskState, assignedTo: string|null }} PlanTask
 * @typedef {{ source: string, updatedAt: number, tasks: PlanTask[] }} PlanSnapshot
 */

/**
 * Read the plan snapshot of a project.
 *
 * Two artifacts are combined, each for what it is good at:
 *  - `*-plan*.yaml` — the task list. It carries stable ids, owners and clean UTF-8 titles.
 *  - `status*.log` / `launch.log` — the state machine. It says which track is producing,
 *    ready or blocked, but its CJK text can be mojibake (see `text-repair.mjs`).
 *
 * Titles therefore come from the YAML and states from the log, matched by the leading task
 * code (`V1.4-A`). A log track such as `V1.4-A` governs every YAML task under it
 * (`V1.4-A1`, `V1.4-A2`), because the log tracks whole tracks while the YAML lists tasks.
 *
 * @param {string} projectDir absolute project directory
 * @returns {Promise<PlanSnapshot|null>} null when the project has no plan state
 */
export async function readPlan(projectDir) {
  const plansDir = join(projectDir, '.mavis', 'plans');

  let entries;
  try {
    entries = await readdir(plansDir);
  } catch {
    return null;
  }

  const planName = await pickNewest(plansDir, entries, (name) => name.endsWith('.yaml') || name.endsWith('.yml'));
  const logName = await pickNewest(plansDir, entries, (name) =>
    name === 'launch.log' || (name.startsWith('status') && name.endsWith('.log')));

  if (!planName && !logName) return null;

  const rawPlan = planName ? await readText(join(plansDir, planName)) : null;
  const rawLog = logName ? await readText(join(plansDir, logName)) : null;
  if (rawPlan === null && rawLog === null) return null;

  // The YAML is the clean artifact; use it to teach the repairer the project's vocabulary.
  const planText = rawPlan === null ? null : repairMojibake(rawPlan);
  const vocabulary = buildVocabulary(planText ?? '');
  const logText = rawLog === null ? null : repairMojibake(rawLog, vocabulary);

  const definitions = planText === null ? [] : parsePlanYaml(planText);
  const logTasks = logText === null ? [] : parseStatusLog(logText);

  if (definitions.length === 0 && logTasks.length === 0) return null;

  const logStats = logName
    ? await stat(join(plansDir, logName)).catch(() => null)
    : null;

  return {
    source: join('.mavis', 'plans', logName ?? planName),
    updatedAt: logStats?.mtimeMs ?? 0,
    tasks: mergeTasks(definitions, logTasks),
  };
}

/**
 * Combine YAML task definitions with log states.
 *
 * A log entry governs a YAML task when its code equals the YAML code, or when the YAML code
 * extends it with a numeric segment (`V1.4-A` governs `V1.4-A1`). The longest matching code
 * wins, so a track-level entry never shadows a more specific one.
 */
function mergeTasks(definitions, logTasks) {
  const logByCode = new Map();
  for (const entry of logTasks) {
    const code = taskCode(entry.title);
    if (code && !logByCode.has(code)) logByCode.set(code, entry);
  }

  const used = new Set();
  const merged = [];

  for (const definition of definitions) {
    const code = taskCode(definition.title);
    let best = null;
    for (const [logCode, entry] of logByCode) {
      if (!code || !governs(logCode, code)) continue;
      if (!best || logCode.length > best.code.length) best = { code: logCode, entry };
    }
    if (best) used.add(best.code);
    merged.push({
      id: definition.id || null,
      title: definition.title,
      state: best ? best.entry.state : 'unknown',
      assignedTo: definition.assignedTo,
    });
  }

  // Log entries the YAML does not know about still carry real work.
  for (const [code, entry] of logByCode) {
    if (used.has(code)) continue;
    if (merged.some((task) => taskCode(task.title) === code)) continue;
    merged.push({ id: null, title: entry.title, state: entry.state, assignedTo: null });
  }

  return merged;
}

/**
 * Does a log code govern a YAML code?
 * `V1.4-A` governs `V1.4-A1`; `V1.4` does not govern `V1.4-A1` (that is a different track).
 */
function governs(logCode, yamlCode) {
  if (logCode === yamlCode) return true;
  if (!yamlCode.startsWith(logCode)) return false;
  const next = yamlCode[logCode.length];
  return next !== undefined && next >= '0' && next <= '9';
}

/** Parse the `Tasks:` block of a status log into task entries. */
export function parseStatusLog(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*Tasks\s*:\s*$/.test(line));
  if (start === -1) return [];

  const tasks = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) continue;
    const match = TASK_LINE.exec(line);
    if (!match) continue;
    const [, title, rawState] = match;
    const state = STATE_TOKENS.has(rawState) ? rawState : 'unknown';
    tasks.push({ id: null, title: title.trim(), state, assignedTo: null });
  }
  return tasks;
}

/**
 * Extract `id` / `title` / `assigned_to` from the `tasks:` list of a plan YAML.
 * @param {string|null} text
 * @returns {{ id: string, title: string, assignedTo: string|null }[]}
 */
export function parsePlanYaml(text) {
  if (!text) return [];

  const definitions = [];
  let current = null;
  let inTasks = false;
  let blockIndent = -1;

  for (const rawLine of text.split(/\r?\n/)) {
    if (blockIndent >= 0) {
      // Inside a block scalar: skip until a line dedents past the block's own indentation.
      if (rawLine.trim() === '' || rawLine.search(/\S/) > blockIndent) continue;
      blockIndent = -1;
    }

    if (!inTasks) {
      if (/^tasks\s*:\s*$/.test(rawLine)) inTasks = true;
      continue;
    }

    const taskStart = YAML_TASK_START.exec(rawLine);
    if (taskStart) {
      const [, key, value] = taskStart;
      current = { id: '', title: '', assignedTo: null };
      if (key === 'id') current.id = unquote(value);
      else if (key === 'title') current.title = unquote(value);
      else if (key === 'assigned_to') current.assignedTo = unquote(value);
      if (current.id || current.title) definitions.push(current);
      else current = null;
      continue;
    }

    const keyValue = YAML_KEY.exec(rawLine);
    if (keyValue && current) {
      const [, key, value] = keyValue;
      if (key === 'id') current.id = unquote(value);
      else if (key === 'title') current.title = unquote(value);
      else if (key === 'assigned_to') current.assignedTo = unquote(value);
      if (BLOCK_SCALAR.test(value.trim())) blockIndent = rawLine.search(/\S/);
      continue;
    }

    if (rawLine.trim() === '') continue;
    if (!/^\s/.test(rawLine)) inTasks = false;
  }

  return definitions.filter((d) => d.title || d.id);
}

/** Leading task code of a title: `V1.4-A: LogRule …` → `V1.4-A`. */
function taskCode(title) {
  if (!title) return '';
  const head = title.split(/[:：]/)[0].trim();
  const match = /^[A-Za-z0-9][A-Za-z0-9._-]*/.exec(head);
  return match ? match[0] : '';
}

function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

async function readText(path) {
  try {
    const buffer = await readFile(path);
    return decodeText(buffer);
  } catch {
    return null;
  }
}

/**
 * Decode a text file, honouring byte-order marks.
 *
 * The Goal-mode plan writer emits UTF-16LE (with BOM) on Windows, while the YAML plan and
 * other artifacts may be plain UTF-8. Decoding UTF-16LE bytes as UTF-8 yields interleaved
 * NUL characters and silently breaks every line match, so the encoding must be resolved
 * before any parsing happens.
 */
export function decodeText(buffer) {
  if (buffer.length >= 2) {
    if (buffer[0] === 0xff && buffer[1] === 0xfe) {
      return new TextDecoder('utf-16le').decode(buffer.subarray(2));
    }
    if (buffer[0] === 0xfe && buffer[1] === 0xff) {
      return new TextDecoder('utf-16be').decode(buffer.subarray(2));
    }
  }
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(buffer.subarray(3));
  }

  const utf8 = new TextDecoder('utf-8').decode(buffer);
  if (utf8.includes('\u0000')) {
    // UTF-16 without a BOM: NUL bytes appear between every ASCII character.
    const utf16 = new TextDecoder('utf-16le').decode(buffer);
    if (!utf16.includes('\u0000')) return utf16;
  }
  return utf8;
}

/** Pick the most recently modified entry matching a predicate. */
async function pickNewest(dir, entries, predicate) {
  const candidates = entries.filter(predicate);
  if (candidates.length === 0) return null;

  let best = null;
  let bestTime = -1;
  for (const name of candidates) {
    const stats = await stat(join(dir, name)).catch(() => null);
    const time = stats?.mtimeMs ?? 0;
    if (time > bestTime) {
      bestTime = time;
      best = name;
    }
  }
  return best;
}
