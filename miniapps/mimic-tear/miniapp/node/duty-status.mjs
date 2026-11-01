/**
 * 值班状态：大哥有没有在交班、有没有掉线、看板该怎么报。
 *
 * 活性判定只有这一份实现，看板、CLI、看门狗（`watchdog-rules.mjs`）读的都是它。看门狗要是
 * 自己再写一份阈值公式，早晚会和看板对不上「大哥到底活着没有」，而用户没法判断该信谁。
 *
 * 两个判定刻意分开：
 *
 * - `stale` 是**事实**——只看交班戳，看板的值班灯读的就是它，任何开关都动不了它。
 * - `alertable` 是**结论**——`stale` 减去一个明确的休息。被特意交代去休息的大哥不是故障，
 *   所以看门狗对它保持安静。
 */

import { normalizeDutyIntent } from './duty-intent.mjs';
import { normalizeConclusionSource } from './conclusion-source.mjs';

/**
 * @typedef {{ lastRunAt:number|null, intervalMinutes:number, dutyIntervalMinutes:number,
 *             findings:number, openFindings:number, withdrawn:number,
 *             dutyOpenFindings:number, boardOpenFindings:number,
 *             dismissed:number, staleAfterMinutes:number, stale:boolean, neverRan:boolean,
 *             ageMinutes:number|null, missedRounds:number|null,
 *             missedRoundsByAge:number|null, missedRoundsSource:'evidence'|'age-arithmetic',
 *             inDutyGrace:boolean,
 *             mode:'on-duty'|'resting', resting:boolean, modeSince:number|null,
 *             requestedBy:string|null, intentNote:string,
 *             alertable:boolean, nextDueAt:number|null, overdueMinutes:number|null }} DutyStatus
 */

/**
 * 看板自己巡检的默认间隔（分钟）。
 *
 * 这只是兜底值，真实间隔来自 `patrol-config.json`。
 */
export const DEFAULT_BOARD_INTERVAL_MINUTES = 15;

/**
 * 值班周期的默认间隔（分钟）。
 *
 * 这只是兜底值，真实周期来自 `patrol-config.json`。看板自己巡检的间隔与它不是一回事，
 * 混用会让 60 分钟的值班每一轮都被误报成「大哥掉线」。
 */
export const DEFAULT_DUTY_INTERVAL_MINUTES = 30;

/**
 * 从配置里取出两个间隔，取不到就用兜底值。
 *
 * 看板自己巡检的间隔和值班周期以前各有一份兜底值，写在这里之后只有这一处——它们必须是
 * 两个不同的数，混起来就是「大哥一直掉线」事故的配方。
 *
 * @param {{ intervalMinutes?:number, dutyIntervalMinutes?:number }|null} config
 * @returns {{ intervalMinutes:number, dutyIntervalMinutes:number }}
 */
export function resolveDutyIntervals(config) {
  const board = Number(config?.intervalMinutes);
  const duty = Number(config?.dutyIntervalMinutes);
  return {
    intervalMinutes: board > 0 ? board : DEFAULT_BOARD_INTERVAL_MINUTES,
    dutyIntervalMinutes: duty > 0 ? duty : DEFAULT_DUTY_INTERVAL_MINUTES,
  };
}

/**
 * 看板要等多久才敢宣布大哥失联。
 *
 * 大哥按自己的节奏交班：值班 cron 每 `dutyIntervalMinutes` 跑一次。告警的窗口必须落在
 * 两个周期之间——短了会误报健康的班，长了会让真死掉的班安静半小时。地板值让很快的值班不
 * 会让看板来回闪。
 *
 * 值班周期跟看板自己的巡检间隔是分开的一个数，这是故意的：把它们混起来，正是「60 分钟的
 * 值班每一轮都被标成大哥掉线」的做法。
 *
 * @param {number} dutyIntervalMinutes
 * @returns {number} 分钟
 */
export function dutyStaleAfterMinutes(dutyIntervalMinutes) {
  const minutes = Number(dutyIntervalMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) return 45;
  return Math.max(Math.ceil(minutes * 1.5), 45);
}

