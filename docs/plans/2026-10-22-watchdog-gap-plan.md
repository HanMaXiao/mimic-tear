# Watchdog 两条缺口的方案（交大哥拍板）

- 提交人：Mimic Tear 负责人线（`mvs_bf21987f`）
- 时间：2026-10-22 03:1x
- **本轮只出方案，不写码**（大哥 03:0x 指令：先交方案 + 验收标准，别直接写码）
- 归属：本方案不碰 `client/` 与 spec §6（UI/UX 线）。落在 `miniapps/mimic-tear/miniapp/node/`、`tests/`、`docs/plans/`
- 上游证据来源：`~/.minimax/v2/sqlite/runtime-state.sqlite`（只读）、`schtasks /query`、已发布副本

---

## 0. 先说一个卡住的地方：闸设不上

大哥要求「方案所在的 goal 自己带上 `token_budget=400000` 的闸」。**实测运行时拒绝自主改预算**：

```
update_goal(mode=token_budget, token_budget=400000, …)
→ Goal token-budget updates require an explicit user request in the current turn;
  autonomous continuations, scheduled work, subagents, and background work cannot change the budget.
```

这一轮是大哥发起的，不是大老板发起的，所以**闸设不上**。`tg_s1qx87925` 现在的 `tokenBudget` 仍然是 `null`——**跟造成 758 万的那个条件一模一样**。

**需要大老板在本会话里说一句**「给 tg_s1qx87925 加 400000 的 token 上限」，我收到就能设上。这是运行时唯一的允许路径，不是绕过。

在这一句到来之前，我按 400k 的上限自我约束（这条线已用 224,780，余量约 175k）：本轮只交方案，不开实现轮。

---

## 1. 缺口一：补交班会抹掉漏班证据

### 1.1 现状（代码事实）

| 位置 | 事实 |
| --- | --- |
| `node/watchdog-rules.mjs:44` | `evaluateDuty(config, now)` → `buildDutyStatus({config})` |
| `node/view-model.mjs` `buildDutyStatus` | 活性判定**只读 `config.lastRunAt` 一个时间戳** |
| `node/patrol-cli.mjs`（report） | 每次交班 `setConfig({ lastRunAt: Date.now() })` |

**判 stale 只有一个时间戳，而交班会把它刷新。** 所以：漏了 N 轮 → 补交一次 → 那段空档从此不可见。

### 1.2 实测证据：运行时库里有永久的漏班记录

`local_runtime_v2_cron_runs` 逐轮记录调度：

```
run_id | cron_id | session_id | status | created_at_ms | delivered_at_ms | failed_at_ms | error_code | error | trigger_source
```

值班 cron（`672fde94-0c52-466d-831e-e2919f49b64a`）29 条记录，三个大缺口：

| 断点 | gap | 按 30 分钟一轮，缺几轮 |
| --- | --- | --- |
| 10/21 00:37 → 08:07 | 450m（7.5h） | **14** |
| 10/21 11:37 → 18:37 | 420m（7h） | **13** |
| 10/21 19:37 → 10/22 02:07 | 390m（6.5h） | **12** |

另有 10/20 17:07 → 18:37 的 90m 小缺口（缺 2 轮）。全部 32 条 `status` 都是 `delivered`——**调度器根本没触发**，不是触发了但失败。

**这张表是永久的。`lastRunAt` 会被下一次交班覆盖，它不会。**

> **一个必须先钉死的口径差**：大哥台账写「19:37→02:07 漏了 13 轮」，而按"两轮之间**应该**触发但没触发"的定义是 **12** 轮（20:07…01:37 共 12 个槽位）。差一个不是小事——它决定告警文案里写 12 还是 13。方案必须把公式写死，见 §1.3。

### 1.3 方案：把"证据"和"活性"分成两件事

**新增（只读）**：`RuntimeStore.listCronRuns(cronId)` —— 从 `local_runtime_v2_cron_runs` 读该 cron 的轮次记录。

**新增（纯函数）**：`computeDutyEvidence({ runs, periodMs, now })`，输出：

| 字段 | 含义 | 公式 |
| --- | --- | --- |
| `missedRounds` | 累计漏了几轮 | Σ `max(0, floor(gap / periodMs) - 1)` + `status != 'delivered'` 的轮数 |
| `lastGap` | 最近一段空档 | `{ from, to, gapMinutes, missedRounds }` |
| `currentStale` | 现在有没有人在交班 | **不变**：只看 `lastRunAt` |
| `erasedOutage` | 有过一段被补交抹掉的空档，且证据还在 | `lastGap.missedRounds > 0 && now - lastGap.to < 证据保留窗口` |

**口径钉死**：`missedRounds` 用 **"应该触发而没触发的槽位数"**（`floor(gap/period) - 1`），不用"gap 里装了几个周期"。大哥台账那个 13 要改成 12，或者我们统一改口径——**由大哥定，我建议按"槽位数"**（13 的口径把"补上的那一轮"也算成漏了）。

