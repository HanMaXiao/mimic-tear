# Agent Note: 直通的负责会话由仿身泪滴自己拥有

Status: implemented

## 问题

2026-11-01 上岗验收轮里，Gate 2（直通）**不成立**：投递链路本身是通的——管辖闸、类型闸、
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

而这条线的负责会话 `mvs_45d3d440…` 是**桌面端用户会话**：
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

## 决策

**「负责会话」由仿身泪滴自己拥有**——照 `BossBridge` 已有的建会话模式建出来。具体四处：

1. **订阅项记 `ownerAgent`**（负责 agent 名，默认 `mavis`）。`ownerSessionId` 的语义从
   「任意会话」改成「**仿身泪滴自己拥有的**会话」；没有会话就只记 agent 名。
2. **建会话与投递分开**：`agent.create({ agent })` **不跑轮次**、立刻返回 `{ sessionId }`；
   会话 id **立刻**写回订阅表；然后 `agent.run({ sessionId, text })` 才把事件投进去
   （**第一次就把事件投进去**，不建空会话）。**续会话不传 `agent`**——宿主对「续跑时带
   agent」判 `INVALID_ARGUMENTS`。
3. **投递轮次不许重叠**（`single-flight.mjs`）：投递要等负责 agent 那一轮跑完（可能好几分钟），
   而投递循环每 30 秒跳一次——重叠起来同一个事件会被投两次、还会建出两个负责会话。
4. **同一轮里的后续事件续第一个会话**：计划是在写回之前算的，所以同一轮的第二条事件看到的仍是
   「没有负责会话」→ 不接住它，它就会再建一个。这一条是被投递事件叫起来的那个**平行负责会话**
   自己查出来的（2026-11-01 14:50 回报）。
5. **写入口守门**：`patrol-cli thread add` **拒掉不是仿身泪滴自己拥有的会话**（落空的投递口
   是查不出来的）；`patrol-cli thread own <项目名> "<理由>"` 让一条线改由仿身泪滴自建负责会话。
   事实表的 `threads` 段标出 `ownerAgent` 与 `owned`。

**消息里带项目绝对路径**：Mini App 建的会话工作目录是 plugin 目录（`agents/<agent>/miniapps/
<pluginId>`），不是项目目录——负责 agent 要知道去哪儿干活。

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
开着哪个面板。而且它的产出能回流到那个 chat，比现在的落法好，所以它是**落法二**而不是
被否掉的方案。

## 后果

- **产出不再回到大老板当前窗口**：事件进的是仿身泪滴自建的负责会话，**不是**大老板正在用的
  那个桌面端会话。它的产出在板面和那个会话里，不在这个窗口。**这是本决策最大的产品影响**，
  由大老板 2026-11-01 拍板（方案 A）认可。
- **多一个平行的负责人会话**：同一个项目会有两个 agent 在能干活（桌面端会话 + 直通会话）。
  需要靠「谁负责什么」的纪律隔开，否则重复劳动。**实测**：真机验收时先后建出 8 个平行的
  `mavis` 会话（其中 6 个是「投递轮次重叠」与「同轮第二条事件再建一个」两个缺陷留下的）——
  它们都在自己的 plugin 工作目录里干活，没有碰过仓库。**收尾**：那 6 个 aborted 的残留已**归档**
  （运行时库只读，归档走宿主自己的动作）；留着两个——订阅表里记着的负责会话，和做了独立
  复查的那个平行会话（它是证据）。**另一笔账**：`project-activity` 的来源是**项目里的桌面会话
  活动**——也就是桌面会话每干一次活，那个平行的负责会话就被唤起跑一轮（真机上 5 个平行会话把
  同一件事各查了一遍）。平行会话挂在另一个项目上，不自激；但兄弟会话每在项目目录里干一次活就会
  再唤一次。收敛方向（设计层，下一轮）：**唤醒前先看那个会话是否正在处理同类事件**。
- **被中止的轮次不记账**：中止 ≠ 已处理——事件下一跳还会被计划到。所以**不要随手中止在跑的
  投递轮次**：重投是正确行为，但会再唤一次负责会话。
- **工作目录不是项目目录**：Mini App 建的会话默认落在 plugin 目录。消息里带绝对路径能解决，
  但负责 agent 的第一跳要自己 `cd`——**多一步就多一次跑偏的机会**。
- **仍然是「投出去了」不是「做完了」**：排队的轮次没执行，事件只到会话的队列里。
  记账语义不变（记「已投出」），别把它读成「已完成」。
- **投递轮次不重叠 = 直通会等**：一轮投递在跑的时候，后面的轮次被跳过。这不是丢——计划每轮
  重算，没投出去的事件还在；但一条线的负责 agent 忙起来时，其它线的新事件要等它。

## 验证

**判据**（2026-11-01 15:00 由那个被投递事件叫起来的平行负责会话提出，实测口径更硬）：

1. **连续窗口内新建的仿身泪滴自有会话数 = 0**（复用优先，不是每次新建）。
2. **订阅表 `ownerSessionId` 非 null**，且那个会话归属 `mimic-tear`（`purpose=miniapp:mimic-tear`）。
3. **`delivered > 0`，且被投过的事件不再出现在下一轮的待投列表里**。
4. **大哥会话那一轮的 turn 数不变**（不经 Router）。

- **真机端到端**（2026-11-01 14:47–14:50）：一条真实事件（`project-activity`）被投进仿身泪滴
  自己拥有的会话 `mvs_52ff916e…`（`purpose=miniapp:mimic-tear`、agent `mavis`、工作目录是
  plugin 目录）；**运行时库出现该会话的新消息行**（`source='miniapp'`）；**大哥那一轮的消息数
  没变**（783 条不变）；订阅表记下了负责会话与「已投出」账（`delivered=2`）。
- **四条判据逐条实测**（2026-11-01 15:02–15:05，**200 秒窗口，窗口内有一条真实事件被投**）：
  ① 窗口内新建的仿身泪滴自有会话数 **0**（复用优先）；② `ownerSessionId = mvs_52ff916e…`
  （`purpose=miniapp:mimic-tear`、agent `mavis`）；③ `delivered` **3 → 4**，且被投过的那条事件在
  下一轮待投列表里标着 `delivered: true`（不再被计划）；④ 大哥会话消息数 **812 → 812** 不变。
- **不重复**：修掉「轮次重叠」后连续观察 100 秒（3 个投递周期）：会话数不变（9 → 9）、
  负责会话不变、账目不变。
- **归属不变**：名单外的项目一条都投不出去（单测）。**失败降级**：投递失败不记账，事件下一轮
  还会被计划到（单测）。**会话归属可查**：事实表的 `threads.owned` 标出那个会话是不是自己拥有的。
- **测试**：+13（`tests/direct-delivery-owned-target.test.mjs`），走**真实模块**
  （`ManagedProjects` / `RuntimeStore` / `ThreadSubscriptions` / `planRound` / 真 CLI），
  只注入宿主边界上的 `agent`。**变异验证 11 组**，每组先证明会红再还原——其中 11 号变异
  （建出来的会话没有 id 也往下投递）**一开始没红**，暴露出「`create` 拿不到 sessionId」这条
  分支没人测，补了测试才变红。
