import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/**
 * One write queue per data directory.
 *
 * Two writers that share a directory must not interleave a read-modify-write: whoever writes
 * last would silently drop the other's field — and the field being dropped can be the duty
 * handover stamp, which makes the board report a boss that actually handed over.
 *
 * @type {Map<string, Promise<unknown>>}
 */
const writeQueues = new Map();

/**
 * Durable state for the boss's proactive patrol.
 *
 * Two files live next to the other Mini App state:
 *  - `patrol.json`        — findings raised by past patrol runs
 *  - `patrol-config.json` — whether patrol runs, how often, and whether it may dispatch
 *
 * The findings are written by the boss (through the Mini App) and read back by the board,
 * so a patrol that ran while the board was closed is still visible when it reopens.
 */

/**
 * @typedef {{ id:string, createdAt:number, projectId:number|null, projectName:string|null,
 *             severity:'high'|'medium'|'low', title:string, body:string,
 *             acknowledged:boolean, acknowledgedBy:'user'|'boss'|null, note:string }} PatrolFinding
 * @typedef {{ enabled:boolean, intervalMinutes:number, autoDispatch:boolean,
 *             dutyIntervalMinutes:number,
 *             lastRunAt:number|null, lastBoardPatrolAt:number|null,
 *             lastSignature:string|null }} PatrolConfig
 */

const DEFAULT_CONFIG = {
  enabled: false,
  intervalMinutes: 15,
  autoDispatch: false,
  // How often the boss is expected to hand over, in minutes. This is the duty cron's own
  // period (currently 30), NOT the board's patrol loop. The board's "the boss went quiet"
  // warning is derived from it, so the two must be changed together.
  dutyIntervalMinutes: 30,
  // lastRunAt is the DUTY handover stamp, written only by the duty path (patrol-cli report).
  // The board's own patrol loop has its own stamp below: sharing one timestamp would let a
  // board-triggered patrol refresh the duty clock and hide a duty boss that is actually dead.
  lastRunAt: null,
  lastBoardPatrolAt: null,
  lastSignature: null,
};

export class PatrolStore {
  /** @param {string} dataDir */
  constructor(dataDir) {
    this.dataDir = resolve(dataDir);
    this.findingsPath = join(this.dataDir, 'patrol.json');
    this.configPath = join(this.dataDir, 'patrol-config.json');
    this.answeredPath = join(this.dataDir, 'patrol-answered.json');
  }

  /**
   * Run a write task after every previously queued write on this directory has settled.
   *
   * Writes are read-modify-write, so two of them racing would drop one side's fields. The
   * queue is shared per directory rather than per instance: the board can hold two stores on
   * the same directory, and the duty path writes from a separate process entirely.
   *
   * @template T
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  enqueue(task) {
    const previous = writeQueues.get(this.dataDir) ?? Promise.resolve();
    const run = previous.then(task, task);
    writeQueues.set(this.dataDir, run.then(() => undefined, () => undefined));
    return run;
  }

  /** @returns {Promise<PatrolFinding[]>} */
  async list() {
    const value = await readJson(this.findingsPath, []);
    return Array.isArray(value) ? value : [];
  }

  /** @param {PatrolFinding[]} findings */
  async save(findings) {
    await writeJson(this.findingsPath, findings);
    return findings;
  }