**watchdog 的判定从二态变三态**：

| action | 触发条件 | 含义 |
| --- | --- | --- |
| `none` | 没事 | —— |
| `stale` | `currentStale` | 现在没人交班（旧行为不变） |
| `missed` | `erasedOutage` 且这段空档没报过 | **曾经漏过、刚补交、证据还在**（新） |
| `recovered` | 从 stale/missed 回到正常 | 旧行为不变 |

`missed` 必须**去重**：watchdog 状态文件里记「已报过的空档的 `to` 时间戳」，同一段空档只报一次。

**为什么这条值得做**：现在"漏了 13 轮"这种事，**只有大哥自己翻运行时库才能发现**，而且它在补交班那一刻就被抹掉了。watchdog 的职责就是"没人看着的时候替人看着"——而它现在恰恰在最重要的那一刻（补交班）把证据擦了。

### 1.4 验收（node 可验，不用「跑一次看看」）

| # | 验收内容 | 怎么验 |
| --- | --- | --- |
| A1 | **「补交班抹掉证据」是可执行的 bug 证明** | 单测：造两条 run 相隔 390 分钟 + 一个新鲜的 `lastRunAt` → 断言 `evaluateDuty` 返回 `stale: false`（旧行为看不到空档）**且** `computeDutyEvidence` 返回 `missedRounds: 12, erasedOutage: true`（新行为看得见） |
| A2 | 缺口能被算出来 | 夹具 `tests/helpers/fixture.mjs` 加 `local_runtime_v2_cron_runs` 表与两行（gap 390m）→ `node --test tests/watchdog.test.mjs` 断言 watchdog 判 `missed` 且 `missedRounds === 12` |
| A3 | 真实库回归 | `node watchdog.mjs --dry-run` 的 JSON 里 `missedRounds` 应等于 §1.2 表里的值（最近一段 = 12；累计 = 14+13+12+2 = 41） |
| A4 | 不重复报 | 连跑两次 tick → alert 文件里同一段空档（同一 `to`）只出现一次 |
| A5 | 旧行为没坏 | `lastRunAt` 够老 → 仍然报 `stale`；够新且无空档 → `none`。现有 watchdog 单测全绿 |

### 1.5 明确不做

- 不改 `lastRunAt` 的语义（它就是"上次交班时间"）。
- **不写运行时库**（只读）。
- 不动 `buildDutyStatus` 的阈值公式——"三处读数永远一致"是硬约束（§17.2）。
- 不碰 duty cron 的调度本身。

---

## 2. 缺口二：告警通道只有桌面 toast，计划任务只跑在交互式会话

### 2.1 现状（实测）

`schtasks /query /tn MimicTear-DutyWatchdog /xml`：

```xml
<UserId>S-1-5-21-495242730-3909305000-409151903-1001</UserId>
<LogonType>InteractiveToken</LogonType>     ← 只在交互式登录会话里跑
<StartWhenAvailable>true</StartWhenAvailable>   ← ✅ 已修
<Command>"C:\nvm4w\nodejs\node.exe"</Command>
<Arguments>"C:\Users\12391\.minimax\plugins\mimic-tear\miniapp\node\watchdog.mjs" --data-dir "…"</Arguments>
```

两个事实：

1. **会话彻底没了 → 任务不跑 → 「通知发不出去就写 alert.log」那个兜底也写不出来**——因为写日志的就是那个任务本身。
2. `watchdog.mjs` 跑的是**已发布副本**路径（`plugins/mimic-tear`），**不是仓库路径**。所以我改完必须 `miniapp publish`，否则跑的还是旧的。

还有一条：`node/watchdog.mjs` 的 `appendLog()` **只在送达失败时调用**。toast 弹成功了但大老板没看见（人不在电脑前 / 弹窗被吞）→ **磁盘上没有任何记录**。这本身就是个洞。

### 2.2 方案：主通道是文件，不是 toast

| 通道 | 什么时候有 | 作用 |
| --- | --- | --- |
| **① alert 文件（主）** | **永远** | 每次告警都写，JSONL 格式。无头可用、可被 node 读 |
| ② 看板补看 | 打开 Mini App 时 | 总览页读 alert 文件，显示"上次掉线告警" |
| ③ 桌面 toast | 有交互式会话时 | 尽力而为，弹了算赚到 |
| ④ Windows 事件日志 | 无头可用 | 最佳努力（`eventcreate`）；验收不好用 node 验，列为可选 |

**关键改动**：`appendLog()` 从"只在失败时写"改成"**每次告警都写**"。

**任务改法**：`<LogonType>` `InteractiveToken` → **`S4U`**（不需要存密码，用户没登录也能跑）。

**代价必须说清**：S4U 是非交互会话，**toast 弹不出来**。所以主通道只能是文件——这正是为什么 §2.2 的排序是"文件先行"。

