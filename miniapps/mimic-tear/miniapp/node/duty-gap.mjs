/**
 * 值班空档：断多久、断了几轮、哪些该补、哪些只是休息。
 *
 * 这个模块只做算术，不碰 IO、不读时钟、不改入参——所以「断档」这件事有**唯一一份判定**，
 * 看板、CLI、心跳三方读的是同一个答案。判定一旦有两份，迟早会对不上，而用户没法判断该信谁。
 *
 * ## 为什么空档要分成两段
 *
 * 调度器的运行记录里，「宿主该触发却没触发」的槽位有两种来源，而它们的性质完全不同：
 *
 * - **值班链断了**：大哥在岗，宿主没投递。这是真的漏班，该补。
 * - **大哥被交代去休息**：宿主照样没投递，因为**根本不该投递**。这不是漏班。
 *
 * 2026-10-27 13:19 大老板让大哥休息，到 2026-11-01 已经攒下 219 个空槽——那些槽位全部属于
 * 后者。把它们当成漏班，等于让大哥一上岗就背上 219 轮不存在的债；而真的把它们一笔勾销，
 * 又会让「大哥断了多久」这个问题失去答案。
 *
 * 所以这里同时给两个数：
 *
 * - `hole`：**整个洞**。从最后一次成功投递到现在，宿主一共没触发多少轮。
 * - `gap`：**算漏班的那一段**。只算落在当前值班周期里的那些。
 *
 * 分界线是值班意图的时间戳（`duty-intent.json` 的 `since`）。大哥被明确交代去休息，
 * 那段时间的洞就是休息，不是漏班——「休息不是故障」（主规格 §27.6）。
 *
 * ## 补位覆盖的是状态，不是事件
 *
 * 一轮值班巡检看的是**当前**状态，不是三十分钟前的状态。所以断档 219 轮不等于要跑 219 遍：
 * 跑一遍看到的就是今天的样子，219 遍只会得到 219 条几乎一样的结论。
 *
 * 因此一次补位覆盖**整段尚未覆盖的空档**，并把覆盖到的槽位记在心跳自己的状态里。下一轮
 * 只有在空档**继续往前推进**时才会再补一次——那就是值班周期该有一次交班的节奏。
 *
 * 记「覆盖到第几个槽位」而不是「覆盖过没有」，是因为槽位号是单调的：新空出来的槽位号更大，
 * 覆盖标记自然就落后了。这就是为什么旧实现里的锁是死的——它记的是「刚补的那个槽位」，
 * 而空档的起点永远算作「最后一次投递之后的第一格」，补完也不会往前挪，于是永远锁死。
 */

import { normalizeDutyIntent } from './duty-intent.mjs';
import { DEFAULT_DUTY_INTERVAL_MINUTES } from './view-model.mjs';

/**
 * @typedef {{mode:'on-duty'|'resting', since:number|null, requestedBy:string|null, note:string}} DutyIntent
 * @typedef {{
 *   source:'none'|'resting'|'pre-duty'|'chain-break',
 *   onDuty:boolean,
 *   dutyStart:number|null,
 *   hole:{slots:number, since:number|null, minutes:number|null, firstSlot:number|null, lastSlot:number|null},
 *   gap:{slots:number, rounds:number, since:number|null, minutes:number|null},
 *   covered:{slots:number, throughSlot:number|null, at:number|null},
 *   uncovered:{slots:number, nextSlot:number|null, coverThroughSlot:number|null},
 *   coverable:boolean,
 * }} DutyGap
 */

/**
 * A timestamp, or the current one.
 *
 * `Number(undefined)` is NaN, and NaN is not null/undefined — so `Number(x) ?? fallback`
 * silently produces NaN and every comparison against it is false. That is not a hypothetical:
 * it is how the heartbeat spent its first afternoon deciding everything was healthy.
 *
 * @param {any} value
 * @returns {number}
 */
export function resolveNow(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : Date.now();
}

/**
 * 一个人类读得懂时长。
 *
 * @param {number|null} minutes
 * @returns {string}
 */