/**
 * 大哥是不是真的在看着，以及这件事该怎么说。
 *
 * 只打印「上次巡检：4 小时前」的看板分不清「没事」和「没人看着」——在知道大哥已经死了之
 * 前，这两件事长得一模一样。所以值班状态自带一个活性判定：没按时交班的大哥是 `stale`，
 * 客户端直接说人话，而不是甩一个时间戳。
 *
 * @param {{config:{lastRunAt:number|null,intervalMinutes:number,
 *                 dutyIntervalMinutes?:number},
 *          findings:Array<{acknowledged:boolean, acknowledgedBy?:string|null, source?:string}>,
 *          dismissed?:Array<{id:string, reason?:string}>,
 *          intent?:{mode?:string, since?:number|null, requestedBy?:string|null, note?:string},
 *          evidence?:{missedRounds?:number}|null,
 *          now?:number}} input
 * @returns {DutyStatus}
 */
export function buildDutyStatus(input) {
  const config = input?.config ?? {};
  const findings = input?.findings ?? [];
  const dismissed = input?.dismissed ?? [];
  const now = input?.now ?? Date.now();
  const intent = normalizeDutyIntent(input?.intent);
  const { intervalMinutes, dutyIntervalMinutes } = resolveDutyIntervals(config);
  const staleAfterMinutes = dutyStaleAfterMinutes(dutyIntervalMinutes);
  const lastRunAt = typeof config.lastRunAt === 'number' ? config.lastRunAt : null;
  const ageMinutes = lastRunAt === null ? null : Math.floor((now - lastRunAt) / 60_000);
  const periodMs = dutyIntervalMinutes * 60_000;
  // The fact: has the boss gone quiet? It is computed from the handover stamp alone.
  const stale = lastRunAt === null || ageMinutes > staleAfterMinutes;
  // 证据口径的漏班数。**判类型不判数值**：`Number.isFinite(Number(null))` 是 true，
  // 「没有证据」会被误当成「证据说漏了 0 轮」。
  const evidenceMissed = input?.evidence?.missedRounds;
  const hasEvidence = typeof evidenceMissed === 'number' && Number.isFinite(evidenceMissed);
  // 上岗宽限期：从「意图切到 on-duty」那一刻起，给大哥跑完第一轮的时间。
  //
  // 宽度取**一个值班周期**（`dutyIntervalMinutes`）——值班 cron 每 `7,37 * * * *` 触发，
  // 上岗后第一轮最多等这么久。这段时间里交班戳还是**上岗前**留下的旧戳，用它判断
  // 「大哥掉线」是把上岗前的历史算到刚上岗的人头上。
  //
  // 宽限期只压**告警**，不压 `stale`——灯照亮事实，告警只报真故障。
  const graceMs = periodMs;
  const inDutyGrace = intent.mode !== 'resting'
    && typeof intent.since === 'number'
    && Number.isFinite(intent.since)
    && now - intent.since < graceMs;

  return {
    lastRunAt,
    intervalMinutes,
    dutyIntervalMinutes,
    findings: findings.length,
    openFindings: findings.filter((finding) => !finding.acknowledged).length,
    // The same number, split by origin. The duty line must be able to say how many of
    // the conclusions on the desk came from the duty round and how many from the
    // board's own patrol loop — one number for both reads as one thing, and it is two.
    // A conclusion written before the field existed counts as `board`.
    dutyOpenFindings: findings.filter((finding) => !finding.acknowledged
      && normalizeConclusionSource(finding.source) === 'duty').length,
    boardOpenFindings: findings.filter((finding) => !finding.acknowledged
      && normalizeConclusionSource(finding.source) === 'board').length,
    // Conclusions the boss retracted itself. They leave the attention list, so the board has
    // to say how many were withdrawn — otherwise the boss could quietly clear your desk.
    withdrawn: findings.filter((finding) => finding.acknowledgedBy === 'boss').length,
    // Raw runtime items the boss ruled out (a session error it proved is a leftover).
    dismissed: dismissed.length,
    staleAfterMinutes,
    stale,
    neverRan: lastRunAt === null,
    ageMinutes,
    // How many duty rounds were missed since the last handover. 0 means "on time".
    // This is what tells the boss that its previous round never landed, so it can
    // report the gap instead of silently carrying on as if nothing happened.
    //
    // **有两个数，这里给的是权威的那个**：`computeDutyEvidence` 数的是「调度器该触发却没
    // 成功交班」的班次，休息期不算漏班。纯算术（`ageMinutes / 周期`）把休息期也算成漏班，
    // 上岗验收时它给出 97、权威口径是 0——**模型每轮读表都会被那个 97 误导**（2026-11-01
    // 上岗轮大哥查出来的）。
    //
    // 没有证据可算时（拿不到调度记录）退回纯算术，并用 `missedRoundsSource` 说清用的是
    // 哪个口径——**同一个词不许有两种意思**。
    //
    // 注意：`Number.isFinite(Number(null))` 是 `true`（`Number(null)` 是 0），所以这里
    // 必须判类型而不是判「能不能转成数」——否则「没有证据」会被当成「证据说漏了 0 轮」。
    missedRounds: hasEvidence
      ? evidenceMissed
      : (ageMinutes === null ? null : Math.max(0, Math.ceil(ageMinutes / dutyIntervalMinutes) - 1)),
    // 纯算术的口径，单独留一个名字。告警文案用它——它明写「按交班戳折算」，本来就是另一个意思。
    missedRoundsByAge: ageMinutes === null ? null : Math.max(0, Math.ceil(ageMinutes / dutyIntervalMinutes) - 1),
    // 这个数是用哪个口径算出来的。`evidence` = 调度记录为准；`age-arithmetic` = 纯折算。
    missedRoundsSource: hasEvidence ? 'evidence' : 'age-arithmetic',
    // What the boss was told to do, as opposed to what it did. `resting` is an explicit
    // decision with a timestamp and a reason, never the absence of a handover.
    mode: intent.mode,
    resting: intent.mode === 'resting',
    modeSince: intent.since,
    requestedBy: intent.requestedBy,
    intentNote: intent.note,
    // Whether an alarm should fire. A boss that was explicitly told to rest is not an
    // outage, so the watchdog stays quiet — but `stale` above is untouched by this: the
    // duty lamp follows the facts, never the switch.
    //
    // **上岗宽限期**：意图刚切到 on-duty 时，交班戳还是上一次上岗前留下的旧戳——
    // `stale` 立刻成立，而大哥的第一轮还没跑完。那不是掉线，是**刚上岗**。
    // 2026-11-01 上岗实测：12:12:22 上岗，12:13:21 看门狗就报了「大哥掉线」。
    //
    // 宽限期只压住**告警**，不碰 `stale`——灯照亮事实，告警只报真故障。
    alertable: stale && intent.mode !== 'resting' && !inDutyGrace,
    // 宽限期这件事本身是个**事实**（大哥刚上岗多久），所以它进状态里，不只用来压告警。
    // 板面能说清「不是掉线，是刚上岗 N 分钟」。
    inDutyGrace,
    // When the next handover is expected, counted from now, and how many minutes past its
    // own deadline we already are.
    nextDueAt: now + periodMs,
    overdueMinutes: lastRunAt === null
      ? null
      : Math.max(0, Math.ceil((now - lastRunAt - periodMs) / 60_000)),
  };
}

