/**
 * When the duty boss hands over, the conversation has to hear about it.
 *
 * The duty boss runs in its own process, so a duty round does not touch the runtime
 * revision the board polls. Without this, the conversation would only ever show the rounds
 * that happened before it was opened — the user would open the board and see an old
 * picture of what the boss was doing, which is exactly the gap this closes.
 *
 * The rule is deliberately tiny: the handover stamp changed → announce it. It is kept here
 * as a pure function so it can be tested without a running server, the way
 * `patrol-scheduler.mjs` keeps the board's own scheduling rules testable.
 */

/**
 * @typedef {{ changed:boolean, rounds:any[]|null }} DutyAnnouncement
 */

/**
 * Decide whether a duty handover must be announced, and with what.
 *
 * @param {{ lastRunAt:number|null }} config the current patrol config
 * @param {number|null} lastAnnouncedRunAt the stamp that was announced last
 * @returns {{ changed:boolean }}
 */
export function dutyAnnouncementNeeded(config, lastAnnouncedRunAt) {
  const lastRunAt = typeof config?.lastRunAt === 'number' ? config.lastRunAt : null;
  // A boss that never handed over is not an announcement; it is simply nothing yet.
  if (lastRunAt === null) return { changed: false };
  return { changed: lastRunAt !== lastAnnouncedRunAt };
}
