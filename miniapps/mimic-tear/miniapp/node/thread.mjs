/**
 * 线（Thread）：一条事件的归属，和它该送到哪个会话去。
 *
 * ## 文章里的直通，在我们这儿是什么
 *
 * 文章 §3.2 的直通是「同一 Thread 的后续事件**由程序直接发往该 Worker**，无需 Router 层
 * 再次调用工具转发」。对我们的映射：
 *
 * - **Router** = 大哥（常驻的 boss agent）
 * - **Worker** = 项目负责人会话（项目的根会话）
 * - **程序** = Mini App 的 Node 运行时（唯一持有 `context.agent` 的地方）
 *
 * 直通的投递口是 `context.agent.run({ sessionId, text })`——宿主自己的文档写着
 * 「Continuing a session keeps its Agent」，示例里传的就是任意 `sessionId`。所以**投递本身
 * 不需要经过大哥**：程序把事件写进项目会话，那个会话自己的 agent 接着干。
 *
 * ## 为什么归属要落成状态
 *
 * 「这条事件属于哪条线、这条线该找谁」必须是**可查的**，不是每次现推：
 *
 * - 现推的话，每一轮都要重新决定「谁负责这条线」，而那个决定一旦飘了，事件就投错人。
 * - 订阅表是**结构性的闸**：没有订阅项，这条线就没有投递口——**名单外的事件连投递路径都没有**。
 *
 * ## 三条硬规则
 *
 * 1. **没有负责会话 = 没有投递口。** 订阅项必须带 `ownerSessionId`；没有就不投。
 * 2. **一条事件只投一次。** 投递过的 trigger id 记在订阅表里，不重复投。
 * 3. **越权闸。** 订阅只在**管辖名单内**的项目上成立；名单外的项目即使有订阅项也不投。
 */

import { TRIGGER_LABELS } from './trigger.mjs';

/**
 * @typedef {{
 *   projectId:number|string|null,
 *   projectName:string,
 *   ownerSessionId:string|null,
 *   since:number|null,
 *   reason:string,
 *   active:boolean,
 * }} Thread
 */

/**
 * 造一条线。
 *
 * @param {{projectId?:number|string|null, projectName:string, ownerSessionId?:string|null,
 *          since?:number|null, reason?:string, active?:boolean}} input
 * @returns {Thread}
 */
export function makeThread(input) {
  const projectName = String(input?.projectName ?? '').trim();
  if (!projectName) throw new Error('线必须有项目名——没有归属的事件投不出去');
  return {
    projectId: input?.projectId ?? null,
    projectName,
    ownerSessionId: input?.ownerSessionId ? String(input.ownerSessionId) : null,
    since: Number.isFinite(Number(input?.since)) ? Number(input.since) : null,
    reason: String(input?.reason ?? ''),
    active: input?.active !== false,
  };
}

/**
 * 算出这一轮要投哪些事件、投给谁。
 *
 * 三道闸，顺序固定：
 *
 * 1. **类型闸**：事件类型要在允许清单里（默认全要）。
 * 2. **归属闸**：事件得有个项目归属，且这条线在订阅表里。
 * 3. **越权闸**：这条线的项目必须在**管辖名单**里。名单外的项目即使有订阅项也不投——
 *    这是结构性的，不依赖提示词。
 *
 * 外加两条：没有负责会话的不投（没有投递口）；投过的不再投（按 trigger id 去重）。
 *
 * @param {{triggers?:import('./trigger.mjs').Trigger[], threads?:Thread[],
 *          managedNames?:Iterable<string>|null, allowTypes?:Iterable<string>|null,
 *          delivered?:Iterable<string>|null}} input
 * @returns {{deliveries:Array<{trigger:import('./trigger.mjs').Trigger, thread:Thread, text:string}>,
 *            skipped:{total:number, byReason:Record<string,number>}}}
 */
export function planDeliveries(input = {}) {
  const triggers = Array.isArray(input?.triggers) ? input.triggers : [];
  const threads = Array.isArray(input?.threads) ? input.threads : [];
  const managed = new Set(
    input?.managedNames instanceof Set
      ? [...input.managedNames]
      : [...(input?.managedNames ?? [])].map((name) => String(name)),
  );
  const allowed = input?.allowTypes
    ? new Set([...input.allowTypes].map((type) => String(type)))
    : null;
  const delivered = new Set(
    input?.delivered instanceof Set
      ? [...input.delivered]
      : [...(input?.delivered ?? [])].map((id) => String(id)),
  );

  const byReason = {};
  const skip = (reason) => { byReason[reason] = (byReason[reason] ?? 0) + 1; };

  /** @type {Map<string,Thread>} */
  const threadByProject = new Map();
  for (const thread of threads) {
    if (!thread || thread.active === false) continue;
    if (!thread.ownerSessionId) continue;
    threadByProject.set(thread.projectName, thread);
  }

  const deliveries = [];
  for (const trigger of triggers) {
    if (!trigger || typeof trigger !== 'object') continue;
    if (allowed && !allowed.has(trigger.type)) { skip('type_not_allowed'); continue; }
    if (!trigger.projectName) { skip('no_project'); continue; }
    const thread = threadByProject.get(trigger.projectName);
    if (!thread) { skip('no_subscription'); continue; }
    if (!managed.has(thread.projectName)) { skip('out_of_jurisdiction'); continue; }
    if (delivered.has(trigger.id)) { skip('already_delivered'); continue; }
    deliveries.push({ trigger, thread, text: renderDelivery(trigger, thread) });
  }

  deliveries.sort((a, b) => (a.trigger.at - b.trigger.at)
    || (a.trigger.id < b.trigger.id ? -1 : a.trigger.id > b.trigger.id ? 1 : 0));

  const total = Object.values(byReason).reduce((sum, n) => sum + n, 0);
  return { deliveries, skipped: { total, byReason } };
}

/**
 * 把一条事件写成投给项目会话的话。
 *
 * **短。** 这条消息会占用那个会话的上下文，而那个会话的上下文是用来干活的，不是用来读
 * 大哥的转述。所以只给：是什么事、什么时候、必要的细节。**不给**「这是大哥认为你应该
 * 知道的」这类元叙述——那是要做判断的信号，不是事实。
 *
 * @param {import('./trigger.mjs').Trigger} trigger
 * @param {Thread} thread
 * @returns {string}
 */
export function renderDelivery(trigger, thread) {
  const label = TRIGGER_LABELS[trigger?.type] ?? trigger?.type ?? '事件';
  const at = trigger?.at ? new Date(trigger.at).toISOString() : '未知时刻';
  const lines = [
    `【${thread?.projectName ?? '未知项目'}】${label}（${at}）`,
  ];
  if (trigger?.summary) lines.push(trigger.summary);
  if (trigger?.refs?.length) lines.push(`关联：${trigger.refs.join(' / ')}`);
  return lines.join('\n');
}
