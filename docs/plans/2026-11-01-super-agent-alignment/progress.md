# 仿身泪滴 · Super-agent 对齐迭代 — Progress

> 本计划的执行日志。每个任务追加一行（commit 引用 + 测试增量）；每个阶段收尾追加一个 `**Phase N closeout**` 块。
> **测试增量是这里最重要的一行**——大老板靠它判断计划是否健康。

**Status:** **3/6 个阶段已落地**（Phase 1 恢复路径 / Phase 2 事实层 / Phase 3 直通**能力**）。
基线 commit `ba7f6ec`。基线测试：**602 项全绿**；当前测试：**646 项全绿**（2026-11-01 实测）。
**G-05 从 Phase 3 拆到 Phase 3b**（上下文组织 ≠ 路由）。

**分支：** `feature/super-agent-alignment`（从 `main` 的 `ba7f6ec` 切出）。
> **与 [`findings.md`](findings.md) F0.1 的一处偏差**：F0.1 写的是「Phase 1 开工时开一个独立 worktree」。实际做的是**在主工作树上切分支**——因为这一轮只有我一个写入者，独立 worktree 只会多出第二份仓库副本要同步，而计划文档本来就在主工作树里。**纪律本身（路径限定提交、共享 checkout 不扫全树）没有放松**：本计划至今每个提交都是 `git commit -F <msg> -- <paths>`。

**Roadmap anchor:** [`../../specs/2026-11-01-super-agent-baseline.md`](../../specs/2026-11-01-super-agent-baseline.md) §4 缺口台账
**Spec authority:** [`../../specs/2026-11-01-super-agent-baseline.md`](../../specs/2026-11-01-super-agent-baseline.md) §7 闸门
**Long-form plan:** 本目录三份文件（`task_plan.md` + `findings.md` + `progress.md`）

**大老板已拍板的决策（锁定 2026-11-01）：**
1. **以 Super-agent 文章为大哥演进的基线**——核心思想（一个助理管住一切、让用户置身事外）与大哥一致，差距在架构与细节的颗粒度。
2. **逐步深化迭代**，不搞一次性大重写——按 [`task_plan.md`](task_plan.md) 的 6 个阶段推进，每阶段有闸门。
3. **不照搬文章里为云端/多设备/多信道设计的那部分**（否决清单见基线规格 §5）。

**Working memory:**
- [`task_plan.md`](task_plan.md) — 阶段与任务清单
- [`findings.md`](findings.md) — 锁定的设计决策与开放问题
- [`progress.md`](progress.md) — 本文件

**Worktree:** **尚未创建**。按 [`findings.md`](findings.md) F0.1，worktree 与分支在 **Phase 1 真正开工时**从 `main`（`ba7f6ec`）切出：

```sh
git worktree add -b feature/super-agent-alignment <仓库外目录> main
```

---

## 计划开篇（2026-11-01）

- **产出**：基线规格 + 迭代计划三份文件 + 一份 Agent Note
- **文件**：
  - `docs/specs/2026-11-01-super-agent-baseline.md`（新建）
  - `docs/plans/2026-11-01-super-agent-alignment/task_plan.md`（新建）
  - `docs/plans/2026-11-01-super-agent-alignment/findings.md`（新建）
  - `docs/plans/2026-11-01-super-agent-alignment/progress.md`（新建，本文件）
  - `.agents/notes/proposed/architecture/2026-11-01-super-agent-as-evolution-baseline.md`（新建）
- **测试增量：** 602 → 602（**纯文档改动，不碰任何运行时文件**，一条测试都不该变——如果变了，说明改动越界了）
- **外部基线**：DeepSeek Harness《Super-agent 设计探索：迈向更自主的 Agent 系统》（2026-10-31）全文已读，锚点为原文小节号

### 本轮的关键发现（供后来的人省时间）

