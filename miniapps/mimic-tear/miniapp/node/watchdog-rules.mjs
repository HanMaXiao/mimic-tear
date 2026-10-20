/**
 * The watchdog's decision rules.
 *
 * The watchdog watches the duty boss from outside the Mini App process: the board is
 * on-demand, so when the app is closed nobody can see the "the boss went quiet" line.
 * This module answers one question — *should I say something right now?* — and nothing else.
 *
 * Two rules are load-bearing:
 *
 * 1. **The liveness verdict is not re-implemented here.** `evaluateDuty` is a thin wrapper
 *    around `buildDutyStatus`, the same pure function the board and `patrol-cli` use. A
 *    watchdog that carried its own copy of the threshold formula would eventually disagree
 *    with the board about whether the boss is alive, and the user would have no way to tell
 *    which one to believe. One formula, one source.
 * 2. **Silence is the default.** The watchdog runs every few minutes; a watcher that
 *    shouted on every tick would be worse than no watcher at all. It speaks only when the
 *    state flips, and it says the same thing once per outage.
 */

import { buildDutyStatus } from './view-model.mjs';

/**
 * @typedef {'stale'|'recovered'|'none'} WatchdogAction
 */

/**
 * @typedef {{
 *   observedStale:boolean|null,   // the fact: is the boss quiet? (null = never observed)
 *   notifiedStale:boolean|null,   // what the user has been told (null = never told)
 *   staleSince:number|null,       // when the silence began
 *   lastNotifiedAt:number|null,
 *   failedDeliveries:number,
 *   checkedAt:number|null,
 * }} WatchdogState
 */

/**
 * The duty boss's liveness, read through the board's own rule.
 *
 * @param {{lastRunAt?:number|null, dutyIntervalMinutes?:number}} config
 * @param {number} [now]
 * @returns {ReturnType<typeof buildDutyStatus>}
 */
export function evaluateDuty(config, now = Date.now()) {
  return buildDutyStatus({ config: config ?? {}, findings: [], now });
}

/**
 * A fresh watchdog state — no baseline yet.
 *
 * `notifiedStale: null` means "the user has not been told anything yet", which is
 * different from "we told them it is fine". The distinction matters on the very first
 * run: a boss that has been silent for two hours should be reported immediately, while a
 * boss that has simply never handed over yet is not an outage — it is a boss that has not
 * started, and that is the user's business, not an incident.
 *
 * @returns {WatchdogState}
 */
export function emptyWatchdogState() {
  return {
    observedStale: null,
    notifiedStale: null,
    staleSince: null,
    lastNotifiedAt: null,
    failedDeliveries: 0,
    checkedAt: null,
  };
}

/**
 * What should the watchdog do on this tick?
 *
 * - `none`: nothing happened; stay quiet.
 * - `stale`: the boss has gone quiet; tell the user.
 * - `recovered`: the boss is back; tell the user it is back.
 *
 * The comparison is between what the user has been told (`notifiedStale`) and what is
 * true now (`duty.stale`). A watchdog that compared the truth against itself would
 * re-announce the same outage on every tick.
 *
 * The first run has no baseline, so it takes one extra step: it reports a boss that is
 * *already* long past the threshold (a real outage we just started watching), but stays
 * quiet about a boss that has never run at all.
 *
 * @param {WatchdogState} state
 * @param {ReturnType<typeof buildDutyStatus>} duty
 * @returns {WatchdogAction}
 */
export function decideAction(state, duty) {
  const previous = state?.notifiedStale ?? null;
  const current = Boolean(duty?.stale);

  if (previous === null) {
    // First observation. `neverRan` means "has not started", not "has fallen over":
    // reporting that as an outage would cry wolf the moment the watchdog was installed.
    if (current && duty?.neverRan) return 'none';
    return current ? 'stale' : 'none';
  }

  if (current && !previous) return 'stale';
  if (!current && previous) return 'recovered';
  return 'none';
}

