# 看门狗的生命周期：跟着 MiniMax 走

- 时间：2026-10-26 14:0x–15:1x
- 触发原因：老板反馈「**在我们未打开 MiniMax 的情况下**，时不时有个终端启动后马上关闭」，并明确「**我不想后台挂多一个'无用'进程占资源**」。
- 归属：`miniapps/mimic-tear/miniapp/node/`、`tests/`
- 状态：**已实现、已发布、已真机验证**

---

## 0. 结论先行

老板说的两件事，根因是同一个，而且**不是同一个层面的问题**：

| 老板看到的 | 真实原因 | 层级 |
| --- | --- | --- |
| 终端窗口一闪即逝 | 控制台程序直接跑 → Windows 分配控制台 → 默认宿主是 Windows Terminal → 弹窗 | **症状** |
| 后台多一个无用进程 | 固定 5 分钟的定时任务，无条件唤醒 | **根因** |

修法也不在同一层：

| # | 缺陷 | 修法 | 落点 |
| --- | --- | --- | --- |
| 1 | 固定 5 分钟触发，与被看守对象的节奏无关 | **一次性触发 + 自我重排**：每轮跑完自己算出「下一次值得检查的时刻」 | `watchdog-schedule.mjs` + `watchdog-rearm.mjs` |
| 2 | 控制台程序直接跑，弹 Terminal 窗口 | 经 `wscript.exe`（GUI 程序，不分配控制台）隐藏启动 | `run-watchdog-hidden.vbs` |
| 3 | MiniMax 关着时看门狗还在跑 | **宿主不在 → 看门狗禁用自己**（`schtasks /change /disable`），彻底不醒 | `host-liveness.mjs` |
| 4 | 停掉之后谁来叫醒它 | **大哥交班时叫醒**——交班本身就发生在 MiniMax 内部，是「宿主活着」的自然信号 | `watchdog-wake.mjs` + `patrol-cli.mjs` |

---

## 1. 现象定位（全部实测）

### 1.1 「与 MiniMax 无关」这条线索

老板的原话是「**即使在我们未打开 MiniMax 的情况下**」。这是关键：**与 MiniMax 进程无关的东西**，只能是 OS 层面的东西。

机器上所有非 Microsoft 计划任务里只有一个是本项目的，且是**每 5 分钟**一次——和「时不时」完全对得上：

```
\  MSFT_TaskTimeTrigger/rep=PT5M
   "C:\nvm4w\nodejs\node.exe" "...\watchdog.mjs" --data-dir "..."
```

### 1.2 抓到窗口出现的瞬间

用 Win32 枚举顶层窗口（按 **HWND** 去重，不按标题——Windows Terminal 会改同一个窗口的标题，按标题去重会把「改标题」误判成「新窗口」），在任务自然触发时抓到：

```
13:40:01.694  cls=CASCADIA_HOSTING_WINDOW_CLASS  pid=24416(WindowsTerminal)  title="Terminal"
13:40:01.831  cls=PseudoConsoleWindow              pid=22872(node)             title=""
```

`CASCADIA_HOSTING_WINDOW_CLASS` 就是 **Windows Terminal**。任务在 `13:40:00` 触发，窗口在 `13:40:01` 出现——因果链闭合。

### 1.3 为什么是「一闪即逝」

watchdog 一轮只要 **262ms**（实测）。窗口存在 0.26 秒就消失，所以只会被看成「闪一下」。

### 1.4 为什么是 Windows Terminal

本机装了 Windows Terminal 1.24，它是**默认控制台宿主**。控制台程序启动时，Windows 把控制台交给默认宿主 → Terminal 拉起一个窗口。

对照实验（同样是计划任务、同样交互式会话）：

| 启动方式 | 新 Terminal 进程 | 退出码 |
| --- | --- | --- |
| `node.exe` 直接跑（现状） | **1** | 透传 |
| `conhost.exe --headless node.exe` | 0 | **吞掉（永远 0）** |
| `powershell.exe -WindowStyle Hidden` | **仍会弹**（PowerShell 自己也是控制台程序） | 透传 |
| `wscript.exe` + VBS `Run(cmd,0,True)` | **0** | 透传 |

`conhost --headless` 那条最阴险：watchdog 崩了也报成成功（`Last Result: 0`）。**不能用**。

---

## 2. 根因：触发节奏与被看守对象无关

| 事实 | 值 | 来源 |
| --- | --- | --- |
| 大哥的交班周期 | **30 分钟**（cron 在 :07 / :37 触发） | `runtime-state.sqlite` 的 cron runs |
| 掉线阈值 | **45 分钟** | `view-model.mjs` 的 `dutyStaleAfterMinutes` |
| 旧 watchdog 周期 | **5 分钟** | 计划任务 XML |

