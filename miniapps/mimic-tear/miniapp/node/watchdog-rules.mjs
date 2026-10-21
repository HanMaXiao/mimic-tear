/**
 * The watchdog's decision rules.
 *
 * The watchdog watches the duty boss from outside the Mini App process: the board is
 * on-demand, so when the app is closed nobody can see the "the boss went quiet" line.
 * This module answers one question — *should I say something right now?* — and nothing else.
 *
 * Four rules are load-bearing:
 *
 * 1. **The liveness verdict is not re-implemented here.** `evaluateDuty` is a thin wrapper
 *    around `buildDutyStatus`, the same pure function the board and `patrol-cli` use. A
 *    watchdog that carried its own copy of the threshold formula would eventually disagree
 *    with the board about whether the boss is alive, and the user would have no way to tell
 *    which one to believe. One formula, one source.
 * 2. **Silence is the default.** The watchdog runs every few minutes; a watcher that
 *    shouted on every tick would be worse than no watcher at all. It speaks only when the
 *    state flips, and it says the same thing once per outage.
 * 3. **An explicit rest is not an outage.** The verdict is `alertable`, not `stale`: a boss
 *    somebody deliberately told to rest has not handed over *on purpose*, so the watchdog
 *    stays quiet about it. The fact (`stale`) is left alone — the board's duty lamp still
 *    follows it, because the lamp is a fact and the switch is not.
 * 4. **Evidence is a second, separate question.** The handover stamp says whether the boss
 *    is handing over *now*; the scheduler's run log says whether it *was*. A late handover
 *    refreshes the stamp and hides the gap it just closed — so the gap is counted from the
 *    run log (`computeDutyEvidence`) and reported as `missed`, once per gap.
 */

import { buildDutyStatus } from './view-model.mjs';

/**
 * @typedef {'stale'|'missed'|'recovered'|'none'} WatchdogAction
 */

/**
 * @typedef {{
 *   observedStale:boolean|null,   // the fact: is the boss quiet? (null = never observed)
 *   notifiedStale:boolean|null,   // what the user has been told (null = never told)
 *   observedMissed:boolean|null,  // the fact: is there a gap the handover stamp hid?
 *   notifiedMissed:boolean|null,  // what the user has been told about such a gap
 *   reportedGaps:number[],        // the `to` timestamps of the gaps already reported
 *   staleSince:number|null,       // when the silence began
 *   lastNotifiedAt:number|null,
 *   failedDeliveries:number,
 *   checkedAt:number|null,
 * }} WatchdogState
 */

/**
 * The duty boss's liveness, read through the board's own rule.
 *
 * The intent is passed in rather than read here: this module decides, it does not fetch.
 * A boss somebody explicitly told to rest is not an outage, and the board's rule already
 * knows that — it is the difference between `stale` (the fact) and `alertable` (the verdict).
 *
 * @param {{lastRunAt?:number|null, dutyIntervalMinutes?:number}} config
 * @param {number} [now]
 * @param {{mode?:string, since?:number|null, requestedBy?:string|null, note?:string}|null} [intent]
 * @returns {ReturnType<typeof buildDutyStatus>}
 */
export function evaluateDuty(config, now = Date.now(), intent = null) {
  return buildDutyStatus({ config: config ?? {}, findings: [], intent, now });
}

/**
 * Whether this duty state should raise an alarm.
 *
 * `alertable` is the verdict: stale AND not explicitly resting. A duty object built by
 * hand (in a test, or by an older caller) does not carry the field, so the fact is the
 * fallback — the strict reading of "stale" rather than an accidental silence.
 *
 * @param {ReturnType<typeof buildDutyStatus>} duty
 * @returns {boolean}
 */