export function describeDuration(minutes) {
  // `Number(null)` 是 0，不是 NaN —— 不先判空，`null` 会变成「不到 1 分钟」，
  // 也就是把「不知道」说成「刚刚才断」。这两件事的意思完全相反。
  if (minutes === null || minutes === undefined) return '未知';
  const value = Number(minutes);
  if (!Number.isFinite(value) || value < 0) return '未知';
  const total = Math.round(value);
  if (total === 0) return '不到 1 分钟';
  const days = Math.floor(total / (60 * 24));
  const hours = Math.floor((total % (60 * 24)) / 60);
  const rest = total % 60;
  if (days > 0) return `${days} 天 ${hours} 小时 ${rest} 分`;
  if (hours > 0) return `${hours} 小时 ${rest} 分`;
  return `${rest} 分钟`;
}

/**
 * A finite number, or null.
 *
 * `Number(null)` is **0**, not NaN — so `Number.isFinite(Number(x))` says "yes" for a null
 * that was supposed to mean "nothing here". A null `lastSlot` would then read as slot 0 and
 * invent a round that never happened. This is the same family as the `Number(undefined)`
 * trap (which yields NaN), one step sneakier: there the check catches it, here it does not.
 *
 * @param {any} value
 * @returns {number|null}
 */
function finiteOrNull(value) {
  if (value === null || value === undefined) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/**
 * 算清楚这个洞有多大、其中多少算漏班、还欠几轮。
 *
 * @param {{
 *   blankTail?:{slots?:number, since?:number|null, firstSlot?:number|null, lastSlot?:number|null},
 *   anchor?:number|null,
 *   periodMs?:number,
 *   now?:number,
 *   intent?:any,
 *   coveredThroughSlot?:number|null,
 *   coveredAt?:number|null,
 * }} [input]
 * @returns {DutyGap}
 */
export function computeDutyGap(input = {}) {
  const blank = input?.blankTail ?? {};
  const totalSlots = Math.max(0, finiteOrNull(blank.slots) ?? 0);
  const anchor = finiteOrNull(input?.anchor);
  const periodMs = Number(input?.periodMs) > 0 ? Number(input.periodMs) : DEFAULT_DUTY_INTERVAL_MINUTES * 60_000;
  const now = resolveNow(input?.now);
  const intent = normalizeDutyIntent(input?.intent);
  const coveredThroughSlot = finiteOrNull(input?.coveredThroughSlot);
  const coveredAt = finiteOrNull(input?.coveredAt);

  const firstSlot = finiteOrNull(blank.firstSlot);
  const lastSlot = finiteOrNull(blank.lastSlot) ?? (firstSlot === null ? null : firstSlot + totalSlots - 1);

  /** 槽位的时间：锚点是第 0 格，每格一个值班周期。 */
  const slotTime = (slot) => (
    anchor === null || !Number.isFinite(slot) ? null : anchor + slot * periodMs
  );

  const onDuty = intent.mode !== 'resting';
  // 分界线是**这一轮模式开始的时间**：大哥上一次切换状态的那一刻。
  //
  // 在岗时：分界线之后的槽位是「该值班却没人投递」= 漏班；之前的槽位是休息期间留下的。
  // 休息时：分界线之后的槽位是休息期间的（不算漏班）；之前的槽位是它上岗前就断的链。
  //
  // 两种模式用**同一条**分界线，方向相反——所以休息与在岗之间来回切换时，
  // 断档的归属不会因为看的是哪一头而说反。
  const boundary = finiteOrNull(intent.since);

  const holeSince = finiteOrNull(blank.since);
  const hole = {
    slots: totalSlots,
    since: holeSince,
    minutes: holeSince === null ? null : Math.max(0, Math.round((now - holeSince) / 60_000)),
    firstSlot,
    lastSlot,
  };

  // 落在当前值班周期里的槽位：算漏班的那一段。
  const gapSlots = [];
  for (let slot = firstSlot ?? 0; slot <= (lastSlot ?? -1); slot += 1) {
    const time = slotTime(slot);
    if (boundary !== null && time !== null) {
      const afterBoundary = time >= boundary;
      if (onDuty !== afterBoundary) continue;
    }
    gapSlots.push(slot);
  }

  const gapSince = gapSlots.length ? slotTime(gapSlots[0]) : null;
  const gap = {
    slots: gapSlots.length,
    rounds: gapSlots.length,
    since: gapSince,
    minutes: gapSince === null ? null : Math.max(0, Math.round((now - gapSince) / 60_000)),
  };

  const coveredSlots = gapSlots.filter((slot) => coveredThroughSlot !== null && slot <= coveredThroughSlot);
  const uncoveredSlots = gapSlots.filter((slot) => coveredThroughSlot === null || slot > coveredThroughSlot);

  const source = totalSlots === 0
    ? 'none'
    : (!onDuty ? 'resting' : (gap.slots === 0 ? 'pre-duty' : 'chain-break'));

  return {
    source,
    onDuty,
    // 上岗时刻：这一轮在岗是从什么时候开始的。休息状态下没有——它现在不在岗。
    dutyStart: onDuty ? boundary : null,
    hole,
    gap,
    covered: {
      slots: coveredSlots.length,
      throughSlot: coveredThroughSlot,
      at: coveredAt,
    },
    uncovered: {
      slots: uncoveredSlots.length,
      nextSlot: uncoveredSlots.length ? uncoveredSlots[0] : null,
      // 一次补位覆盖整段尚未覆盖的空档——补的是状态，不是把每一轮重放一遍。
      coverThroughSlot: uncoveredSlots.length ? uncoveredSlots[uncoveredSlots.length - 1] : null,
    },
    // 被交代去休息时不该补位：休息不是故障。
    coverable: onDuty && uncoveredSlots.length > 0,
  };
}

/**
 * 上岗摘要：给**大老板**看的一段话。
 *
 * 它回答三个问题——断了多久、还欠几轮、现在什么状况。顺序不能换：先说断档，再说欠账，
 * 最后才说现状。断档时长必须用**时间**说，不能用槽位数代替——219 轮和「4 天 14 小时」是
 * 同一件事，但只有后者能让人判断「这阵子没看着」到底有多要紧。
 *
 * @param {DutyGap} gap
 * @param {{now?:number, managedCount?:number, pendingDecisions?:number}} [context]
 * @returns {string}
 */
export function buildDutyHandoverSummary(gap, context = {}) {
  const now = resolveNow(context?.now);
  const lines = [];
  lines.push(`仿身泪滴 · 上岗摘要（截至 ${new Date(now).toISOString()}）`);

  if (gap?.source === 'none') {
    lines.push('没有断档：宿主一直在正常投递。');
  } else {
    const holeMinutes = describeDuration(gap.hole.minutes);
    lines.push(`断档：${holeMinutes}（从 ${gap.hole.since === null ? '未知时刻' : new Date(gap.hole.since).toISOString()} 起，`
      + `宿主一共没触发 ${gap.hole.slots} 轮）`);
    if (gap.source === 'resting') {
      lines.push('大哥在休息——休息不是故障，这段不算漏班，也不补位。');
    } else if (gap.source === 'pre-duty') {
      lines.push('算漏班：0 轮（洞都在上岗之前留下的，上岗之后没有新的漏班）');
    } else {
      lines.push(`算漏班：${gap.gap.rounds} 轮（从本次上岗时刻起算）`);
      lines.push(`已补 ${gap.covered.slots} 轮，还欠 ${gap.uncovered.slots} 轮`);
      lines.push('补位补的是当前状态，不是重放那几轮。');
    }
  }

  const managed = Number(context?.managedCount);
  const pending = Number(context?.pendingDecisions);
  const parts = [];
  if (Number.isFinite(managed)) parts.push(`管着 ${managed} 条线`);
  if (Number.isFinite(pending)) parts.push(`有 ${pending} 件等你拍板`);
  if (parts.length) lines.push(`现在：${parts.join('，')}`);

  lines.push('边界：板面关着时补不了 —— 那是宿主侧的事。');
  return lines.join('\n');
}