**5 分钟轮询一个 30 分钟才变一次的信号 = 6 倍过采样。** 一天 288 次唤醒，而答案一天最多变 48 次。

**少轮询会不会漏掉证据？不会。** `computeDutyEvidence` 的空档是从**调度器永久运行日志**里、由两次交班的时间戳算出来的，不是从「我们轮询了几次」算出来的。45 分钟的证据窗口 ÷ 45 分钟的掉线阈值 = 1，即使 45 分钟查一次也足以在阈值刚过时抓到。

> **规则：在答案可能改变的时刻醒，不要在固定计时器上醒。**

`watchdog-schedule.mjs` 的 `decideNextCheckAt()` 是纯函数（22 项单测）：

| 状态 | 下次检查 | 理由字段 |
| --- | --- | --- |
| 大哥在岗（健康） | **下一次交班到期 + 1 分钟**（约 30 分钟） | `awaiting_next_handover` |
| 大哥超期 | 掉线阈值之前（≤ 15 分钟） | `overdue` |
| 投递失败 | **5 分钟** | `delivery_failed` |
| 大哥从没交班 | 值班周期（30 分钟） | `never_ran` |

**答「该不该说话」和答「什么时候再看」是两个问题**，必须由不同代码回答——有单测专门断言「同一个 duty 下，`action` 不影响 `delayMinutes`」。

---

## 3. 生命周期跟着 MiniMax 走（老板的核心诉求）

### 3.1 一个关键事实

**大哥的 cron 只在 MiniMax 开着时才跑。** 实测数据：

```
2026-10-21T22:12  ← 最后一次
2026-10-22T00:37
2026-10-26T05:37  ← 整整 4 天零交班 = MiniMax 关着的时段
2026-10-26T06:07
```

所以 **MiniMax 一关，「大哥掉线」就必然成立**——那是算术，不是事故。一个在 MiniMax 关闭时还在报告「大哥掉线」的看门狗，是在对着空气喊话。

### 3.2 停掉

`host-liveness.mjs` 用 `tasklist` 查宿主进程（实测 140ms，比 WMI 的 204ms 便宜且不依赖 COM）。

> **一条铁律：探针失败必须报「活着」。**
> 误报「宿主没了」= 看门狗永久静默；误报「宿主还在」= 多醒一次。方向不对就全错。
> 单测专门守着这一条：`a probe that fails is reported as ALIVE, never as gone`。

宿主不在 → `schtasks /change /disable` → 任务 `Disabled`、`Next Run Time: N/A`、**零残留进程**。后台彻底干净。

### 3.3 叫醒

**大哥交班（`patrol-cli report --duty-stamp`）就是「宿主活着」的自然信号**——它本来就发生在 MiniMax 内部，交班戳也已经在那里写了。

于是交班时顺手 `enable` + `/run` 一次：看门狗醒来，补算关着期间漏掉的轮次（这些空档在永久日志里，不会丢），然后重排自己的日程。

备选方案都否掉了：

- **Mini App 的 node 运行时**：它是 `on-demand` 的，只有打开板面才跑 → 看门狗只会在用户碰巧开板面时才醒。
- **再加一个慢速哨兵任务**：那就是又一个后台任务，正是老板不要的。
- **WMI 事件触发器**：`schtasks /xml` 拒绝那个订阅（CDATA 包裹的查询回来是 "unexpected node"），而且把正确性押在 XML 转义上太脆。

### 3.4 最重要的一条不变量

**叫醒失败绝不能影响交班。**

一次因为看门狗叫不醒而失败的交班，是拿「值班链停止汇报」去换「看门狗安静」——本末倒置。所以叫醒是 best-effort，失败被记录但交班照走。单测守着：`a handover is never broken by a watchdog that cannot be woken`。

---

## 4. 途中踩到的五个坑（都已修 + 有单测守着）

### 4.1 `<Command>` 里带了 `//B` → 任务静默失败，还弹「选取应用」

最初把 `//B` 和脚本路径都放进 `<Command>`：

```xml
<Command>"C:\WINDOWS\System32\wscript.exe" //B "C:\...\run-watchdog-hidden.vbs"</Command>
```

Windows 把**整个字符串当成一个文件路径**，于是启动 `OpenWith.exe`——**弹出「选取应用」对话框**。这正是 14:00:01 抓到过的那次 `Open With Dummy Window` 的真凶。

而且它**静默失败**：`Last Result: 0`（成功！），看门狗根本没跑。

