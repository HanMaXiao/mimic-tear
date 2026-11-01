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
 * 这个会话是不是 **Mini App 自己拥有的**？
 *
 * 宿主的所有权闸（`gateway.js` 的 `requireOwned`）：`owner !== caller.pluginId` → 拒绝。
 * Mini App 建出来的会话带 `purpose = miniapp:<pluginId>`；桌面端用户会话是 `null`。
 *
 * **这条判定必须守在写入口**：订阅表里躺着一条指向桌面端会话的记录，看起来一切正常，
 * 事件却一条都投不出去（2026-11-01 上岗验收时真机撞出来的：16 次调用全被拒）。
 *
 * @param {{purpose?:string|null}|null|undefined} session
 * @param {string} [pluginId]
 * @returns {boolean}
 */
export function isMiniAppOwnedSession(session, pluginId = 'mimic-tear') {
  const purpose = String(session?.purpose ?? '');
  return purpose === `miniapp:${pluginId}`;
}

/**
 * 把一条消息投进一个会话。
 *
 * **没有负责会话时，先建一个，再投递**（方案 A）：
 *
 * - `agent.create({ agent })` **不跑轮次**，立刻返回 `{ sessionId }`。建出来的会话是 Mini App
 *   **自己拥有**的，宿主才肯续它——桌面端用户会话会被所有权闸拒掉（`SESSION_NOT_FOUND`）。
 * - 会话 id **立刻**写回订阅表：下一轮、以及任何一次重试，都续**这一个**会话，不再建新的。
 * - 然后 `agent.run({ sessionId, text })` 把事件投进去（**第一次就把事件投进去**，不建空会话）。
 *
 * **为什么不能「一次 run 建会话 + 投递」**：那一轮要等负责 agent 跑完（可能好几分钟），
 * 而投递循环每 30 秒一跳——重叠起来，同一个事件会被投两次、建出两个会话
 * （2026-11-01 方案 A 真机验收时真机撞出来的）。
 *
 * @param {{agent:any, sessionId?:string, ownerAgent?:string, text:string,
 *          whenBusy?:'queue'|'steer', onEvent?:Function,
 *          onSessionCreated?:(sessionId:string)=>Promise<void>|void}} input
 * @returns {Promise<{delivered:boolean, accepted:boolean, reason:string, error:string|null,
 *                    status:string|null, sessionId:string}>}
 */
export async function deliverToSession(input) {
  const agent = input?.agent;
  let sessionId = String(input?.sessionId ?? '').trim();
  const ownerAgent = String(input?.ownerAgent ?? '').trim();
  const text = String(input?.text ?? '').trim();
  const none = (reason, error = null, status = null) => ({
    delivered: false, accepted: false, reason, error, status, sessionId: '',
  });
  if (!sessionId && !ownerAgent) return none('no_session');
  if (!text) return none('empty_text');
  if (!agent || typeof agent.run !== 'function') return none('no_agent');

  try {
    if (!sessionId) {
      // 建一个负责会话。**没有它，投递无处可去。**
      if (typeof agent.create !== 'function') return none('no_create');
      const created = await agent.create({ agent: ownerAgent });
      sessionId = String(created?.sessionId ?? '').trim();
      if (!sessionId) return none('no_session');
      // 写回订阅表——重试也续它，不再建新的。
      await input?.onSessionCreated?.(sessionId);
    }
    const result = await agent.run(
      { sessionId, text, whenBusy: input?.whenBusy ?? 'queue' },
      { onEvent: input?.onEvent },
    );
    const status = result?.status ?? 'unknown';
    if (status === 'finished') {
      return { delivered: true, accepted: true, reason: 'finished', error: null, status, sessionId };
    }
    if (status === 'queued') {
      // 已排队，会执行。**已投出**，但这一轮还没跑。
      return { delivered: false, accepted: true, reason: 'queued', error: null, status, sessionId };
    }
    if (status === 'steered') {
      // 被正在跑的轮次读进去了——它执行了。
      return { delivered: true, accepted: true, reason: 'steered', error: null, status, sessionId };
    }
    if (status === 'aborted') {
      return { delivered: false, accepted: false, reason: 'aborted', error: null, status, sessionId };
    }
    return {
      delivered: false,
      accepted: false,
      reason: 'unexpected_status',
      error: result?.error?.message ?? null,
      status,
      sessionId,
    };
  } catch (error) {
    return {
      delivered: false,
      accepted: false,
      reason: 'error',
      error: error?.message ?? String(error),
      status: null,
      sessionId: '',
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
  /** @type {Map<string,string>} 这一轮建出来的负责会话——同一线的第二条事件要续第一个。 */
  const sessionByProject = new Map();

  for (const delivery of deliveries) {
    const projectName = delivery?.thread?.projectName ?? '';
    // 计划是在写回之前算的：这一轮的第二条事件看到的还是「没有负责会话」。
    // 不接住它，它就会**再建一个会话**——同一个项目两个负责人（2026-11-01 真机实测）。
    const known = sessionByProject.get(projectName);
    const sessionId = delivery?.thread?.ownerSessionId || known || '';
    const triggerType = delivery?.trigger?.type ?? '';
    // **在途标记先写，再投。** `delivered`（已投出）要等负责会话那一轮结束才落盘，
    // 实测滞后 11 分钟——那段时间里「已投出」在板面上是看不见的，盯盘很容易误读成
    // 「没投出去」。在途是**第三个状态**：在途 / 已投出 / 没投过。
    await input?.subscriptions?.markInFlight?.(projectName, {
      type: triggerType,
      triggerId: delivery?.trigger?.id ?? '',
      activityAt: Number(delivery?.trigger?.at ?? 0) || 0,
      sentAt: Date.now(),
    });
    const outcome = await deliverToSession({
      agent: input?.agent,
      sessionId,
      ownerAgent: delivery?.thread?.ownerAgent ?? '',
      text: delivery?.text ?? '',
      whenBusy: input?.whenBusy,
      onEvent: input?.onEvent,
      // 建出来的负责会话**立刻**写回订阅表：下一轮、以及任何一次重试，都续它。
      // 写回失败不能当成投递失败（事件可能已经进去了），但要如实记下来。
      onSessionCreated: async (created) => {
        sessionByProject.set(projectName, created);
        if (typeof input?.subscriptions?.setOwnerSession === 'function') {
          await input.subscriptions.setOwnerSession(projectName, created);
        }
      },
    });
    // 投递有结果了：在途标记撤掉。成功 → 下面记账（转成 `delivered`）；失败 → 事件
    // 下一轮还会被计划到（**失败不记账**的语义不变）。
    await input?.subscriptions?.clearInFlight?.(projectName, triggerType);
    results.push({
      triggerId: delivery?.trigger?.id ?? '',
      projectName,
      reason: outcome.reason,
      error: outcome.error,
      sessionId: outcome.sessionId,
    });
    // 只有「投出去了」才记账。失败的不记 —— 事件还在，下一轮还会被计划到。
    if (outcome.accepted) {
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