1. **大哥当前处于 `resting`**，值班 cron 的**调度 job 已 `cancelled`**（定义还在），最后一次成功投递 **2026-10-27 13:07**，此后 **219 个空槽**无人值班。
2. **心跳补偿锁死**（`reason = already_triggered`），**不会自己补**那 219 个空槽——这是一条断掉的恢复路径（→ G-10，Phase 1）。
3. **收件箱 100 条结论、93 条从未被确认**，来源 `board` 97 / `duty` 3。文章 §3.1 的「高噪音、低触发率」在我们这儿**已经是问题，不是优化项**（→ G-11，Phase 4）。
4. **管辖名单只有 1 项**（`Mimic Tear` 自己）——「替我管所有项目」这条主链路**从未在真实多项目负载下跑过**（External Validation Pending）。
5. **技能库 3 条 `active`、`usageCount` 全为 0**——匹配路径没有任何使用痕迹（→ G-11）。
6. **Mini App node 侧没有 goal 创建入口**（全目录 `createGoal|threadGoal|tokenBudget` 零命中）——这是主规格 §26 已记录的独立议题，**不混进本计划**。
7. 近 72 小时 `local_runtime_message_rows` 里 **`cron` 来源 0 条**——这段时间唯一在驱动整个系统的是**人**（`api = 873`）。
8. **大哥自己在 2026-10-30 11:47 就报过这个 bug**（板面交班汇报里）：「大老板 10-27 那句『休息不是故障』修好了一半：看门狗认 intent 了，**心跳还不认**——它会把休息当链断，还自己补跑一轮 Mimic Tear」。**Phase 1 修的就是它**——不是推测出来的需求，是大哥自己挂在那儿的一条结论。
9. **2026-10-27 13:37 的补位失败锁死了整条链**：告警日志里 `heartbeat_run`（13:37:45）后面紧跟一条 `heartbeat_failed`（"Mini App Agent is busy"）。失败那轮被记成「已补」→ 下一跳判成「已触发」→ **此后 5 天一次都没补过**。Phase 1 的「失败不推进覆盖标记」修的就是这个具体事故。

---

## Phase 1 — 让大哥能安全上岗

- **状态：** **complete**
- **对应缺口：** G-10 ｜ **对应闸门：** Gate 5（**尚未验收**——验收要等大老板决定上岗）
- **关键决策：** F1.1（一趟覆盖整段空档）/ F1.2（覆盖标记可前进 + 按需重新覆盖）/ F1.3（摘要给大老板看）/ F1.4（三处根因）
- **提交：** `bca89e9` `feat(duty): 断档要说得清 —— 空档模型 + 一趟覆盖 + 休息不补位`
- **文件：**
  - 新增 `miniapps/mimic-tear/miniapp/node/duty-gap.mjs`（空档判定 + 时长人话 + 上岗摘要）
  - 改 `miniapps/mimic-tear/miniapp/node/duty-heartbeat.mjs`（覆盖标记 / 失败可重试 / 休息不补位 / 提示词带断档时长）
  - 改 `miniapps/mimic-tear/miniapp/node/duty-status.mjs`（`computeDutyEvidence` 增补 `anchor` 与 `blankTail.lastSlot`）
  - 改 `miniapps/mimic-tear/miniapp/node/patrol-cli.mjs`（新增 `gap` / `gap reset "<理由>"`）
  - 新增 `tests/duty-gap.test.mjs`（12 条）；改 `tests/duty-heartbeat.test.mjs`（+5 条）；改 `tests/helpers/fixture.mjs`（+`makeDutyBoardDb`）
- **测试增量：** 602 → **619** 全绿（+17：空档模型 9、心跳层 5、CLI 3）
- **四道守卫：** `verify-agent-notes` / `check-style` / `check-package` / `check-published` **全绿**（最后一个是在发布之后复跑才绿的）

### Phase 1 收尾块

**这一阶段修掉的三处根因**（都不是「缺个功能」，是「结构错了」）：

| # | 根因 | 后果 | 修法 |
| --- | --- | --- | --- |
| 1 | 覆盖标记记的是「刚补的那一槽」，而空档起点恒等于「最后一次投递之后的第一格」 | 心跳整条链路**只能补一次** | 记「覆盖到第几槽」；覆盖标记随空档推进而推进 |
| 2 | 补位失败被写进状态（`lastTriggeredSlot = 那一槽`） | 那一段**永不重试** | 失败**不推进**覆盖标记 |
| 3 | 心跳**从不读**值班意图 | 被交代去休息的大哥照样被派值班轮次（只是被 #1 的锁碰巧挡住） | `resting` 不补位；休息期攒下的空槽不算漏班 |

**变异验证（6 个新检查逐个改坏）** —— 全部**变红**：

| 变异 | 改坏的东西 | 结果 |
| --- | --- | --- |
| M1 | `coverable` 去掉 `onDuty` 项 | 第一次**没抓住** → 补了专测用例（休息中 + 上岗前断链）后抓住 |
| M2 | 心跳不再尊重 `resting` | 红 ✅ |
| M3 | 覆盖标记不再前进 | 红 ✅ |
| M4 | 失败那轮也算已覆盖 | 红 ✅ |
| M5 | `gap reset` 不再清覆盖标记 | 红 ✅ |
| M6 | 空档分界失效 | 红 ✅ |

