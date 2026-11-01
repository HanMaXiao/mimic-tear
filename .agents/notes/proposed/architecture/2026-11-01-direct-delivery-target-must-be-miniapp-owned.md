# Agent Note: 直通的负责会话必须是 Mini App 自己拥有的会话

Status: proposed

## 问题

2026-11-01 上岗验收轮里，Gate 2（直通）**不成立**。投递链路本身是通的——管辖闸、类型闸、
归属闸全过，订阅表在册，`directDelivery` 开着——但 **`delivered=[]`，一条都没真投出去**。

根因不在我们的代码，在**宿主的能力边界**：

宿主的 `MiniAppAgentClient.run/answer` 带一道所有权闸
（`Saved/asar2/node_modules/@mavis/local-runtime-v2/dist/service/miniapp/agent/gateway.js:631-649`）：

```js
/** `run` / `answer` continue the Mini App session itself, never one of its delegated children. */
async function requireOwned(state, bound, caller, sessionId) {
  await requireOwner(state, caller, sessionId, () => bound.getOwner(sessionId));
}
…
if (owner !== caller.pluginId) {
  throw reject(state, caller, new MiniAppAgentError('SESSION_NOT_FOUND', 'Mini App Agent session not found'));
}
```

**Mini App 只能续自己拥有的会话。** 宿主官方文档写的是同一句：「each Mini App can only
continue its own sessions」；而读权限（`session.read`）是宽的——Mini App 能读所有用户的会话，
写权限却是窄的。

而这条线的负责会话 `mvs_45d3d440321649a994cb633da61659d7` 是**桌面端用户会话**：
`local_runtime_sessions.purpose = null`、没有 `miniAppOrigin` → 不属于任何 Mini App →
**宿主拒写**（实测 16 次调用全被 `SESSION_NOT_FOUND` 拒）。

问题在根上：**`thread.mjs` 与 `direct-delivery.mjs` 的注释写着「宿主自己的文档写着
『Continuing a session keeps its Agent』，示例里传的就是任意 `sessionId`」——这个前提是错的。**
代码是照一个**不存在的宿主契约**写的，所以直通路从落地起就从来没跑通过。

顺带一提：宿主自己也有这个错位——`session-ports.js` 的 `createSession` 明明接受
`hostSessionId` 参数，会话记录里也存 `miniAppOrigin.hostSessionId`，说明**设计上**是支持把
Mini App 的会话挂到某个 chat 下的。但 Node 侧的 `caller.hostSessionId` 恒为 `undefined`
（runtime-api.md：「the Node process serves every tab of the Mini App, so it has no current chat」），
所以那条路只对**页面侧**成立。

## 提案

**让「负责会话」成为 Mini App 自己拥有的会话**——照 `BossBridge` 已有的建会话模式
（`boss-bridge.mjs` 的 `#runTurn` 分支就是 `agent.run({ text, agent })`，大哥的会话
`mvs_90f86d83…` 正是这么建出来的，`purpose = miniapp:mimic-tear`）。

具体三处改动：

1. **订阅项增加 `ownerAgent`**（负责 agent 名，默认 `mavis`）。`ownerSessionId` 的语义从
   「任意会话」改成「**Mini App 拥有的**会话」。
2. **投递前确保这条线有会话**：没有 `ownerSessionId` 时用
   `agent.run({ text, agent: ownerAgent })` 建一个（**第一次就把事件投进去**，不建空会话），
   拿到 `sessionId` 后写回订阅表；之后一律 `agent.run({ sessionId, text })` 续它。
3. **消息里带项目绝对路径**：Mini App 建的会话工作目录是 plugin 目录
   （`agents/<agent>/miniapps/<pluginId>`），不是项目目录——负责 agent 要知道去哪儿干活，
   路径必须写在消息里。

落法与 Super-agent 的双层架构是一致的：**Worker 层是上下文隔离的会话，Router（大哥）不碰**。

## 曾考虑的替代方案

**绕开所有权闸：Mini App 直接写运行时库的消息表。** 放弃的理由：主规格 §3.3 与
`AGENTS.md` 都把「运行时库只读」写成不可协商的硬约束——那不是风格问题，是这份插件存在的
前提（运行时是唯一数据源，插件自己建库就变成第二份真相）。

**绕开所有权闸：走宿主内部 HTTP / IPC 直接调 session send。** 放弃的理由：那是**与宿主的
显式设计对抗**。宿主把「Mini App 不得插话进用户的会话」写进了代码注释、官方文档和错误码
（`SESSION_NOT_FOUND`），绕过去等于依赖私有实现，宿主一次升级就断。

**改闸门定义：把 Gate 2 的退出证据改成「事件进了一个不由大哥参与的会话」。** 放弃的理由：
**那是改验收标准，不是修实现**——必须大老板拍板，不能由实现方顺手改掉。

**把直通的终点改成大哥自己的会话。** 放弃的理由：那直接违反「不经大哥」——Gate 2 的意义
就是绕开 Router，投递到 Worker。

**页面侧建会话：让板面在项目负责人的 chat 里打开，由页面创建负责会话（带 `hostSessionId`）。**
放弃的理由：这条路**只在板面恰好从某个 chat 里打开时成立**——后台定时轮次不能依赖用户
开着哪个面板。而且它的产出能回流到那个 chat，比下面的方案好，所以它是**落法二**而不是
被否掉的方案。

## 验收标准

1. **端到端**：造一个真实事件 → 直通把它投进负责会话 → 运行时库出现该会话的新消息行
   （`source` 可查），且**大哥那一轮没有参与**（大哥会话的 turn 数不变）。
2. **归属不变**：投递仍然过三道闸（类型 / 归属 / 越权），名单外的项目一条都投不出去。
3. **失败降级**：投递失败**不记账**，事件下一轮还会被计划到（现有行为，不能被改坏）。
4. **会话归属可查**：订阅表里记下的 `ownerSessionId` 必须是 `miniAppOrigin.pluginId = mimic-tear`
   的会话——**能查，才知道它投到哪儿去了**。
5. **测试**：新增测试走**真实模块**（`ManagedProjects` / `RuntimeStore` / `ThreadSubscriptions`），
   不注入替身——上一轮的两个缺陷都栽在「替身的形状和真实模块不一样」上。
6. **变异验证**：新写的检查先证明它会失败（故意改坏，确认变红），再还原。
7. **开关默认关**：`directDelivery` 仍然默认 `false`，打开的前提是大哥的提示词先改成
   「事件直达了，你只管没有归属的事」。

## 风险

- **产出不再回到大老板当前窗口**：新落法里，通事件进的是 Mini App 自建的负责会话，
  **不是**大老板正在用的那个桌面端会话。它的产出在板面和那个会话里，不在这个窗口。
  这是本提案**最大的产品影响**，必须大老板认可。
- **多一个平行的负责人会话**：同一个项目会有两个 agent 在能干活（桌面端会话 + 直通会话）。
  需要靠「谁负责什么」的纪律隔开，否则重复劳动。
- **工作目录不是项目目录**：Mini App 建的会话默认落在 plugin 目录。消息里带绝对路径能解决，
  但负责 agent 的第一跳要自己 `cd`——**多一步就多一次跑偏的机会**。
- **仍然是「投出去了」不是「做完了」**：排队的轮次没执行，事件只到会话的队列里。
  记账语义不变（记「已投出」），别把它读成「已完成」。