/**
 * Record a *successful* notification — or a quiet tick.
 *
 * The "the user has been told" flag only advances when the notification actually landed.
 * A watchdog that marked an outage as reported before delivery would swallow the outage
 * silently — and the whole point of the watchdog is that a silent failure must not stay
 * silent.
 *
 * On a quiet tick (`none`) the baseline still moves, but it does **not** follow
 * `duty.stale` blindly: a boss that has never handed over yet is "not started", not
 * "recovered from an outage". Following it blindly would make the watchdog announce a
 * recovery for an outage it never announced in the first place.
 *
 * @param {WatchdogState} state
 * @param {WatchdogAction} action
 * @param {ReturnType<typeof buildDutyStatus>} duty
 * @param {number} now
 * @returns {WatchdogState}
 */
export function applySuccess(state, action, duty, now) {
  const base = { ...state, checkedAt: now };

  if (action === 'stale') {
    return {
      ...base,
      observedStale: true,
      notifiedStale: true,
      // The silence began when the boss last handed over, not when we noticed it.
      staleSince: state?.staleSince ?? duty?.lastRunAt ?? now,
      lastNotifiedAt: now,
      failedDeliveries: 0,
    };
  }

  if (action === 'recovered') {
    return {
      ...base,
      observedStale: false,
      notifiedStale: false,
      staleSince: null,
      lastNotifiedAt: now,
      failedDeliveries: 0,
    };
  }

  // Quiet tick: establish the baseline without claiming a notification happened.
  // The observed fact follows the current observation; the "told the user" flag only
  // moves when it was already set, because a quiet tick told the user nothing.
  const established = duty?.neverRan ? false : Boolean(duty?.stale);
  return {
    ...base,
    observedStale: established,
    notifiedStale: state?.notifiedStale ?? established,
  };
}

/**
 * Record a *failed* notification.
 *
 * The fact is remembered (the boss *is* quiet) but the "the user has been told" flag is
 * not: the user has not been told yet, so the next tick must try again.
 *
 * @param {WatchdogState} state
 * @param {WatchdogAction} action
 * @param {ReturnType<typeof buildDutyStatus>} duty
 * @param {number} now
 * @returns {WatchdogState}
 */
export function applyFailure(state, action, duty, now) {
  return {
    ...state,
    // The fact follows the current observation — a previous baseline of `false` must not
    // mask a boss that has since gone quiet. What stays put is the "the user has been
    // told" flag: they have not been told, so the next tick must try again.
    observedStale: Boolean(duty?.stale),
    notifiedStale: state?.notifiedStale ?? null,
    checkedAt: now,
    failedDeliveries: (state?.failedDeliveries ?? 0) + 1,
  };
}

/**
 * The text of a notification.
 *
 * It states the fact and the threshold rather than saying "the boss might be down":
 * a message that leaves the reader to work out how long counts as too long is a message
 * that gets ignored.
 *
 * @param {WatchdogAction} action
 * @param {{ duty: ReturnType<typeof buildDutyStatus>, staleSince:number|null, now:number,
 *           failedDeliveries?:number }} input
 * @returns {{ title:string, body:string }}
 */
export function buildAlertMessage(action, input) {
  const duty = input.duty;
  const failed = input.failedDeliveries ?? 0;
  const failureNote = failed > 0 ? `（此前有 ${failed} 次通知没能送达）` : '';

  if (action === 'recovered') {
    const downtime = input.staleSince ? Math.max(0, Math.round((input.now - input.staleSince) / 60_000)) : null;
    const since = downtime === null ? '' : `掉线持续约 ${downtime} 分钟。`;
    return {
      title: '仿身泪滴 · 大哥已归位',
      body: `已恢复交班。${since}你交代的事它会接着做。${failureNote}`.trim(),
    };
  }

  const age = duty.ageMinutes ?? 0;
  return {
    title: '仿身泪滴 · 大哥掉线',
    body: `已 ${age} 分钟没有交班（超过 ${duty.staleAfterMinutes} 分钟阈值）。`
      + '可能原因：MiniMax Code 被关闭，或值班轮次被中断。'
      + `打开应用即可恢复。${failureNote}`,
  };
}