> M1 是这次唯一一次「变异没被抓住」：它暴露 `coverable` 的 `onDuty` 项在当前路径上是**冗余**的（休息时边界过滤已经把槽位清空）。补的用例覆盖「休息中 + 上岗前就断了链」这个边界场景，之后再变异就红了。**「一直通过的检查」和「没有检查」在结果上无法区分**——这条纪律救了一次。

**新加的判定口径**（都写进了代码注释，不只在文档里）：

- **洞 vs 漏班**：空档分成两段。`hole` = 宿主一共没触发多少轮；`gap` = 其中落在当前值班周期里的那部分。休息期间攒下的空槽**不算漏班**（「休息不是故障」，主规格 §27.6）。
- **断多久用时间说**，不用槽位数代替——219 轮和「4 天 14 小时」是同一件事，但只有后者能让人判断「这阵子没看着」有多要紧。
- **补的是当前状态，不是重放**——这句话同时进了**提示词**和**摘要**：不说的话，大哥会把「断了四个小时」汇报成「普通迟到」。

**待办（不在本阶段内）：**

1. **大哥仍未上岗** —— 那是大老板的决定（D1）。本阶段只保证「上岗时有一条能说清断档的恢复路径」。
2. **Gate 5 未验收** —— 验收需要一个真实的上岗场景：切到 `on-duty` → 看 `patrol-cli gap` 的摘要 → 看心跳是否补了一趟并把覆盖标记往前推。**这一步要在真实环境做，测试绿不算。**
3. **运行中进程的新分支没有直接观测到** —— 见下「四层验收」的第 4 层。

### 发布与四层验收（2026-11-01 03:36–03:47）

**三层路径**

| 层 | 路径 |
| --- | --- |
| 仓库（source of truth） | `D:\Project\AppProject\Mimic Tear\miniapps\mimic-tear` |
| 发布副本（宿主加载的那份） | `C:\Users\12391\.minimax\plugins\mimic-tear` |
| 运行中的进程 | Mini App 运行时（`miniapp inspect` 的 `runId` = `fa6a5cd5-b1cb-407a-aadf-1c4357510a9a`） |

| 层 | 结论 | 证据 |
| --- | --- | --- |
| ① 仓库 ↔ 发布副本 | **一致** | `check-published.mjs`：文件数 仓库 103 / 发布 103，**无漂移**；`duty-gap.mjs` 已在发布副本（11192 字节） |
| ② 运行时确实被替换 | **是** | 发布前 `runId` = `e36a6164…`；发布后 = `fa6a5cd5…`，日志 `runtime.start_requested` → `runtime.ready`（03:43:34，**在发布之后**） |
| ③ 运行时加载的是发布副本 | **是** | `miniapp inspect` 的 `source: "local"`；且发布副本与仓库逐字节相同 |
| ④ 新代码真的在跑 | **间接但可靠** | 运行中进程的心跳 `updatedAt` **每 60 秒推进一次**（1793475535940 → 1793475595956，间隔 6016 ms）。新的 `duty-heartbeat.mjs` 会 `import './duty-gap.mjs'` —— 若这个 import 失败，`server.mjs` 里 `await import('./duty-heartbeat.mjs')` 会抛，**定时器根本不会建起来**。所以「心跳在推进」就等于「新模块图加载成功并在跑」 |

**产物级验证（真机 + 真数据 + 真调用）**

用**发布副本那份** CLI，读**真实的运行时库**与**真实的板面数据目录**：

```
node "%USERPROFILE%\.minimax\plugins\mimic-tear\miniapp\node\patrol-cli.mjs" gap
```

真实输出（截取）：

```
hole: { slots: 221, minutes: 6630, firstSlot: 330, lastSlot: 550 }
gap:  { slots: 1, rounds: 1 }        ← 只有 1 轮算漏班
source: "resting"  coverable: false
断档：4 天 14 小时 30 分（从 2026-10-27T05:07:00.136Z 起，宿主一共没触发 221 轮）
大哥在休息——休息不是故障，这段不算漏班，也不补位。
现在：管着 1 条线，有 93 件等你拍板
边界：板面关着时补不了 —— 那是宿主侧的事。
```

