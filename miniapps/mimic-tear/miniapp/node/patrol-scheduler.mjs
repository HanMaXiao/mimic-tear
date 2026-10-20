/**
 * The board's own patrol schedule.
 *
 * The board runs a patrol loop of its own, on top of the duty cron. Two different clocks
 * belong to two different things and must not be mixed:
 *
 * - `lastRunAt` is the DUTY handover stamp. Only the duty path (the cron, via
 *   `patrol-cli report`) writes it. The board's "the boss went quiet" verdict reads it,
 *   so nothing else may ever refresh it — otherwise the board would keep a dead duty boss
 *   looking alive.
 * - `lastBoardPatrolAt` is the board's own clock. The board uses it to decide when its own
 *   loop is due, and nobody else touches it.
 *
 * These live in their own module so the scheduling rules can be tested without a server:
 * `server.mjs`'s timers are otherwise untestable, and an untested writer is exactly how the
 * original masking defect came back.
 */

/**
 * How long after the board's last patrol the next one is due.
 *
 * @param {number} intervalMinutes
 * @returns {number} milliseconds
 */
export function patrolIntervalMs(intervalMinutes) {
  const minutes = Number(intervalMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) return 15 * 60_000;
  return minutes * 60_000;
}

/**
 * Whether the board's own patrol loop is due.
 *
 * A configuration written before this field existed has no `lastBoardPatrolAt`, which means
 * "never ran" — so the first tick is due immediately.
 *
 * @param {{lastBoardPatrolAt?:number|null, intervalMinutes?:number}} config
 * @param {number} [now]
 * @returns {boolean}
 */
export function isPatrolDue(config, now = Date.now()) {
  const since = Number(config?.lastBoardPatrolAt) || 0;
  return now - since >= patrolIntervalMs(config?.intervalMinutes);
}

/**
 * What the board's own patrol loop should do on this tick.
 *
 * - `skip`: not enabled, or not due yet.
 * - `stamp`: due, but nothing decision-relevant changed — move the clock and stop.
 * - `run`: due, and something changed — run a patrol round.
 *
 * @param {{enabled?:boolean, lastBoardPatrolAt?:number|null, intervalMinutes?:number}} config
 * @param {boolean} signatureMatches whether the inbox signature is unchanged since the last round
 * @param {number} [now]
 * @returns {'skip'|'stamp'|'run'}
 */
export function boardPatrolAction(config, signatureMatches, now = Date.now()) {
  if (!config?.enabled) return 'skip';
  if (!isPatrolDue(config, now)) return 'skip';
  return signatureMatches ? 'stamp' : 'run';
}

/**
 * Advance the board's own patrol clock.
 *
 * It writes `lastBoardPatrolAt` and deliberately leaves `lastRunAt` alone: the duty handover
 * stamp belongs to the duty path only. Writing it here would let the board keep a duty boss
 * that is actually dead looking "on duty" for another threshold window.
 *
 * @param {{setConfig: (patch: any) => Promise<any>}} patrol
 * @param {number} [now]
 * @returns {Promise<number>} the stamp that was written
 */
export async function stampBoardPatrol(patrol, now = Date.now()) {
  await patrol.setConfig({ lastBoardPatrolAt: now });
  return now;
}
