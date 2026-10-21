/**
 * When the conversation changed.
 *
 * The Host chat side panel and the Mini App show the same runtime session, so a line said
 * in the panel is invisible to the page's own event stream: it does not move the runtime
 * revision (no session, goal or task changed). Without a separate detector the two views
 * would quietly disagree about what was said.
 *
 * The detector is a message count. It is kept here as a pure function so it can be tested
 * without a running server — the same reason `patrol-scheduler.mjs` holds the board's
 * scheduling rules.
 */

/**
 * @typedef {{ changed:boolean }} ChatHistoryChange
 */

/**
 * Whether the conversation grew since the last check.
 *
 * @param {number} currentCount messages in the session now
 * @param {number} lastCount messages counted last time
 * @returns {ChatHistoryChange}
 */
export function chatHistoryChanged(currentCount, lastCount) {
  const current = Number(currentCount) || 0;
  const previous = Number(lastCount) || 0;
  // A shrinking count means the session was swapped or reset; treat it as a change too,
  // otherwise the page would keep showing a transcript that no longer exists.
  return { changed: current !== previous };
}