**这个数字本身就是对账据**：221 轮里只有 **1 轮**算漏班（第 330 槽，落在休息开始之前的那一轮）；其余 220 轮是大老板让它休息期间攒的。**旧实现分不出这个区别**——它只会说「221 轮空槽」。

**没验到的一层（如实记下）**：运行中进程的**新分支本身**没有直接观测到——板面接口 401（宿主网关鉴权，Mini App 自己的 server 里没有鉴权代码），而客户端没渲染 `gap` 字段（这轮没改客户端）。**但可以确定它不是旧代码**：旧实现的心跳在同一个状态下也不会触发补位（锁死），所以「没有新的补位告警」区分不出新旧；能区分的是上面第 ④ 层（模块图加载成功）。

## Phase 2 — 事实层：Trigger 与两级过滤

- **状态：** **complete**（闸门 Gate 1 **待验收**——验收要在大老板让大哥上岗后真跑一轮）
- **对应缺口：** G-02、G-03 ｜ **对应闸门：** Gate 1
- **关键决策：** F2.1（Trigger 由 node 侧生成）/ F2.2（Fast Path 写代码里）/ F2.3（双段输出，`alreadyReported` 不过滤）/ F2.4（水位线用交班戳）/ F2.5（拆成两个视图）
- **提交：** `309dcd4` `feat(facts): 事实表分候选与全量两层，触发事件先过程序层的闸`
- **文件：**
  - 新增 `miniapps/mimic-tear/miniapp/node/trigger.mjs`（契约 + 第一道闸）
  - 新增 `miniapps/mimic-tear/miniapp/node/trigger-source.mjs`（检测器，四类源）
  - 改 `miniapps/mimic-tear/miniapp/node/patrol-cli.mjs`（`facts --scope`、`triggers` 段、`excluded` 计数）
  - 新增 `tests/trigger.test.mjs`（15 条）；改 `tests/patrol.test.mjs`（既有 3 条改读 `raw` 视图 + 补默认视图断言）
- **测试增量：** 619 → **634** 全绿（+15）
- **四道守卫：** 全绿（`check-published` 在发布后复跑才绿）

### Phase 2 收尾块

**退出证据三条，全部拿到：**

1. **事件源可枚举** —— 四类（项目活动 / 新问卷卡 / 会话中断 / 值班唤醒）各有单测；白名单里每一项都断言「在快照里真能产出事件」。
2. **Fast Path 有会失败的断言** —— **8 个变异逐个改坏，全部变红**（M1 管辖闸 / M2 类型闸 / M3 封闭集合校验 / M4 id 稳定性 / M5 水位线 / M6 候选视图不过滤项目 / M7 不过滤决策 / M8 不过滤目标）。
3. **上下文体积可测量地下降** —— 真实数据：**85,540 → 59,265 字节（-30.7%）**。

**真实数据上的过滤效果：**

| 项 | 全量 | 候选 | 滤掉 |
| --- | --- | --- | --- |
| projects | 15 | 1 | 14 |
| decisions | 22 | 5 | 17 |
| recoverable | 6 | 2 | 4 |
| goals | 8 | 1 | 7 |
| planTasks | 9 | 0 | 9 |
| 触发事件 | 3 | **2** | 1（越权） |

**两条实测得来的口径（写进了代码，不只在文档里）：**

- **水位线用交班戳**（F2.4）——「上一轮交班之后发生的事」。大哥休息五天，醒来那五天的事一条不漏。
- **`alreadyReported` 不过滤**（F2.3）——那是大哥自己的账，忘了就会重复报。实测它占事实表 **31.1%**，是最大的一块，但**恰恰不能裁剪**。

**变异验证里的一次失手（第二次了）**：M7（去掉决策项过滤）第一次**没被抓住**——因为体积断言太粗，去掉一个过滤器它照样能过。补了「管辖区外的项目名一个都不许出现」的精确断言后抓住。**粗断言抓不住细粒度的过滤**——这条已经记在项目的验证纪律里。

### 发布与四层验收（2026-11-01 03:54）

