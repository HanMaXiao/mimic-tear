/**
 * The duty intent: is the boss on duty, or explicitly resting?
 *
 * Why this is its own file and not another field on the duty config:
 *
 * - The duty config (`patrol-config.json`) is the *fact* layer: the handover stamp, the
 *   periods, the switches. It is written by the duty path and read by the watchdog. Mixing
 *   an instruction into it means every reader that only wants facts has to know which
 *   fields to ignore.
 * - "Resting" is an instruction, not a fact. It says what the boss is *allowed* to do next,
 *   and it has to be writable without touching a single fact. The handover stamp in
 *   particular must never move on its account: the board's duty lamp follows duty facts
 *   only, so a resting boss is shown as resting, never as "stopped handing over".
 *
 * The intent is therefore one small file, written atomically, read by whoever cares:
 * the board (what is the boss doing), the fact sheet (what the boss should do next) and
 * the watchdog (an explicit rest is not an outage).
 *
 * @typedef {'on-duty'|'resting'} DutyMode
 * @typedef {{ mode:DutyMode, since:number|null, requestedBy:string|null, note:string }} DutyIntent
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** The modes a duty intent can carry. */
export const DUTY_MODES = Object.freeze(['on-duty', 'resting']);

/**
 * The state the boss is in when nobody said otherwise.
 *
 * "Nobody said otherwise" means on duty. A missing file is not evidence of a rest — it is
 * evidence of no decision, and the safe reading of "no decision" is the normal one.
 */
export const DEFAULT_DUTY_INTENT = Object.freeze({
  mode: 'on-duty',
  since: null,
  requestedBy: null,
  note: '',
});

/**
 * Coerce anything into a valid duty intent.
 *
 * The file on disk is written by a button and read by a watchdog, so it has to survive
 * being hand-edited, truncated or replaced with something else entirely. An unreadable
 * intent falls back to "on duty": a corrupt file must never buy a boss a free pass, and
 * it must never be able to switch the boss off either.
 *
 * @param {any} value
 * @returns {DutyIntent}
 */
export function normalizeDutyIntent(value) {
  if (!value || typeof value !== 'object') return { ...DEFAULT_DUTY_INTENT };
  const mode = DUTY_MODES.includes(value.mode) ? value.mode : DEFAULT_DUTY_INTENT.mode;
  return {
    mode,
    since: typeof value.since === 'number' && Number.isFinite(value.since) ? value.since : null,
    requestedBy: typeof value.requestedBy === 'string' && value.requestedBy.trim()
      ? value.requestedBy.trim()
      : null,
    note: typeof value.note === 'string' ? value.note : '',
  };
}

/**
 * The intent file.
 *
 * Reads are cheap and forgiving; writes are atomic. The atomicity matters because the
 * board (a long-running process) and the duty path (its own process) both write this
 * file: a half-written file would read back as "no decision" and silently put a resting
 * boss back on duty.
 */
export class DutyIntent {
  /** @param {string} dataDir */
  constructor(dataDir) {
    this.dataDir = resolve(dataDir);
    this.path = join(this.dataDir, 'duty-intent.json');
  }

  /**
   * The current intent. A missing or unreadable file means "on duty".
   *
   * @returns {Promise<DutyIntent>}
   */
  async read() {
    try {
      const raw = await readFile(this.path, 'utf8');
      if (!raw.trim()) return { ...DEFAULT_DUTY_INTENT };
      return normalizeDutyIntent(JSON.parse(raw));
    } catch {
      return { ...DEFAULT_DUTY_INTENT };
    }
  }

  /**
   * Write an intent.
   *
   * @param {Partial<DutyIntent>} intent
   * @returns {Promise<DutyIntent>}
   */
  async write(intent) {
    const next = normalizeDutyIntent(intent);
    await mkdir(this.dataDir, { recursive: true });
    const payload = `${JSON.stringify(next, null, 2)}\n`;
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const temporary = `${this.path}.${process.pid}.${Date.now()}.${randomBytes(6).toString('hex')}.tmp`;
      try {
        await writeFile(temporary, payload, 'utf8');
        await rename(temporary, this.path);
        return next;
      } catch (error) {
        lastError = error;
        await rm(temporary, { force: true }).catch(() => {});
      }
    }
    throw lastError;
  }

  /**
   * Switch the boss between on duty and resting.
   *
   * `since` is stamped on every switch, so the board can say how long the boss has been
   * resting instead of leaving the user to compare timestamps.
   *
   * @param {DutyMode} mode
   * @param {{ requestedBy?:string|null, note?:string }} [options]
   * @returns {Promise<DutyIntent>}
   */
  async setMode(mode, options = {}) {
    const target = DUTY_MODES.includes(mode) ? mode : DEFAULT_DUTY_INTENT.mode;
    return this.write({
      mode: target,
      since: Date.now(),
      requestedBy: options.requestedBy ?? null,
      note: options.note ?? '',
    });
  }
}