/**
 * 漏掉的值班轮次的证据。
 *
 * 交班戳是个会被下一次交班盖掉的事实：值班的空档会在有人迟交班的那一刻消失。调度器自己
 * 的运行记录是永久的，所以空档还能数出来——这就是那个数。
 *
 * 计数规则：**一个该有的班次，就是一轮漏班。** 调度表每 `periodMs` 期待一次交班；一个
 * 班次只有在没有任何一次成功投递覆盖它时才算漏掉。排了却没投出去的运行（pending 或失败）
 * 是**同一个**漏掉的班次、只是证据更硬——它不会被数两遍。
 *
 * 空档被两侧的交班夹住，所以空档一定有 `from` 和 `to`。这就是「空档被抹掉」的意思：后面
 * 那次交班把它合上了，只有运行记录还记得。
 *
 * @param {{runs?:Array<{status?:string, createdAt?:number, deliveredAt?:number|null}>,
 *          periodMs?:number, now?:number, evidenceWindowMs?:number, currentStale?:boolean,
 *          boundary?:number|null, onDuty?:boolean}} input
 * @returns {{missedRounds:number,
 *            lastGap:{from:number,to:number,gapMinutes:number,missedRounds:number,attempted:boolean}|null,
 *            erasedOutage:boolean, currentStale:boolean, observedSlots:number, coveredSlots:number}}
 */