| 层 | 结论 | 证据 |
| --- | --- | --- |
| ① 仓库 ↔ 发布副本 | **一致** | `check-published.mjs`：无漂移；`trigger.mjs` 与 `trigger-source.mjs` 都在发布副本里 |
| ② 运行时被替换 | **是** | `runId` `fa6a5cd5…` → `7d14c469…`，日志 `runtime.start_requested` → `runtime.ready` |
| ③ 运行时加载发布副本 | **是** | `miniapp inspect` 的 `source: "local"`；发布副本与仓库逐字节相同 |
| ④ 新代码真的在跑 | **是（且这一层比 Phase 1 更直接）** | Phase 2 改的是**大哥 cron 调用的 CLI**，不是板面运行时。所以「跑的是新代码」由**发布副本的 CLI 在真实数据上跑出新行为**直接证明（下面） |

**产物级验证（真机 + 真数据 + 真调用，用发布副本那份 CLI）：**

```
scope=candidates  fullScopeRequested=False
projects=1  decisions=5  recoverable=2
excluded: projects=14 decisions=17 recoverable=4 goals=7 planTasks=9
triggers: 候选=2  筛掉=1（越权=1）  水位线=1793332029242
  - duty-wake / duty / 值班轮次醒来
  - project-activity / Mimic Tear / 最近一次活动在 2026-10-31T19:43:51.629Z
```

**注意这一层与 Phase 1 的差别**：Phase 1 改的是**运行时**的模块图，所以要用「心跳在推进」间接证明；Phase 2 改的是**大哥 cron 调用的 CLI**，而 CLI 不进运行时——所以**直接跑发布副本那份 CLI 就能证明**，不需要间接推断。

**待办：**

1. **Gate 1 未验收** —— 验收要在大老板让大哥上岗后，真跑一轮，看 `triggers.candidates` 里的事件是不是「这一轮真的该管的事」。
2. **大哥的技能与 cron 提示词还没用上 `triggers`** —— 目前 `triggers` 段只是**事实表的一部分**，大哥读不读它取决于提示词。那是 Phase 3（订阅直通）与后续阶段的事：等事件有了归属和投递通道，再让提示词改成「先看 `triggers.candidates`」。
3. **语义层（Slow Path）仍在提示词里** —— 程序层只做确定性准入，「这条要不要动手」还是模型判。这一层本来就该留给模型（F2.2）。

## Phase 3 — 直通：Thread 与订阅

- **状态：** **能力已落地，闸门 Gate 2 待验收**（还差一次真实的成功投递）
- **对应缺口：** G-04（**G-05 拆到 Phase 3b**）｜ **对应闸门：** Gate 2
- **关键决策：** F3.1（投递口 = `context.agent.run({sessionId})`）/ F3.2（归属落成订阅表）/ F3.3（已投出 ≠ 已执行）/ F3.4（默认关）/ F3.5（降级免费长出来）/ F3.6（字段名的自我修正）
- **提交：** `5f711e7` `feat(direct): 直通投递 —— 事件直接进项目会话，不经过大哥`
- **文件：** 新增 `thread.mjs` / `thread-subscriptions.mjs` / `direct-delivery.mjs` / `direct-delivery-runner.mjs` / `tests/thread.test.mjs`；改 `patrol-cli.mjs`（`thread` 命令 + 事实表带 `threads`）、`server.mjs`（板面定时器接上直通）
- **测试增量：** 634 → **646** 全绿（+12）

### Phase 3 收尾块

**开工前先查清的一件事：node 侧能不能直接投递？** 这是整个阶段的地基，查错了后面全白做。三条候选路，逐一核实：

| 候选 | 结论 | 依据 |
| --- | --- | --- |
| spawn `mavis session send` CLI | **不可用** | 实测 `mavis.cmd` 指向已删除的 `daemon/cli.js`，报 `Cannot find module` |
| `context.agent.answer()` | **不可用** | 只能答**本 Mini App 拥有**的会话（主规格 §15.6） |
| `context.agent.run({ sessionId, text })` | **可用** | 宿主官方文档（`app.asar` 里的 `miniapp-creator/references/client-api.md`）：「**Continuing a session keeps its Agent**」，示例传任意 `sessionId` |

> 这条是**从宿主源码查出来的，不是猜的**。而且有个坑：文档里 `session_not_found` 那条限制是写给
> **读侧**（`observe`/`sessions`/`session`）的——按读侧的结论去推写侧，会把唯一的路也一起否掉。

**变异验证：6 个新检查逐个改坏，全部变红**（M1 越权闸 / M2 没有投递口也投 / M3 重复投递 / M4 失败也记账 / M5 投错会话 / M6 落空的投递口不拒绝）。