正确形状：`<Command>` 只能是可执行文件，其余全在 `<Arguments>`。

> 教训：**`<Command>` 是可执行文件，不是命令行。** 放错地方的 `//B` 不会报错，只会让 Windows 去「打开」一个不存在的文件。

### 4.2 VBScript 的 `i` 没声明 → `wscript` 吞掉错误并返回 0

`Option Explicit` 下循环变量 `i` 没写进 `Dim`，脚本直接语法错误退出。

**危险之处**：用 `wscript.exe` 跑时，**运行时错误被吞掉并返回退出码 0** —— 一次崩溃的看门狗，在计划任务眼里是「成功」。真机首测就是这样：`Last Result: -2147020576`，状态文件纹丝不动。

修：`Dim` 补上 `i`；加两道**外部**防护——启动前校验两个文件真的存在（不存在就用不同退出码拒绝启动）；单测用 **`cscript.exe`**（它会把脚本错误打到 stderr）跑一遍 VBS，断言没有 `Microsoft VBScript` 错误行。

> 教训：**凡是靠退出码传递成败的地方，语法错误本身就是最危险的失败模式。** 必须用另一个宿主把它验出来。

### 4.3 `schtasks /xml` 要 UTF-16 **带 BOM**

无 BOM 被拒：`ERROR: Invalid argument/option`。Node 的 `'utf16le'` **不写 BOM**，必须手工拼 `FF FE`。

### 4.4 `schtasks /tr` 会把引号剥掉

`/tr` 形式下 `Task To Run` 里引号全没了，路径含空格就废。改用 `/xml` 注册。

> 附带发现：`schtasks /change /ri` **会弹密码提示**，非交互环境下不可用——所以动态改间隔这条路不通，自我重排（`/create /xml /f`）才是可用机制。已实测：`/create /xml /f` 能**重新启用**被禁用的任务。

### 4.5 `WScript.Arguments` 会剥掉引号

VBS 里 `WScript.Arguments(0)` 拿到的是**去掉引号**的路径。重新拼命令时必须自己补引号，否则含空格的路径会散架。

> 这条也是**为什么参数要按位置传**而不是拼字符串：`<Arguments>` 里每个路径各自带引号，VBS 读进来各自独立，重新拼装时逐个补回。

---

## 5. 验收

### 5.1 单测（386 项全绿）

```
tests/watchdog-schedule.test.mjs            22 项  纯函数：四种状态 + 边界 + 「调度与判定分离」
tests/watchdog-rearm.test.mjs               14 项  XML 构建、一次性 vs 固定间隔、<Command> 只放可执行文件、本地时间格式
tests/watchdog-launcher-script.test.mjs      6 项  VBS 语法、无参数退出码、变量声明、缺文件拒绝启动
tests/watchdog-schedule-integration.test.mjs 6 项  在岗 vs 离岗的节奏对比 + 端到端
tests/watchdog-hidden-launch.test.mjs        12 项  隐藏启动器、无控制台窗口、安装器与自我重排同源
tests/host-liveness.test.mjs                 9 项  存活检测，**探针失败必须报活着**
tests/watchdog-wake.test.mjs                 9 项  叫醒，且交班永不被叫醒失败打断
```

### 5.2 真机（全部实测）

| 检查 | 结果 |
| --- | --- |
| 发布副本 vs 仓库 | **逐字节一致**（SHA256 全文件比对） |
| 任务实际跑起来了 | **是**（状态文件 mtime 前进，`Last Result: 0`） |
| **Windows Terminal 新进程** | **0**（旧方案每 5 分钟 1 个） |
| 残留 watchdog 进程 | **0** |
| 宿主在时的下次检查 | **30 分钟后**（对齐大哥交班；旧方案 5 分钟） |
| 宿主不在时 | 任务 `Disabled`、`Next Run: N/A`、残留 **0** |
| 大哥交班时 | 看门狗被叫醒（`enabled:true, ran:true`），交班戳照常刷新 |
| 漏轮告警不丢 | 4 天空档（201 轮）仍在永久日志里，下次打开照常补算 |
| toast 送达 | 隐藏启动下**仍能送达**（`TOAST_SENT`） |

---

## 6. 一句话

**这不是一个「终端窗口」的问题，是一个「不该问的还一直问、没人听还一直说」的问题。**

现在它：大哥在岗时睡到下一次交班到期（30 分钟），大哥掉线时加密到 15 分钟以内，投递失败时 5 分钟重试，**MiniMax 关着时彻底停掉、不占一个字节**，大哥一交班就归位。

醒来的次数从一天 288 次降到按需的几倍，该报的一次没少，后台该干净的时候干净。
