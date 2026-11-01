import { join, resolve } from 'node:path';

import { normalizeConclusionSource } from './view-model.mjs';
import { BoardStateStore } from './board-state.mjs';
import {
  assertConclusionBandwidth,
  assignDesk,
  DEFAULT_DESK_LIMIT,
  deskLimitFrom,
  mergeConclusion,
  mergeKey,
} from './patrol-rules.mjs';

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
 *             acknowledged:boolean, acknowledgedBy:'user'|'boss'|null, note:string,
 *             onDesk?:boolean, updatedAt?:number }} PatrolFinding
 * @typedef {{ enabled:boolean, intervalMinutes:number,
 *             dutyIntervalMinutes:number, deskLimit:number,
 *             lastRunAt:number|null, lastBoardPatrolAt:number|null,
 *             lastSignature:string|null }} PatrolConfig
 * @typedef {{ archivedAt:number, archivedBy:string, reason:string, count:number,
 *             findings:PatrolFinding[] }} PatrolArchiveBatch
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
  // 桌面上「需要你拍板」的结论条数上界。超出的结论**仍然记账**，只是先不上桌面——
  // 收件箱是给人看的，不是账本。
  deskLimit: DEFAULT_DESK_LIMIT,
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
    // 结论账、归档账、已答项、巡检配置**都在板面状态的单一 store 里**
    // （`board-state.mjs`）——一个文件一把锁一条写路径。老文件只在第一次访问时被读一次
    // （一次性迁移），之后不再被读。
    this.state = new BoardStateStore(this.dataDir);
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
   * 每条结论还带一个 `onDesk` 标记：它是不是占着桌面上「需要你拍板」的那几个名额。
   * 超上界的结论**照样在账上**（`alreadyReported` 靠它去重），只是标记成「不在桌面」。
   *
   * @returns {Promise<PatrolFinding[]>}
   */
  async list() {
    const raw = await this.#readFindings();
    const findings = raw.map((finding) => ({
      ...finding,
      source: normalizeConclusionSource(finding?.source, 'board'),
    }));
    return assignDesk(findings, deskLimitFrom(await this.getConfig()));
  }

  /** @param {PatrolFinding[]} findings */
  async save(findings) {
    const assigned = assignDesk(findings ?? [], deskLimitFrom(await this.getConfig()));
    await this.state.update((state) => ({ ...state, findings: assigned }));
    return assigned;
  }

  /**
   * 账上的原始结论（不做桌面分配）。
   *
   * 写路径用它读、写；`list()` 在它上面再叠一层桌面名额。
   *
   * @returns {Promise<PatrolFinding[]>}
   */
  async #readFindings() {
    return this.state.section('findings');
  }

  /**
   * Add one conclusion to the pool.
   *
   * The origin defaults to `duty` because the store's main writer is the duty path —
   * the CLI the boss calls from its cron round. The board's own patrol loop says so
   * explicitly (`source: 'board'`), and the watchdog's notices are duty-side news
   * about the duty chain, so they read as `duty` too.
   *
   * 两道纪律在这一层生效，因为这一层是**两条写路径共同的入口**（CLI 的 report 与看板的
   * 巡检都走它）：
   *
   * - **带宽**：超过 100 词的结论直接被拒绝。截断会把大哥的话改掉，而大哥需要知道自己
   *   写超了。
   * - **同类合并**：同一个项目、同一个严重度、还没被确认过的那条，就是同一件事——新报
   *   的并进去，而不是在收件箱里再占一个位置。
   *
   * @param {Omit<PatrolFinding, 'id'|'createdAt'|'acknowledged'|'source'> & {source?:'duty'|'board'}} input
   * @returns {Promise<PatrolFinding>}
   */
  async add(input) {
    // 带宽纪律：超限的结论进不来账。抛错，不是静默丢弃——被拒绝的理由必须说得清。
    assertConclusionBandwidth(input);
    const deskLimit = deskLimitFrom(await this.getConfig());
    return this.enqueue(async () => {
      /** @type {any} */
      let stored = null;
      // 读-改-写**一次做完**（store 的锁内）：两个进程同时报一条时，
      // 后一个看见的是前一个写进去的账，不会把它挤掉。
      await this.state.update((state) => {
        const findings = [...state.findings];
        const finding = {
          id: `patrol_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
          createdAt: Date.now(),
          acknowledged: false,
          acknowledgedBy: null,
          note: '',
          ...input,
          source: normalizeConclusionSource(input?.source, 'duty'),
        };

        // 同类合并。账是新的在前，所以第一个命中的就是**最近**的那条同键未确认结论。
        // 已确认的不参与合并：确认过的问题又冒出来，那是新的一件事。
        const key = mergeKey(finding);
        const target = findings.find((item) => !item?.acknowledged && mergeKey(item) === key);
        if (target) {
          stored = mergeConclusion(target, finding);
          findings[findings.indexOf(target)] = stored;
        } else {
          findings.unshift(finding);
          stored = finding;
        }

        // Keep the history bounded; the board only ever shows the recent tail.
        return { ...state, findings: assignDesk(findings.slice(0, 100), deskLimit) };
      });
      return stored;
    });
  }

  /**
   * 把账上的结论搬进归档账，然后清空账本。
   *
   * **一条都不删**：退场的结论连同原文搬进归档账，并附上这次归档的元数据
   * （什么时候、谁、为什么、多少条）。
   *
   * 收口之后这一步是**一次原子写**：搬走和清账本在同一个 store 更新里，要么都成，要么都不成。
   * （以前是两个文件、两次写——「先写归档，再清账本」，中间崩了就两本账对不上。）
   *
   * @param {{ reason?:string, by?:string }} [options]
   * @returns {Promise<{ archived:number, reason:string, archivedBy:string, archivedAt:number }>}
   */
  async archive(options = {}) {
    const reason = String(options?.reason ?? '').trim();
    if (!reason) {
      throw new Error('归档必须带理由——退场的原因是后来人判断「这事还该不该管」的唯一依据');
    }
    const archivedBy = String(options?.by ?? 'boss');
    return this.enqueue(async () => {
      /** @type {any} */
      let result = null;
      await this.state.update((state) => {
        const findings = state.findings;
        const archivedAt = Date.now();
        const batch = { archivedAt, archivedBy, reason, count: findings.length, findings };
        const archive = state.archive;
        result = { archived: findings.length, reason, archivedBy, archivedAt };
        return {
          ...state,
          // 账本清空——桌面腾干净了，但内容全在归档账里。
          findings: [],
          archive: {
            version: archive.version ?? 1,
            updatedAt: archivedAt,
            total: (archive.total ?? 0) + findings.length,
            batches: [batch, ...(archive.batches ?? [])],
          },
        };
      });
      return result;
    });
  }

  /**
   * 归档账：每一批退场的结论与它的元数据。
   *
   * @returns {Promise<{ version:number, updatedAt:number, total:number, batches:PatrolArchiveBatch[] }>}
   */
  async listArchive() {
    const archive = await this.#readArchive();
    const batches = Array.isArray(archive.batches) ? archive.batches : [];
    return {
      version: archive.version ?? 1,
      updatedAt: archive.updatedAt ?? 0,
      total: batches.reduce((sum, batch) => sum + (batch?.findings?.length ?? 0), 0),
      batches,
    };
  }

  /**
   * 归档过的结论（平的列表）。
   *
   * 它们不在账上了，但**仍然是大哥报过的事**——去重账要能看见它们，否则同一个问题会被
   * 反复报出来。
   *
   * @returns {Promise<PatrolFinding[]>}
   */
  async listArchivedFindings() {
    const archive = await this.listArchive();
    return archive.batches.flatMap((batch) => batch?.findings ?? []);
  }

  /** @returns {Promise<any>} */
  async #readArchive() {
    return this.state.section('archive');
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
    return this.state.section('answered');
  }

  /**
   * @param {{ requestId: string, sessionId: string, answer: string, rationale?: string }} entry
   */
  async markAnswered(entry) {
    return this.enqueue(async () => {
      /** @type {any[]} */
      let answered = [];
      /** @type {boolean} */
      let recorded = false;
      await this.state.update((state) => {
        const current = [...state.answered];
        // 幂等：同一个 requestId 只记一次。
        if (!current.some((item) => item.requestId === entry.requestId)) {
          current.unshift({
            requestId: entry.requestId,
            sessionId: entry.sessionId,
            answeredAt: Date.now(),
            answer: entry.answer ?? '',
            rationale: entry.rationale ?? '',
            optionIds: entry.optionIds ?? [],
          });
          recorded = true;
        }
        answered = current.slice(0, 200);
        return { ...state, answered: answered };
      });
      // 记过的那张卡**不再记一次投递**——否则同一张卡会在派工账里出现两条。
      if (!recorded) return answered;

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
    return this.state.section('dispatches');
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
   * **两个写者现在写的是同一段、锁的是同一把锁**——收口进 `board-state.mjs` 之后，
   * 这段账只有一条写路径。
   *
   * @param {DispatchRecord} record
   * @returns {Promise<void>}
   */
  async #appendDispatch(record) {
    await this.state.update((state) => ({
      ...state,
      dispatches: [...state.dispatches, record],
    }));
  }

  /** @param {string} requestId */
  async isAnswered(requestId) {
    const answered = await this.listAnswered();
    return answered.some((item) => item.requestId === requestId);
  }

  /** @returns {Promise<PatrolConfig>} */
  async getConfig() {
    const stored = await this.state.section('config');
    // Only the fields this config actually has. A key left over from a removed feature
    // (`autoDispatch` was one — the boss decides for itself now) must not ride along in the
    // live state file forever: it reads like a switch that still does something.
    const config = { ...DEFAULT_CONFIG };
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      if (stored[key] !== undefined) config[key] = stored[key];
    }
    // 桌面上界归一：配置文件里手改的字符串或越界的数，读出来就是一个合法的数。
    config.deskLimit = deskLimitFrom(config);
    return config;
  }

  /**
   * Apply a patch to the config.
   *
   * Only the fields this call actually sets are written. The duty path writes `lastRunAt`
   * and the board writes `lastBoardPatrolAt` + `lastSignature` — they are different fields,
   * so a whole-file overwrite that re-stamps the other writer's fields would drop them.
   * The store therefore re-reads inside the lock immediately before writing, and only the
   * patch rides on top.
   *
   * **没传的字段不动。** 调用方只说「把桌面上界改成 30」，不该顺手把巡检开关关掉——
   * `undefined` 会被 `Boolean(undefined)` 变成 `false`，那是一次没人要求的改动。
   *
   * @param {Partial<PatrolConfig>} patch
   * @returns {Promise<PatrolConfig>}
   */
  async setConfig(patch) {
    const changes = {};
    for (const [key, value] of Object.entries(patch ?? {})) {
      if (value === undefined) continue;
      if (key === 'intervalMinutes') {
        changes[key] = Math.min(240, Math.max(5, Number(value) || 15));
      } else if (key === 'dutyIntervalMinutes') {
        changes[key] = Math.min(240, Math.max(5, Number(value) || 30));
      } else if (key === 'deskLimit') {
        changes[key] = Math.min(500, Math.max(1, Number(value) || DEFAULT_DESK_LIMIT));
      } else if (key === 'enabled') {
        changes[key] = Boolean(value);
      } else {
        changes[key] = value;
      }
    }
    return this.enqueue(async () => {
      let next = {};
      await this.state.update((state) => {
        // 锁内重读：并发的另一个写者的字段不能被这次补丁盖掉。
        const latest = { ...DEFAULT_CONFIG };
        for (const key of Object.keys(DEFAULT_CONFIG)) {
          if (state.config[key] !== undefined) latest[key] = state.config[key];
        }
        next = { ...latest, ...changes };
        // 桌面上界归一后**再写**：配置文件里手改的字符串，写回去的是一个合法的数。
        next.deskLimit = deskLimitFrom(next);
        return { ...state, config: next };
      });
      return next;
    });
  }
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
 * 板面自己的账（派工、确认、排除、大哥会话）现在住在 `board-state.mjs` 的单一 store 里。
 * 这一层只管结论账与巡检配置。
 */