> **这一轮踩了个自己的坑**：第一次跑变异时用 `git checkout --` 还原，而**新文件还没被 git 跟踪**——
> 还原静默失败，M3 之后的失败数是累积的（2/3/3/4），**结果被污染**。而且 `git checkout` 对**已跟踪**的
> `patrol-cli.mjs` 生效，把 Phase 3 的 CLI 改动整个抹掉了（`thread` 命令消失），是测试报「未知命令」
> 才发现的。**教训：变异验证的还原手段必须先验证它能还原；先提交，再变异。**

**一次自我修正（F3.6）**：写轮次模块时照着记忆把问卷主键字段从 `id` 改成 `requestId`——**改错了**。
运行时存储层返回的就是 `id`（`id: row.request_id`），**CLI 那层才改名成 `requestId`**。结果是主体变成
`undefined`。补了一条测试钉住它（「待答的问卷要成为候选事件，主键要接对」）。**这类错不会报错，只会静默产出错误的事件。**

**闸门为什么还没过**：直通的投递口从宿主文档确认了，但**还没有一次真实的成功投递**。开关
`directDelivery` 默认关，就是为了让这件事在真实验证之前**不产生任何行为**。验收需要：开一条订阅 →
造一个事件 → 看到它出现在项目会话里（而不是大哥的上下文里）。

**待办：**

1. **Gate 2 待验收** —— 需要一次真实投递（见上）。
2. **Phase 3b（G-05：上下文组织）**：Inline & Spill + 链式召回短程版。从 Phase 3 里拆出来，因为它是**上下文**的事，不是**路由**的事。
3. **Phase 4 要改仓库外的两份文本** —— 大哥的 `cron-prompt-duty-canonical.txt` 与 `mimic-tear-boss` 技能。直通打开的前提就在这里（F3.4）。

### 本轮发现的一个既有抖动（不在本次改动范围内）

`tests/persistence.test.mjs` 的「并发写不同记录」在**全量**跑时偶发失败（5 次全量里 1 次），单跑该文件
连续 3 次全绿。查过：`saveDispatch` 走的是带锁 + 自愈的 `updateJsonArray`（`LOCK_TIMEOUT_MS = 15_000`），
**不是本次改动碰过的路径**。**判断：Windows 文件锁在并行负载下的既有抖动**，本次新增的测试文件让
`node --test` 的并行负载变重，可能让它更容易露头。**没有掩盖，也没有顺手改**——它值得单独查一次，
但不该混在这个阶段的提交里。

## Phase 4 — 产出收敛与低打扰

- **状态：** pending
- **对应缺口：** G-11 ｜ **对应闸门：** Gate 1.5
- **关键决策：** F4.1（语义上界）/ F4.2（归档不删）/ F4.3（≤100 词断言）

## Phase 5 — 线视角的板面

- **状态：** pending
- **对应缺口：** G-01 ｜ **对应闸门：** Gate 3
- **关键决策：** F5.1（线 = 项目 + 作为 + 待决策）/ F5.2（旧总览降为下钻）

## Phase 6 — 韧性：判进展、全双工、状态收口

- **状态：** pending
- **对应缺口：** G-09、G-07、G-08 ｜ **对应闸门：** Gate 4
- **关键决策：** F6.1（确定性判据，不用模型判）/ F6.2（只改轮次层）/ F6.3（收口但不建库）

---

## 错误日志

（暂无。基线干净：`node --test` 602 项全绿。）

---

## 重启检查（下一个 session 的 5 个问题）

1. **本计划落到几个阶段了？**
   **3/6**（Phase 1、2、3 均已落地；Phase 3b 未开工）
2. **当前测试条数？**
   **646/646 全绿**（基线 602；Phase 1 +17、Phase 2 +15、Phase 3 +12）
3. **哪个阶段在进行？**
   **无**（下一个是 **Phase 3b · 上下文组织**：Inline & Spill + 链式召回短程版 —— 对应 G-05；再往后是 Phase 4 产出收敛）
4. **分支与工作树状态？**
   分支 `feature/super-agent-alignment`（主工作树上，未开独立 worktree）。提交：`bca89e9`（Phase 1）、`309dcd4`（Phase 2）、`5f711e7`（Phase 3）。发布副本已同步（check-published 绿）。
5. **基线规格 §4 的缺口台账与本文档还一致吗？**
   一致。**G-10 / G-02 / G-03 / G-04 已落地**；Gate 5、Gate 1、Gate 2 **都待验收**（都要等大老板让大哥上岗后的真实验证）。台账条目的状态更新与本文件同一次改动一起做。