export function computeDutyEvidence(input) {
  const runs = (input?.runs ?? []).filter((run) => run && typeof run.createdAt === 'number');
  const periodMs = Number(input?.periodMs) > 0 ? Number(input.periodMs) : DEFAULT_DUTY_INTERVAL_MINUTES * 60_000;
  // The ledger counts in minutes and in slots, so the period is normalised the same way.
  const periodMinutes = Math.max(1, Math.round(periodMs / 60_000));
  // `Number(undefined)` is NaN, and NaN is not null/undefined — so `??` does not cover it.
  // Every comparison against a NaN "now" is false, which is how the gap count once stayed
  // at zero no matter what the scheduler did.
  const now = Number.isFinite(input?.now) ? Number(input.now) : Date.now();
  const evidenceWindowMs = Number(input?.evidenceWindowMs) > 0 ? Number(input.evidenceWindowMs) : periodMs * 1.5;

  // Only what already happened counts. A run logged after `now` is not evidence about the
  // past — it would let a future handover explain an old gap.
  const delivered = runs
    .filter((run) => run.status === 'delivered' && typeof run.deliveredAt === 'number' && run.deliveredAt <= now)
    .map((run) => run.deliveredAt)
    .sort((a, b) => a - b);

  if (delivered.length === 0) {
    return {
      missedRounds: 0,
      lastGap: null,
      erasedOutage: false,
      currentStale: Boolean(input?.currentStale),
      observedSlots: 0,
      coveredSlots: 0,
      // The tail is empty too: with no handover at all there is nothing to be late about.
      pendingTail: { slots: 0, since: null, runs: [] },
      blankTail: { slots: 0, since: null, firstSlot: null, lastSlot: null },
      // The slot-0 time. `duty-gap.mjs` needs it to turn a slot index back into a moment —
      // without it, "the hole started 61 minutes ago" cannot be said.
      anchor: null,
    };
  }

  const anchor = delivered[0];
  const slotOf = (timestamp) => Math.floor((timestamp - anchor) / periodMs);

  // 上岗分界线：大哥这一轮模式开始的时间（`intent.since`）。
  //
  // **在岗时只数分界线之后的洞**——分界线之前的是休息期留下的，或者大哥上岗前就断的链，
  // 那些不是「漏班」，是「还没上岗」。这跟 `duty-gap.mjs` 的 `computeDutyGap` 是**同一条**
  // 分界线、同一套归属规则：同一个词（「漏了几轮」）不许有两种意思。
  //
  // 不传 `boundary` 就不过滤——看门狗与心跳要的是**历史累计**，那是另一个量。
  const boundary = Number.isFinite(Number(input?.boundary)) ? Number(input.boundary) : null;
  // 休息不是故障：休息期间没有班次可漏。
  const onDuty = input?.onDuty !== false;
  const afterBoundary = (timestamp) => boundary === null || timestamp >= boundary;

  // Runs the scheduler tried but never delivered: missed, and the evidence is stronger.
  const pending = runs.filter((run) => run.status !== 'delivered'
    && typeof run.createdAt === 'number' && run.createdAt <= now);

  // Gaps are bounded by the handovers that enclose them. The count is how many rounds
  // *should* have fired inside the gap — `floor(gap / period) - 1` — because that is the
  // number the duty ledger quotes. A run the scheduler tried but never delivered is the
  // same round with stronger evidence, so it never adds a second count.
  const gaps = [];
  for (let i = 1; i < delivered.length; i += 1) {
    const from = delivered[i - 1];
    const to = delivered[i];
    // The ledger's rule, verbatim: the slots that should have fired and did not —
    // `floor(span / period) - 1`. The span is rounded to whole minutes first, because the
    // runtime stamps handovers with a few milliseconds of jitter and a 390-minute gap
    // measures 389m59.98s; without that step the floor drops one round per gap.
    const gapMinutes = Math.round((to - from) / 60_000);
    const expected = Math.max(0, Math.floor(gapMinutes / periodMinutes) - 1);
    // 这个洞可能横跨「还没上岗」和「在岗」两段，所以**按分界线切一刀**，不是整段二选一：
    // 只有分界线之后的那一段才算漏班。洞有多大是另一件事（那是 `duty-gap` 摘要说的）。
    const fromBoundary = boundary === null ? from : Math.max(from, boundary);
    const afterMinutes = Math.round((to - fromBoundary) / 60_000);
    const missed = boundary === null
      ? expected
      : (fromBoundary >= to ? 0 : Math.max(0, Math.ceil(afterMinutes / periodMinutes) - 1));
    const pendingInside = pending.filter((run) => run.createdAt >= from && run.createdAt <= to
      && afterBoundary(run.createdAt));
    if (missed === 0 && pendingInside.length === 0) continue;
    gaps.push({
      from,
      to,
      gapMinutes,
      missedRounds: Math.max(missed, pendingInside.length),
      attempted: pendingInside.length > 0,
    });
  }

  // Rounds scheduled after the last handover are not inside any gap: they are the failure
  // that is still going on, and the liveness verdict is what reports it.
  const lastDelivered = delivered[delivered.length - 1];
  const pendingTailRuns = pending.filter((run) => run.createdAt > lastDelivered && afterBoundary(run.createdAt));
  const trailingSlots = new Set(pendingTailRuns.map((run) => slotOf(run.createdAt)));

  // The tail splits into two kinds, and they need different answers:
  //  - `pendingTail`: the scheduler created a run but never delivered it. The host knows
  //    about that round and may still deliver it, so a second duty round for the same slot
  //    would double the spend.
  //  - `blankTail`: nobody created a run at all. Only these can be covered from outside,
  //    because nobody is going to deliver them.
  const lastSlot = slotOf(lastDelivered);
  const nowSlot = slotOf(now);
  const pendingSlots = new Set(pending.map((run) => slotOf(run.createdAt)));
  const blankSlots = [];
  for (let slot = lastSlot + 1; slot < nowSlot; slot += 1) {
    if (pendingSlots.has(slot)) continue;
    if (!afterBoundary(anchor + slot * periodMs)) continue;
    blankSlots.push(slot);
  }

  const lastGap = gaps.length ? gaps[gaps.length - 1] : null;

  return {
    // 休息期间没有班次可漏。**同一个词只有一种意思**：漏班 = 在岗时该交班却没交上的班次。
    missedRounds: onDuty
      ? gaps.reduce((sum, gap) => sum + gap.missedRounds, 0) + trailingSlots.size
      : 0,
    lastGap,
    // The tail after the last handover, split by what the host did about it.
    pendingTail: {
      slots: trailingSlots.size,
      since: pendingTailRuns.length ? Math.min(...pendingTailRuns.map((run) => run.createdAt)) : null,
      runs: pendingTailRuns.map((run) => ({
        runId: run.id,
        status: run.status,
        createdAt: run.createdAt,
        retryAttempt: run.retryAttempt ?? 0,
        error: run.error ?? null,
      })),
    },
    blankTail: {
      slots: blankSlots.length,
      since: blankSlots.length ? anchor + blankSlots[0] * periodMs : null,
      firstSlot: blankSlots.length ? blankSlots[0] : null,
      // The last blank slot. The range's far end — `duty-gap.mjs` needs it to know how far
      // the hole reaches, and to mark how much of it a fill has covered.
      lastSlot: blankSlots.length ? blankSlots[blankSlots.length - 1] : null,
    },
    // The slot-0 time: the moment the first handover landed. Every slot index is relative
    // to it, so it is what turns "slot 42" back into a date.
    anchor,
    // The gap is still worth reporting when it ended inside the evidence window: that is
    // exactly the case where a late handover erased it.
    erasedOutage: Boolean(lastGap && lastGap.missedRounds > 0 && now - lastGap.to < evidenceWindowMs),
    currentStale: Boolean(input?.currentStale),
    observedSlots: slotOf(lastDelivered) + 1,
    coveredSlots: new Set(delivered.map(slotOf)).size,
  };
}

/**
 * 把值班状态盖到项目卡上。
 *
 * 卡片本身是按运行时版本缓存的，但值班意图不属于运行时：用户让大哥去休息，必须立刻看到
 * 看板变化，不能等一个无关的会话动一下。所以值班状态是在出口处盖上去的——盖在副本上，
 * 缓存还是缓存。
 *
 * `watching` 说的是大哥到底能不能管这个项目。它跟着值班标记一起走，因为「有没有人在看着
 * 这儿」是一个问题，不是两个。
 *
 * @param {any[]} cards
 * @param {DutyStatus} duty
 * @param {Set<string>|string[]} [watching]
 * @returns {any[]}
 */
export function withDutyCards(cards, duty, watching) {
  const names = watching instanceof Set ? watching : new Set(watching ?? []);
  return (cards ?? []).map((card) => ({
    ...card,
    duty: {
      mode: duty?.mode ?? 'on-duty',
      resting: Boolean(duty?.resting),
      since: duty?.modeSince ?? null,
      requestedBy: duty?.requestedBy ?? null,
      watching: names.has(card.name),
    },
  }));
}