### 2.3 验收（node 可验）

| # | 验收内容 | 怎么验 |
| --- | --- | --- |
| B1 | 任务不再依赖交互式会话 | node 跑 `schtasks /query /tn MimicTear-DutyWatchdog /xml`，断言输出里的 `<LogonType>` **不是** `InteractiveToken`（是 `S4U`） |
| B2 | **送达成功也要留痕**（旧行为是成功就不写） | 跑一次 watchdog tick，注入一个返回 `{ok:true}` 的假 deliver → 断言 alert 文件里**有**这条告警 |
| B3 | 送达失败也要留痕 + 记原因 | 注入抛错的 deliver → 断言 alert 文件里有失败原因与原文明文 |
| B4 | 看板读得到 | `project-service` 暴露 `GET /api/watchdog/alerts`（读最后 N 条）→ node 断言返回条数与 JSONL 字段 |
| B5 | 无头可跑 | `node watchdog.mjs --data-dir <临时目录>`（不带任何桌面交互）→ 断言退出码 0 且 alert 文件被创建 |
| B6 | 不重复报 | 同一段空档/同一次 stale 只写一条 |

### 2.4 风险与回退

| 风险 | 级别 | 缓解 |
| --- | --- | --- |
| **S4U 注册可能不被允许**（域策略 / 非域环境） | 高 | **实施第一步先实测**：用 `schtasks /create … /ru <user> /np /rl LIMITED` 注册一条同名测试任务，看能不能建起来。建不起来 → 回退方案见下 |
| 回退：继续 InteractiveToken | — | 接受"会话没了就没人看着"，但**至少把告警写入文件**（§2.2 的 ①②③ 不依赖 S4U）——这样下一次打开 Mini App 能补看 |
| 回退：另建一个"登录时触发 + 每小时触发"的任务 | — | 触发器多样化降低"一次都不跑"的概率 |
| 改计划任务需要管理员权限 | 中 | 实施前确认当前权限；不足就只做文件侧 |
| 看板加接口 = 改 `view-model` 载荷形状 | 低 | **只加字段不改字段名**，UI/UX 线不需要跟改（接缝 A 的"加字段 = 安全"） |

---

## 3. 顺序与切分

```
片 1（缺口一，纯 node）        片 2（缺口二）
  ├ RuntimeStore.listCronRuns   ├ alert 文件改 JSONL + 总是写（可单测）
  ├ computeDutyEvidence（纯函数）├ GET /api/watchdog/alerts（只加字段）
  ├ watchdog 三态判定 + 去重     ├ 实测 S4U 能不能注册
  ├ 夹具加表 + 单测              └ 注册任务（能则 S4U，不能则回退）
  └ 真实库回归
```

**片 1 先做**：不碰 Windows、不碰权限、纯 node，风险最低，且它是缺口二的前提（没有 missed 状态，alert 文件里也没东西可写）。

**片 2 分两半**：文件侧先做（可单测、可回滚），计划任务改法最后做（要实测、要管理员权限）。

---

## 4. 成本与闸

| 项 | 数值 | 依据 |
| --- | --- | --- |
| 片 1 | ≤ 150k | 纯 node：1 个存储方法 + 1 个纯函数 + 夹具 + 单测 |
| 片 2 | ≤ 200k | 文件格式 + 1 个接口 + 任务实测与注册 |
| 合计 | ≤ 350k | 留 50k 给验收回归与返工 |
| **单 goal `token_budget`** | **400000** | 大哥指定 |
| 单轮硬闸 | 600k | 实测每轮均值 344,698（758 万 / 22 轮） |

**闸的现实**：见 §0——运行时拒绝自主设预算，**要大老板一句话**。

---

## 5. 请大哥拍板的三件事

1. **口径**：漏轮数按"应该触发而没触发的槽位"（§1.3，12）还是按"gap 里的周期数"（大哥台账现在用的 13）？**我建议前者**——13 把补上的那一轮也算漏了。
2. **S4U 建不起来怎么办**（§2.4）：只做文件侧（接受会话没了就没人看着，但下次开 Mini App 能补看），还是退到"多触发器"方案？
3. **缺口二的看板呈现位置**：总览页一行，还是收件箱里一条？（这会动到 UI/UX 线的地盘，**如果选收件箱我需要和 UI/UX 线对一次**，选总览页则纯我这边加字段。）

---

## 附：这一轮顺手确认的事实（供大哥核对我的读数）

- 值班 cron 29 条调度记录，全部 `status=delivered`——**三个大缺口都是"调度器根本没触发"**，不是触发了失败。
- 计划任务 `StartWhenAvailable=true` 已经在位（之前修过），缺口只剩 `LogonType`。
- watchdog 跑的确实是已发布副本路径——**我改完必须 publish**，否则跑的还是旧的。
- `appendLog` 只在送达失败时被调用——**送达成功不留痕**，这是缺口二的第三个面。
