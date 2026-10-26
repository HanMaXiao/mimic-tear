/**
 * When the watchdog should wake up next.
 *
 * The problem this solves
 * ----------------------
 * The watchdog used to wake up every five minutes, unconditionally. That is a fixed
 * poll rate that has nothing to do with what it is watching: the duty boss hands over
 * every thirty minutes, so the *fact* it watches ("did the boss hand over?") changes at
 * most every thirty minutes. Polling six times per duty period is six times the
 * evidence for the same answer.
 *
 * And it is not free. Every tick starts a node process, opens the runtime database,
 * reads the scheduler's run log, writes its own state file and appends to the alert
 * log — 288 times a day, for a signal that moves twice an hour.
 *
 * The rule this module encodes
 * ---------------------------
 * **Wake up when the answer could have changed — not on a fixed timer.**
 *
 * The boss's next handover is *due* at a known moment (`duty.nextDueAt`). Nothing that
 * happens before that moment can change the verdict. So the next check is scheduled for
 * shortly after the next handover is due, not for "five minutes from now".
 *
 * Three exceptions, because there are moments where waiting is wrong:
 *
 * 1. **An alert failed to deliver.** The file is the channel, but the toast is the
 *    courtesy — and a failed delivery has to be retried. This is the one case where
 *    waiting longer would lose information.
 * 2. **The boss is already overdue.** If the handover was due and did not happen, the
 *    stale threshold may be near, and the verdict is about to change. Check more often.
 * 3. **The boss never ran.** There is no baseline to be overdue against, so the schedule
 *    cannot be derived from `nextDueAt`; fall back to the plain duty period.
 *
 * What this deliberately does NOT do
 * ----------------------------------
 * It does not decide *whether* to alert. That is `decideAction`'s job, and the two
 * questions — "should I say something?" and "when should I look again?" — must not be
 * answered by the same piece of logic. A watchdog that slept longer because it was
 * "not urgent" would stop noticing outages, and a watchdog that woke early because it
 * "felt like it" would be back to a fixed poll.
 */

/**
 * @typedef {object} NextCheckDecision
 * @property {number} nextCheckAt     epoch ms of the next check
 * @property {number} delayMinutes    how long that is from now (rounded, always >= 1)
 * @property {string} reason          why this schedule was chosen (for the board and the log)
 */

/**
 * The shortest gap the watchdog will ever schedule.
 *
 * One minute is the floor: the scheduler's own resolution is a minute, and a check
 * faster than that cannot see anything new.
 */
export const MIN_CHECK_INTERVAL_MINUTES = 1;

/**
 * The longest gap the watchdog will ever schedule.
 *
 * A cap matters: if the duty period were ever configured absurdly high, the watchdog
 * would sleep through the outage it exists to notice. Thirty minutes keeps it inside
 * the stale threshold whatever the configuration says.
 */
export const MAX_CHECK_INTERVAL_MINUTES = 30;

/**
 * How long after a handover is due the watchdog checks.
 *
 * Not zero: the handover is delivered a moment after it is scheduled, so checking in
 * the same instant would see the *previous* state and schedule itself again straight
 * away. One minute of grace is enough for the delivery to land.
 */
export const DUE_GRACE_MINUTES = 1;

/**
 * How often to check while an alert is waiting to be retried.
 *
 * A failed delivery is the one piece of information that gets *less* useful the longer
 * it waits, so it is retried briskly.
 */
export const RETRY_INTERVAL_MINUTES = 5;

/**
 * Decide when the watchdog should look again.
 *
 * @param {{duty:any, action:string, failedDeliveries?:number, now?:number}} input
 * @returns {NextCheckDecision}
 */
export function decideNextCheckAt(input) {
  const now = Number.isFinite(input?.now) ? input.now : Date.now();
  const duty = input?.duty ?? {};
  const action = input?.action ?? 'none';
  const failedDeliveries = Number(input?.failedDeliveries ?? 0) || 0;

  const periodMinutes = Number(duty.dutyIntervalMinutes) > 0 ? Number(duty.dutyIntervalMinutes) : 30;
  const staleAfterMinutes = Number(duty.staleAfterMinutes) > 0 ? Number(duty.staleAfterMinutes) : 45;

  const clamp = (minutes) => Math.min(
    MAX_CHECK_INTERVAL_MINUTES,
    Math.max(MIN_CHECK_INTERVAL_MINUTES, minutes),
  );

  // 1. A delivery that failed has to be retried, and soon.
  if (failedDeliveries > 0) {
    const delayMinutes = clamp(RETRY_INTERVAL_MINUTES);
    return {
      nextCheckAt: now + delayMinutes * 60_000,
      delayMinutes,
      reason: 'delivery_failed',
    };
  }

  // 2. The boss never ran: there is no next handover to be due, so the schedule cannot
  //    be derived from one. Fall back to the duty period.
  if (duty.neverRan) {
    const delayMinutes = clamp(periodMinutes);
    return {
      nextCheckAt: now + delayMinutes * 60_000,
      delayMinutes,
      reason: 'never_ran',
    };
  }

  // 3. The boss is already overdue: the handover was due and did not happen. The stale
  //    threshold is what turns that into an alarm, so check at a fraction of the way
  //    there — the verdict is about to change.
  const overdueMinutes = Number(duty.overdueMinutes);
  if (Number.isFinite(overdueMinutes) && overdueMinutes > 0) {
    const untilStale = staleAfterMinutes - (periodMinutes + overdueMinutes);
    const delayMinutes = clamp(Math.max(MIN_CHECK_INTERVAL_MINUTES, Math.min(untilStale, periodMinutes)));
    return {
      nextCheckAt: now + delayMinutes * 60_000,
      delayMinutes,
      reason: 'overdue',
    };
  }

  // 4. The healthy case: the boss is on schedule and the next handover is due at a
  //    known moment. Nothing before that moment can change the verdict, so sleep until
  //    just after it — with a floor of a minute, so a handover that is already late
  //    still gets noticed promptly.
  const nextDueAt = Number(duty.nextDueAt);
  if (Number.isFinite(nextDueAt) && nextDueAt > now) {
    const minutesUntilDue = (nextDueAt - now) / 60_000;
    const delayMinutes = clamp(Math.ceil(minutesUntilDue) + DUE_GRACE_MINUTES);
    return {
      nextCheckAt: now + delayMinutes * 60_000,
      delayMinutes,
      reason: 'awaiting_next_handover',
    };
  }

  // 5. `nextDueAt` is not in the future (a handover is already late, or the field is
  //    missing): the duty period is the safe answer.
  const delayMinutes = clamp(periodMinutes);
  return {
    nextCheckAt: now + delayMinutes * 60_000,
    delayMinutes,
    reason: 'fallback_period',
  };
}
