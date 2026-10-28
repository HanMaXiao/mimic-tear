import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { normalizeConclusionSource } from './view-model.mjs';
import { readJsonArray, updateJsonArray, writeJsonAtomic } from './json-ledger.mjs';

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
 *             source:'duty'|'board',
 *             acknowledged:boolean, acknowledgedBy:'user'|'boss'|null, note:string }} PatrolFinding
 * @typedef {{ enabled:boolean, intervalMinutes:number,
 *             dutyIntervalMinutes:number,
 *             lastRunAt:number|null, lastBoardPatrolAt:number|null,
 *             lastSignature:string|null }} PatrolConfig
 * @typedef {{ id:string, idempotencyKey:string|null, source:'duty'|'board',
 *             projectId:number|null, projectName:string|null, targetSessionId:string|null,
 *             instruction:string, status:'queued'|'running'|'done'|'error',
 *             bossSessionId:string|null, text:string, error:string|null,
 *             createdAt:number, updatedAt:number }} DispatchRecord
 */

const DEFAULT_CONFIG = {
  enabled: false,
  intervalMinutes: 15,
  // How often the boss is expected to hand over, in minutes. This is the duty cron's own
  // period (currently 30), NOT the board's patrol loop. The board's "the boss went quiet"
  // warning is derived from it, so the two must be changed together.
  dutyIntervalMinutes: 30,
  // Which cron definition is the duty cron. The node side only reads it: when the
  // scheduler is re-pointed, this field has to follow, or the node side keeps reading a
  // chain that no longer exists — and "no runs" reads exactly like "nothing went wrong".
  dutyCronId: null,
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
    // The dispatch ledger is the BOARD's file (the board path writes it), but the duty
    // path writes into it too — that is the whole point of the ledger: both bosses'
    // deliveries end up in one place instead of two private histories.
    this.dispatchesPath = join(this.dataDir, 'dispatches.json');
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

  /**
   * Every conclusion in the pool, with its origin spelled out.
   *
   * A conclusion written before the `source` field existed carries no origin at all.
   * It is not dropped: it reads as `board` — the origin that produces conclusions with
   * no duty handover behind them.
   *
   * @returns {Promise<PatrolFinding[]>}
   */
  async list() {
    const value = await readJson(this.findingsPath, []);
    const list = Array.isArray(value) ? value : [];
    return list.map((finding) => ({
      ...finding,
      source: normalizeConclusionSource(finding?.source, 'board'),
    }));
  }

  /** @param {PatrolFinding[]} findings */
  async save(findings) {
    await writeJson(this.findingsPath, findings);
    return findings;
  }

  /**
   * Add one conclusion to the pool.
   *
   * The origin defaults to `duty` because the store's main writer is the duty path —
   * the CLI the boss calls from its cron round. The board's own patrol loop says so
   * explicitly (`source: 'board'`), and the watchdog's notices are duty-side news
   * about the duty chain, so they read as `duty` too.
   *
   * @param {Omit<PatrolFinding, 'id'|'createdAt'|'acknowledged'|'source'> & {source?:'duty'|'board'}} input
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
        source: normalizeConclusionSource(input?.source, 'duty'),
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

      // Answering a card on the boss's behalf IS a delivery: the duty boss sends its
      // conclusion to the owner session with the runtime's `session send`. That is a
      // dispatch, so it belongs in the dispatch ledger — otherwise the board's history
      // shows only what the board itself sent, and the two bosses drift apart in silence.
      //
      // The record is written here rather than through `recordDutyDispatch` on purpose:
      // that method queues on the same directory, and a queued task must never wait for
      // the task it is already inside of.
      //
      // Best-effort, and deliberately so: this runs inside the duty path's report, and
      // a report that throws means the round never hands over — the board would then
      // report a duty boss that actually did hand over. The answer itself is already
      // recorded above; the audit trail must not be able to cost the handover.
      try {
        await this.#appendDispatch(buildDutyDispatchRecord({
          targetSessionId: entry.sessionId,
          instruction: entry.answer ?? '',
          text: entry.rationale ?? '',
        }));
      } catch {
        // The ledger is an account of what was delivered, not the delivery itself.
      }
      return answered;
    });
  }

  /**
   * The dispatch ledger — both paths, in the order they were written.
   *
   * @returns {Promise<DispatchRecord[]>}
   */
  async listDispatches() {
    return readJsonArray(this.dispatchesPath);
  }

  /**
   * Record one delivery made by the duty path.
   *
   * The duty boss delivers with the runtime's `session send`, so before this the board's
   * dispatch history only ever showed the board path's own deliveries — and the two
   * bosses could tell different stories without the board noticing. The record is the
   * same shape as a board dispatch, with `source: 'duty'` so the client can label the
   * two differently later.
   *
   * The idempotency key stays OUT of the board's key space: a duty record carries
   * `idempotencyKey: null`, so `findDispatchByKey` can never match it and the board's
   * duplicate detection stays exactly what it was.
   *
   * A caller on the duty path should treat a failure as best-effort: the ledger is an
   * account of what was delivered, and a failed write must not cost the round its
   * handover.
   *
   * @param {{ projectId?:number|null, projectName?:string|null, targetSessionId?:string|null,
   *           instruction?:string, text?:string, status?:string, bossSessionId?:string|null,
   *           error?:string|null }} input
   * @returns {Promise<DispatchRecord>}
   */
  async recordDutyDispatch(input) {
    const record = buildDutyDispatchRecord(input);
    return this.enqueue(async () => {
      await this.#appendDispatch(record);
      return record;
    });
  }

  /**
   * Put one record into the dispatch ledger, keeping everybody else's records.
   *
   * The ledger has two writers: the board (its own process) and the duty path (a
   * separate one). A plain overwrite would drop the other side's record, and a dropped
   * board record breaks the board's idempotency — the same key would be delivered twice.
   *
   * @param {DispatchRecord} record
   * @returns {Promise<void>}
   */
  async #appendDispatch(record) {
    await appendToJsonArray(this.dispatchesPath, record);
  }

  /** @param {string} requestId */
  async isAnswered(requestId) {
    const answered = await this.listAnswered();
    return answered.some((item) => item.requestId === requestId);
  }

  /** @returns {Promise<PatrolConfig>} */
  async getConfig() {
    const value = await readJson(this.configPath, {});
    const stored = value && typeof value === 'object' ? value : {};
    // Only the fields this config actually has. A key left over from a removed feature
    // (`autoDispatch` was one — the boss decides for itself now) must not ride along in the
    // live state file forever: it reads like a switch that still does something.
    const config = { ...DEFAULT_CONFIG };
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      if (stored[key] !== undefined) config[key] = stored[key];
    }
    return config;
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
      } else if (key === 'enabled') {
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
 * The implementation now lives in `json-ledger.mjs`, shared with `persistence.mjs` — the
 * other writer of the dispatch ledger — so there is one discipline rather than two that
 * can drift apart.
 */
async function writeJson(path, value) {
  await writeJsonAtomic(path, value);
}

/**
 * Build a dispatch record for something the duty path delivered.
 *
 * `idempotencyKey` is deliberately null: the board path's keys live in their own
 * namespace, and a duty record must never be found by a board key lookup — that would
 * turn a fresh instruction into a false "already delivered".
 *
 * @param {{ projectId?:number|null, projectName?:string|null, targetSessionId?:string|null,
 *           instruction?:string, text?:string, status?:string, bossSessionId?:string|null,
 *           error?:string|null }} input
 * @returns {DispatchRecord}
 */
function buildDutyDispatchRecord(input) {
  const now = Date.now();
  return {
    id: `dsp_duty_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    idempotencyKey: null,
    source: 'duty',
    projectId: input?.projectId ?? null,
    projectName: input?.projectName ?? null,
    targetSessionId: input?.targetSessionId ?? null,
    instruction: typeof input?.instruction === 'string' ? input.instruction : '',
    status: input?.status ?? 'done',
    bossSessionId: input?.bossSessionId ?? null,
    text: typeof input?.text === 'string' ? input.text : '',
    error: input?.error ?? null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Merge one record into a list, replacing the record with the same id.
 *
 * @param {any[]} list
 * @param {any} record
 * @returns {any[]}
 */
function mergeById(list, record) {
  const index = list.findIndex((item) => item?.id === record.id);
  if (index === -1) return [...list, record];
  const next = [...list];
  next[index] = record;
  return next;
}

/**
 * Append one record to a JSON array file without losing anybody else's records.
 *
 * The dispatch ledger has two writers in two processes, and both do read-modify-write.
 * A plain overwrite drops whatever the other side wrote in the meantime — and a dropped
 * board record breaks the board's idempotency, because the same key would then be
 * delivered twice.
 *
 * The write discipline itself lives in `json-ledger.mjs`: unique temporary file name,
 * read-merge-write under a lock, rename, then check that our own record survived. It is
 * shared with `persistence.mjs` — the other writer of this very file — because two
 * implementations of the same discipline are two implementations that can drift apart.
 *
 * @param {string} path
 * @param {any} record
 * @returns {Promise<void>}
 */
async function appendToJsonArray(path, record) {
  await updateJsonArray(path, (all) => mergeById(all, record), record.id);
}