function alertable(duty) {
  if (typeof duty?.alertable === 'boolean') return duty.alertable;
  return Boolean(duty?.stale);
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
    observedMissed: null,
    notifiedMissed: null,
    reportedGaps: [],
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
 * - `missed`: the schedule broke earlier and the next handover erased the proof; tell the
 *   user how many rounds were lost.
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
 * A gap is reported **once**: the state remembers the `to` timestamp of every gap already
 * reported, so the same empty stretch never gets announced twice.
 *
 * @param {WatchdogState} state
 * @param {ReturnType<typeof buildDutyStatus>} duty
 * @param {{erasedOutage?:boolean, lastGap?:{to:number, missedRounds:number}|null}} [evidence]
 * @returns {WatchdogAction}
 */
export function decideAction(state, duty, evidence) {
  const previous = state?.notifiedStale ?? null;
  const current = alertable(duty);

  const gap = evidence?.lastGap ?? null;
  const reported = state?.reportedGaps ?? [];
  const missed = Boolean(evidence?.erasedOutage) && Boolean(gap) && !reported.includes(gap.to);

  // The missed round comes first: it is the more specific news, and it is perishable — the
  // evidence window closes, while a live outage is re-evaluated on every tick anyway.
  if (missed) return 'missed';

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
 * @param {{erasedOutage?:boolean, lastGap?:{to:number, missedRounds:number}|null}} [evidence]
 * @returns {WatchdogState}
 */
export function applySuccess(state, action, duty, now, evidence) {
  const base = { ...state, checkedAt: now };

  if (action === 'missed') {
    const gap = evidence?.lastGap ?? null;
    const reportedGaps = gap
      ? [...(state?.reportedGaps ?? []), gap.to]
      : (state?.reportedGaps ?? []);
    return {
      ...base,
      // The boss is handing over now; what happened earlier is a separate fact.
      observedStale: Boolean(duty?.stale),
      notifiedStale: state?.notifiedStale ?? null,
      observedMissed: true,
      notifiedMissed: true,
      // The gap is now on the record: the next tick must not announce it again.
      reportedGaps,
      staleSince: state?.staleSince ?? duty?.lastRunAt ?? now,
      lastNotifiedAt: now,
      failedDeliveries: 0,
    };
  }

  if (action === 'stale') {
    return {
      ...base,
      observedStale: true,
      notifiedStale: true,
      observedMissed: Boolean(evidence?.erasedOutage),
      notifiedMissed: state?.notifiedMissed ?? null,
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
      observedMissed: Boolean(evidence?.erasedOutage),
      notifiedMissed: state?.notifiedMissed ?? null,
      staleSince: null,
      lastNotifiedAt: now,
      failedDeliveries: 0,
    };
  }

  // Quiet tick: establish the baseline without claiming a notification happened.
  // The observed fact follows the current observation; the "told the user" flag only
  // moves when it was already set, because a quiet tick told the user nothing.
  const established = duty?.neverRan ? false : alertable(duty);
  return {
    ...base,
    observedStale: established,
    notifiedStale: state?.notifiedStale ?? established,
    observedMissed: Boolean(evidence?.erasedOutage),
    notifiedMissed: state?.notifiedMissed ?? null,
  };
}

/**
 * Record a *failed* notification.
 *
 * The fact is remembered (the boss *is* quiet) but the "the user has been told" flag is
 * not: the user has not been told yet, so the next tick must try again. The same holds for
 * a missed gap: it stays off the reported list, so the next tick reports it again.
 *
 * @param {WatchdogState} state
 * @param {WatchdogAction} action
 * @param {ReturnType<typeof buildDutyStatus>} duty
 * @param {number} now
 * @param {{erasedOutage?:boolean, lastGap?:{to:number, missedRounds:number}|null}} [evidence]
 * @returns {WatchdogState}
 */
export function applyFailure(state, action, duty, now, evidence) {
  return {
    ...state,
    // The fact follows the current observation — a previous baseline of `false` must not
    // mask a boss that has since gone quiet. What stays put is the "the user has been
    // told" flag: they have not been told, so the next tick must try again.
    observedStale: alertable(duty),
    notifiedStale: state?.notifiedStale ?? null,
    observedMissed: Boolean(evidence?.erasedOutage),
    notifiedMissed: state?.notifiedMissed ?? null,
    checkedAt: now,
    failedDeliveries: (state?.failedDeliveries ?? 0) + 1,
  };
}

/**
 * A timestamp the reader can place on a clock.
 *
 * @param {number} timestamp
 * @returns {string}
 */
function formatMoment(timestamp) {
  const date = new Date(timestamp);
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
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
 *           failedDeliveries?:number,
 *           evidence?:{missedRounds?:number, lastGap?:{from:number,to:number,gapMinutes:number,missedRounds:number}|null} }} input
 * @returns {{ title:string, body:string }}
 */
export function buildAlertMessage(action, input) {
  const duty = input.duty;
  const failed = input.failedDeliveries ?? 0;
  const failureNote = failed > 0 ? `（此前有 ${failed} 次通知没能送达）` : '';

  if (action === 'missed') {
    const gap = input.evidence?.lastGap ?? null;
    const rounds = gap?.missedRounds ?? input.evidence?.missedRounds ?? 0;
    const minutes = gap?.gapMinutes ?? 0;
    const from = gap ? formatMoment(gap.from) : '不明';
    const to = gap ? formatMoment(gap.to) : '不明';
    return {
      title: '仿身泪滴 · 大哥漏了几轮',
      body: `从 ${from} 到 ${to} 漏了 ${rounds} 轮（间隔 ${minutes} 分钟）。`
        + '这一段已经被后来的交班盖住了——补交班会刷新「上次交班时间」，'
        + '所以只有调度记录还留着这段空档。'
        + failureNote,
    };
  }

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