  /**
   * @param {Omit<PatrolFinding, 'id'|'createdAt'|'acknowledged'>} input
   * @returns {Promise<PatrolFinding>}
   */
  async add(input) {
    return this.enqueue(async () => {
      const findings = await this.list();
      const finding = {
        id: `patrol_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        createdAt: Date.now(),
        acknowledged: false,
        acknowledgedBy: null,
        note: '',
        ...input,
      };
      findings.unshift(finding);
      // Keep the history bounded; the board only ever shows the recent tail.
      await this.save(findings.slice(0, 100));
      return finding;
    });
  }

  /**
   * Take a finding off the user's desk.
   *
   * `by: 'user'` is the board's 标记已知 — the user has seen it. `by: 'boss'` is the boss
   * withdrawing a conclusion of its own that turned out to be wrong (a stale fact, a duplicate,
   * an alarm that was not real). The boss needs that: without it, a finding that turned out to
   * be obsolete would sit in the inbox forever, and the list the user sees stops being a
   * screened list.
   *
   * @param {string} id
   * @param {'user'|'boss'} [by]
   * @param {string} [note]
   * @returns {Promise<boolean>}
   */
  async ack(id, by = 'user', note = '') {
    return this.enqueue(async () => {
      const findings = await this.list();
      const target = findings.find((f) => f.id === id);
      if (target) {
        target.acknowledged = true;
        target.acknowledgedBy = by;
        target.note = note;
        await this.save(findings);
      }
      return Boolean(target);
    });
  }

  /**
   * The boss retracting one of its own conclusions.
   *
   * @param {string} id
   * @param {string} reason why it no longer applies
   * @returns {Promise<boolean>}
   */
  async withdraw(id, reason) {
    return this.ack(id, 'boss', reason);
  }

  /**
   * Questions the boss already answered on the user's behalf.
   *
   * The runtime does not always flip a questionnaire's status when the answer is delivered as
   * a message, so the board needs its own record to avoid asking the same question twice.
   *
   * @returns {Promise<{ requestId: string, sessionId: string, answeredAt: number, answer: string, rationale: string }[]>}
   */
  async listAnswered() {
    const value = await readJson(this.answeredPath, []);
    return Array.isArray(value) ? value : [];
  }

  /**
   * @param {{ requestId: string, sessionId: string, answer: string, rationale?: string }} entry
   */
  async markAnswered(entry) {
    return this.enqueue(async () => {
      const answered = await this.listAnswered();
      if (answered.some((item) => item.requestId === entry.requestId)) return answered;
      answered.unshift({
        requestId: entry.requestId,
        sessionId: entry.sessionId,
        answeredAt: Date.now(),
        answer: entry.answer ?? '',
        rationale: entry.rationale ?? '',
        optionIds: entry.optionIds ?? [],
      });
      await writeJson(this.answeredPath, answered.slice(0, 200));
      return answered;
    });
  }

  /** @param {string} requestId */
  async isAnswered(requestId) {
    const answered = await this.listAnswered();
    return answered.some((item) => item.requestId === requestId);
  }

  /** @returns {Promise<PatrolConfig>} */
  async getConfig() {
    const value = await readJson(this.configPath, {});
    return { ...DEFAULT_CONFIG, ...(value && typeof value === 'object' ? value : {}) };
  }

  /**
   * Apply a patch to the config.
   *
   * Only the fields this call actually sets are written. The duty path writes `lastRunAt`
   * and the board writes `lastBoardPatrolAt` + `lastSignature` — they are different fields,
   * so a whole-file overwrite that re-stamps the other writer's fields would drop them.
   * The file is therefore re-read immediately before writing, and only the patch rides on top.
   *
   * @param {Partial<PatrolConfig>} patch
   * @returns {Promise<PatrolConfig>}
   */
  async setConfig(patch) {
    const changes = {};
    for (const [key, value] of Object.entries(patch ?? {})) {
      if (key === 'intervalMinutes') {
        changes[key] = Math.min(240, Math.max(5, Number(value) || 15));
      } else if (key === 'dutyIntervalMinutes') {
        changes[key] = Math.min(240, Math.max(5, Number(value) || 30));
      } else if (key === 'enabled' || key === 'autoDispatch') {
        changes[key] = Boolean(value);
      } else {
        changes[key] = value;
      }
    }
    return this.enqueue(async () => {
      // Re-read right before writing so a concurrent writer's fields survive.
      const latest = await this.getConfig();
      const next = { ...latest, ...changes };
      await writeJson(this.configPath, next);
      return next;
    });
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

/**
 * Write JSON atomically.
 *
 * The temporary file name must be UNIQUE per write. Two writers share this file: the duty
 * path runs as its own process (`patrol-cli report`) and the board is a long-running Node
 * process. With a fixed `<path>.tmp` name, one writer's rename moves the file out from under
 * the other and the rename fails — and a failed write in the duty path means the handover
 * timestamp is silently lost, so the board reports a duty boss that actually handed over.
 *
 * A unique name plus a bounded retry turns that into a harmless transient error.
 */
async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const temporary = `${path}.${process.pid}.${Date.now()}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(temporary, payload, 'utf8');
      await rename(temporary, path);
      return;
    } catch (error) {
      lastError = error;
      await rm(temporary, { force: true }).catch(() => {});
      await delay(20 * (attempt + 1));
    }
  }
  throw lastError;
}

function delay(ms) {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

function dirname(path) {
  const index = path.lastIndexOf('\\') > path.lastIndexOf('/')
    ? path.lastIndexOf('\\')
    : path.lastIndexOf('/');
  return index <= 0 ? path.slice(0, 2) : path.slice(0, index);
}
