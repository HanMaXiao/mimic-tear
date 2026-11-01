/**
 * 直通投递：把事件直接写进项目负责人的会话，**不经过大哥**。
 *
 * ## 投递口
 *
 * `context.agent.run({ sessionId, text })` —— 宿主自己的文档写着「Continuing a session keeps
 * its Agent」，示例里传的就是任意 `sessionId`。所以程序能把消息写进项目会话，那个会话
 * 自己的 agent 接着干。**大哥这一轮完全不参与**：它不读事实表、不做路由决定、不占上下文。
 *
 * ## 排队不是失败，但也别当成「做完了」
 *
 * 宿主在目标会话正忙时会把新消息**排队**（默认 `whenBusy: 'queue'`），不打断正在跑的轮次。
 * 这正是我们要的——主规格 §3.5 说得很清楚：往一个正在热跑的 goal 链上插话会打断对方改到
 * 一半的文件。
 *
 * 所以投递结果分三档，**不能混**：
 *
 * - `finished` —— 这一轮跑完了。事件**已执行**。
 * - `queued` —— 已排队，会执行。事件**已投出**，但还没执行。
 * - `error` / `aborted` —— 没投出去。**事件还在**（没记进已投出账），下一轮还会被计划到，
 *   大哥那一轮也会从事实表里看见它。**这就是降级路径**：不需要额外机制——事件没被消费掉，
 *   它自然会被下一轮接住。
 *
 * ## 「已投出」是账，「已执行」是事实
 *
 * 订阅表记的是**已投出**（别再投第二次），不是「已执行」。把这两件事混在一起，会得出
 * 「大哥说它交班了」这种结论——而排队中的轮次根本没跑。
 */

import { planDeliveries } from './thread.mjs';

/**
 * 把一条消息投进一个会话。
 *
 * @param {{agent:any, sessionId:string, text:string, whenBusy?:'queue'|'steer', onEvent?:Function}} input
 * @returns {Promise<{delivered:boolean, accepted:boolean, reason:string, error:string|null, status:string|null}>}
 */
export async function deliverToSession(input) {
  const agent = input?.agent;
  const sessionId = String(input?.sessionId ?? '').trim();
  const text = String(input?.text ?? '').trim();
  if (!sessionId) return { delivered: false, accepted: false, reason: 'no_session', error: null, status: null };
  if (!text) return { delivered: false, accepted: false, reason: 'empty_text', error: null, status: null };
  if (!agent || typeof agent.run !== 'function') {
    return { delivered: false, accepted: false, reason: 'no_agent', error: null, status: null };
  }

  try {
    const result = await agent.run(
      { sessionId, text, whenBusy: input?.whenBusy ?? 'queue' },
      { onEvent: input?.onEvent },
    );
    const status = result?.status ?? 'unknown';
    if (status === 'finished') {
      return { delivered: true, accepted: true, reason: 'finished', error: null, status };
    }
    if (status === 'queued') {
      // 已排队，会执行。**已投出**，但这一轮还没跑。
      return { delivered: false, accepted: true, reason: 'queued', error: null, status };
    }
    if (status === 'steered') {
      // 被正在跑的轮次读进去了——它执行了。
      return { delivered: true, accepted: true, reason: 'steered', error: null, status };
    }
    if (status === 'aborted') {
      return { delivered: false, accepted: false, reason: 'aborted', error: null, status };
    }
    return {
      delivered: false,
      accepted: false,
      reason: 'unexpected_status',
      error: result?.error?.message ?? null,
      status,
    };
  } catch (error) {
    return {
      delivered: false,
      accepted: false,
      reason: 'error',
      error: error?.message ?? String(error),
      status: null,
    };
  }
}

/**
 * 把这一轮计划好的投递执行掉。
 *
 * **成功的（含排队的）才记进「已投出」账**；失败的**不记**——所以它下一轮还会被计划到，
 * 而大哥那一轮也会从事实表里看见它。**降级不需要额外机制**：事件没被消费掉，它自然会被
 * 下一轮接住。
 *
 * @param {{agent:any, deliveries:Array<{trigger:any, thread:any, text:string}>,
 *          subscriptions?:any, whenBusy?:'queue'|'steer', onEvent?:Function}} input
 * @returns {Promise<{attempted:number, delivered:number, queued:number, failed:number,
 *                    results:Array<{triggerId:string, projectName:string, reason:string, error:string|null}>}>}
 */
export async function deliverToThreads(input) {
  const deliveries = Array.isArray(input?.deliveries) ? input.deliveries : [];
  const results = [];
  /** @type {Map<string,string[]>} */
  const handedOff = new Map();

  for (const delivery of deliveries) {
    const outcome = await deliverToSession({
      agent: input?.agent,
      sessionId: delivery?.thread?.ownerSessionId ?? '',
      text: delivery?.text ?? '',
      whenBusy: input?.whenBusy,
      onEvent: input?.onEvent,
    });
    results.push({
      triggerId: delivery?.trigger?.id ?? '',
      projectName: delivery?.thread?.projectName ?? '',
      reason: outcome.reason,
      error: outcome.error,
    });
    // 只有「投出去了」才记账。失败的不记 —— 事件还在，下一轮还会被计划到。
    if (outcome.accepted) {
      const projectName = delivery?.thread?.projectName ?? '';
      handedOff.set(projectName, [...(handedOff.get(projectName) ?? []), delivery?.trigger?.id ?? '']);
    }
  }

  // 记账是写操作，放在投递之后：写失败不影响已经投出去的东西。
  if (input?.subscriptions && typeof input.subscriptions.markDelivered === 'function') {
    for (const [projectName, ids] of handedOff) {
      await input.subscriptions.markDelivered(projectName, ids);
    }
  }

  return {
    attempted: results.length,
    delivered: results.filter((r) => r.reason === 'finished' || r.reason === 'steered').length,
    queued: results.filter((r) => r.reason === 'queued').length,
    failed: results.filter((r) => !['finished', 'steered', 'queued'].includes(r.reason)).length,
    results,
  };
}

/**
 * 计划并投递一轮。
 *
 * @param {{agent:any, triggers:any[], threads:any[], managedNames?:Iterable<string>|null,
 *          subscriptions?:any, allowTypes?:Iterable<string>|null, whenBusy?:'queue'|'steer'}} input
 * @returns {Promise<{plan:ReturnType<typeof planDeliveries>, outcome:Awaited<ReturnType<typeof deliverToThreads>>}>}
 */
export async function runDirectDelivery(input) {
  const plan = planDeliveries({
    triggers: input?.triggers ?? [],
    threads: input?.threads ?? [],
    managedNames: input?.managedNames ?? null,
    allowTypes: input?.allowTypes ?? null,
    delivered: input?.subscriptions && typeof input.subscriptions.list === 'function'
      ? (await input.subscriptions.list()).flatMap((entry) => entry.delivered ?? [])
      : [],
  });
  const outcome = await deliverToThreads({
    agent: input?.agent,
    deliveries: plan.deliveries,
    subscriptions: input?.subscriptions,
    whenBusy: input?.whenBusy,
  });
  return { plan, outcome };
}
