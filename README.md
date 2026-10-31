# 仿身泪滴（Mimic Tear）

> **多智能体项目管理指挥部** —— 跑在 [MiniMax Code](https://code.minimax.cn) 桌面端里的 Mini App。
> 把散落在几十个会话里的项目进度、待决策问题与团队层级收拢到一块看板，
> 并配备一个常驻本地 agent（**大哥**）替你盯盘、判断、派工。

---

## 名字的由来

这个项目的起点是两件不相干的事，凑到了一起。

**《艾尔登法环》的仿身泪滴骨灰。** 它是永恒之城诺克隆恩的一种骨灰，物品描述只有短短几行，却把这个设计的骨架说得清清楚楚：

> 「能召唤仿身泪滴的灵魂。
> 召唤时不消耗专注值，而是血量。
> 能模仿召唤者的模样，进行战斗的灵魂。
> **然而无法模仿召唤者的心智。**
> 此为永恒之城意图造王时，所留下的产物。」

召唤出来的是一具与你一模一样的化身——同样的武器、护甲、战技与祷告，用的正是你身上这一身配装。它不是一套固定强弱的招式，而是**你的构筑的复制品**。

还有个巧合：把它强化到 +10 之后，血量是玩家本体的数倍，中国玩家社区亲切地把它叫作**「大哥」**——「召唤大哥」「大哥 +10」都是那边的日常黑话，也有人叫它「艾尔登之王」。这个项目里那个常驻 agent 的名字，就是从这儿来的。

**手上攒了多年的开发经验。** 一个人同时推进十几个项目、几十个 agent 会话时，真正拖垮效率的从来不是「agent 做不出来」，而是**盯盘**与**派工**这两件重复劳动的总量：逐个会话看进度、找出卡住的那条线、确认有没有人在等你拍板；然后找到「负责这个项目的那位」，把话说清楚，再确认他真的收到了。

两件事的交集就是仿身泪滴：**把你的工作方法论复制成一个常驻岗位，它按你的标准替你盯着，而决定权仍然在你手里。**

| 仿身泪滴骨灰 | 仿身泪滴 |
| --- | --- |
| 骨灰召唤出与召唤者同形的化身 | 派一个常驻本地 agent，用你的方法论替你盯盘 |
| 复制你的武器、战技与配装 | 继承你的验收标准、决策原则与汇报纪律 |
| 召唤消耗的是**血量**而非专注值 | 消耗的是**你的注意力**，而不是 token |
| **然而无法模仿召唤者的心智** | 它能执行，但「现在要不要做」由你决定 |

---

## 它解决什么

| 成本 | 具体是什么 | 仿身泪滴怎么做 |
| --- | --- | --- |
| **盯盘成本** | 逐个会话翻进度、找卡点、查有没有人在等你回答 | 状态自动聚合成看板；待决策问题自动进收件箱，按严重度排序 |
| **派工成本** | 找到该项目的负责人会话，说清楚，再确认收到 | 一键下达；派工带幂等键，投递结果回写看板 |

配套的能力是：**不必时刻盯屏**。大哥会自己醒来巡检，判断哪些事真的需要你出手，其余的它直接处理并交班。

---

## 核心：大哥

「大哥」不是看板上的一个标签，而是这个项目里**唯一一个常驻的本地 agent**：稳定名 `boss`，独立的目录、记忆与技能，人格设定为**总管**——带决策原则、汇报纪律和边界意识，而不是一个无差别的执行器。

它的职责边界可以压成一句话：**指挥部出事实，大哥出判断。**

看板（Mini App）负责把运行时状态拼成**事实简报**——项目总览、待决策项、计划与任务状态；大哥负责判断哪些真的需要你出手。事实留在指挥部，判断留在大哥，谁都不越界。

### 四项常驻职责

| 职责 | 做什么 | 边界 |
| --- | --- | --- |
| **主动巡检** | 定时醒来检查全部项目，产出事实简报并提出派工建议 | 只提建议，不替你拍板；每条结论都上板留痕 |
| **派工决策** | 按目标性质选执行路径：复用现有 Goal / 纯调研 / 单点实现 / 验收审计 / 拆子会话并行 / 查能力库选领域 skill | 派工前必问三件事：目标是什么、验收标准是什么、会不会和现有在跑的任务冲突 |
| **后台值班** | 看板没开时，由运行时的 cron 唤醒它值守，每轮产出交班汇报 | 值班轮次、结论、投递全部可回溯，不做「口头汇报」 |
| **技能沉淀** | 从实际执行中提炼可复用技能 → 协调封装 → 注册 → 纳入调度 → 定期校验退役 | 只有 `active` 的技能进入派工池；`retired` 不会被自动复活 |

### 决策原则

1. **先看证据再看结论** —— 任何项目状态判断必须来自运行时数据，不臆测。
2. **派工前先问三件事** —— 目标 / 验收标准 / 是否与在跑任务冲突。
3. **默认用最轻的执行路径** —— 项目内能直接做的就不新建 agent，需要并行才拆子会话。
4. **不确定就升级** —— 改需求、删数据、破坏性操作、跨项目资源冲突，一律回问。
5. **汇报纪律** —— 只报状态变化与需要决策的事，不做流水账。

### 升级边界

以下情形**必须回问你**，不会自行决定：需求变更、破坏性操作、跨项目冲突、需要大量 token 的新开 Goal、连续失败 3 次以上。

### 它管不到的地方

这一节写明产品的边界，而不是藏着。运行时有两条实测出来的硬限制：

- **「已排队」不等于「已接手」。** 投递接口返回 accepted / queued 只代表消息进了队列，判断是否真的落地必须直读目标会话的历史。
- **正在热跑的 Goal 链会饿死排队消息。** 大哥能派工给空闲的负责人，但没法给正在续跑的 Goal 插话——实测有一整小时一次都没执行。

对应做法是**不重投、不硬闯、把选择权交回给你**：投递后核实落地；目标在跑 Goal 链时不再反复重投；评估过打断半成品的代价再决定是否强制并入；确实管不了就明确告诉你「大哥对这条线失去了转向能力」，并附上还在消耗的量，由你决定要不要强制收工。

---

## 界面

| 视图 | 内容 |
| --- | --- |
| **总览** | KPI、所有项目卡片与需要你关注的事项；顶部是大哥的值班状态 |
| **项目详情** | 组织树、Goal 进度、待回答问题、后台任务、任务级计划状态 |
| **决策收件箱** | 运行时产生的问题与大哥的巡检结论，按严重度排序，可确认、可排除（排除必须写理由） |
| **能力库** | 本机已安装的 skill 按领域分组 —— 大哥判断「这个活该派给谁」的依据 |
| **对话面板** | 直接和大哥对话；内容留在运行时里，刷新不丢。支持语音输入（麦克风 → 宿主本地识别 → 落进输入框，**不自动发送**） |
| **会话实况** | 宿主直读的会话清单：谁在跑、谁在等一个回答、每个会话最后一条回复是什么 |

**「会话实况」的数据来源与其它视图不同**：其它视图读运行时账本（大哥写的），这一页直接问宿主（宿主说的），不经过大哥。所以它比大哥的账本更即时——大哥汇报「一切正常」的同时，它照样能显示「有个会话卡在提问上」。

清单口径与宿主给用户看的那份一致：只列**根对话**（可见、非子会话、非定时任务、非 Mini App 自己的会话）。

**「等回答」有两个来源，取并集**：运行时里的待答卡（**权威**，页面关过重载过都还在）＋ 宿主工具事件（**加速**，只覆盖订阅之后新起的提问）。

板面还能**弹成置顶的桌面窗口**，一直挂在屏幕上。

---

## 数据从哪来

**运行时就是唯一数据源**，这个插件不自建状态库：

| 数据 | 来源 |
| --- | --- |
| 项目清单 / 团队层级 | `~/.minimax/v2/sqlite/runtime-state.sqlite`（只读，`node:sqlite`） |
| Goal 模式进度 | 同上 `local_runtime_thread_goals` |
| 待你回答的问题 | 同上 `questionnaire_requests` |
| 正在跑的后台任务 | 同上 `local_runtime_background_tasks` |
| 能力库 | `~/.agents/skills`、`~/.minimax/skills`、`~/.minimax/.builtin-skills` |
| 插件自身的状态 | Mini App 的 `dataDir`：`dispatches.json` / `acks.json` / `boss-session.json` 等 |
| 会话实况 | 宿主桥接 `agent.sessions()` / `agent.session()` / `agent.observe()`（需 `agentAccess: ["session.read"]`） |
| 语音识别 | 宿主本地识别 `window.mcode.miniapp.speech.transcribe`（需 `deviceAccess: ["microphone"]`） |

**只读**运行时库；写入只发生在插件自己的 `dataDir` 里。

> **权限**：`session.read` 与 `microphone` 两项都在插件详情里逐项开关，**默认都是开的**，没有首次使用弹窗。关掉之后板面会如实显示「未授权」，而不是假装没有会话。

### 大哥自己怎么读会话

板面那一页读的是宿主桥接（页面够得着、agent 够不着）；**大哥作为 agent 读的是运行时库**——两边同一口径，所以它汇报里的会话状态，你在板面上能对上。

```sh
node "miniapps/mimic-tear/miniapp/node/session-cli.mjs" list      # 会话表：谁在跑、谁在等回答
node "miniapps/mimic-tear/miniapp/node/session-cli.mjs" waiting   # 只列在等回答的
node "miniapps/mimic-tear/miniapp/node/session-cli.mjs" show <会话id>  # 单个会话 + 最后一段回复
```

输出是一张表：**状态 / 等回答 / 更新时间 / 会话 id / agent / 项目 / 标题**，表头带总数。

---

## 安装

### 方式 A：从 Git 仓库导入

桌面端「创建 → 从 Git 仓库导入」，地址填**带子目录**的这一条：

```
https://github.com/HanMaXiao/mimic-tear/tree/main/miniapps/mimic-tear
```

> **必须带 `/tree/main/miniapps/mimic-tear`。** 导入器会在**选定的目录**里找清单
> （`plugin.json` / `.minimax-plugin/plugin.json` / `.claude-plugin/plugin.json` / `.codex-plugin/plugin.json`），
> 只填仓库根地址它就看根目录，而本仓库的清单在 `miniapps/mimic-tear/` 里——
> 少了子目录就会报「所选目录不包含受支持的 Plugin 清单」。

### 方式 B：下载 Release 安装包

1. 到 [Releases](https://github.com/HanMaXiao/mimic-tear/releases) 下载 `mimic-tear-v1.1.2.zip`；
2. 解压后得到 `mimic-tear/` 目录，整体复制到：
   - Windows：`%USERPROFILE%\.minimax\plugins\mimic-tear\`
   - macOS / Linux：`~/.minimax/plugins/mimic-tear/`
3. 重启 MiniMax Code，在插件列表里确认「仿身泪滴」已启用。

> `.minimax-plugin` 是隐藏目录，复制时别漏。目录名必须是 `mimic-tear`（要和 `plugin.json` 里的 `name` 一致）。

### 方式 C：从 GitHub 克隆

```bash
git clone https://github.com/HanMaXiao/mimic-tear.git
# 把仓库里的 miniapps/mimic-tear 整个目录复制到 ~/.minimax/plugins/ 下
cp -R mimic-tear/miniapps/mimic-tear ~/.minimax/plugins/mimic-tear
```

### 方式 D：让 Agent 代劳

把仓库地址或 ZIP 交给 MiniMax Code，让它按「成品包流程」发布到本机。

---

## 开发

```sh
# 跑全部测试（node:test，无第三方依赖）
node --test

# 零依赖守卫脚本：发布漂移 / 打包 / 风格 / 决策记录
node scripts/check-published.mjs
node scripts/check-package.mjs
node scripts/check-style.mjs
node scripts/verify-agent-notes.mjs

# 把插件发布到本机 MiniMax Code（安装目录 ~/.minimax/plugins/mimic-tear）
node miniapps/mimic-tear/miniapp/node/server.mjs   # 或用 Agent 的 /miniapp-creator
```

> **测试条数是产物，不是常量。** 要准确的数字，跑一次 `node --test` 看最后几行——不要在文档里写死。
>
> `node --test` **不是零副作用**：它会创建 / 删除 / 恢复 Windows 计划任务 `MimicTear-DutyWatchdog`。这是必要的（那个任务必须被真的动过才算验收到），但要知道它在做什么。

仓库结构：

```plaintext
miniapps/mimic-tear/          插件本体
  .minimax-plugin/plugin.json  插件清单（提交市场时的入口）
  icon.png                    插件图标
  skills/                     随插件分发的 Skill 与项目自用的验证技能
  miniapp/
    miniapp.json              Mini App 声明（页面、Node 运行时、Agent 权限）
    client/                   前端（无构建步骤，原生 HTML/CSS/JS）
    node/                     Node 运行时（REST + SSE + 领域服务）
scripts/                      零依赖守卫脚本
tests/                        node:test 用例
docs/specs/                   设计规格
docs/plans/                   实施计划与踩坑记录
.agents/notes/                决策记录（Agent Note）：一个决策为什么这么定
.agents/skills/               仓库开发流程的技能
```

> **改完记得发布**：源码目录与运行目录不会自动同步，`~/.minimax/plugins/mimic-tear` 里跑的那份要自己同步过去，否则改的是源码、跑的是旧代码。`scripts/check-published.mjs` 会逐字节比对两边并列出双向差集。

---

## 贡献

`main` 分支受保护：改动走 PR，CI 必须绿，禁止强推与删除分支。合并请用 **Squash and merge**（分支保护启用了线性历史）。

```bash
git checkout -b feature/xxx
# ...改动...
node --test                       # 本地先跑绿
git push -u origin feature/xxx
# 开 PR，等 CI 变绿后合入
```

提交请用**路径限定**（`git commit -F <msg> -- <path...>`），不要用会扫全树的 `git add -A` —— 仓库里可能同时有另一个 agent 的在制品。

---

## 上架插件市场

插件已按 MiniMax Plugin 规范打包（`.minimax-plugin/plugin.json` + 至少一种能力 + 合法图标与分类）。提交入口是[官方投稿表单](https://vrfi1sk8a0.feishu.cn/share/base/form/shrcnbnpeor3z72fUkeHzrOE7vb)，选 GitHub 来源时填：

| 表单字段 | 值 |
| --- | --- |
| 仓库地址 | `https://github.com/HanMaXiao/mimic-tear`（**仓库根地址**，不带 `/tree/...`） |
| Ref | `main`（或某个 tag，如 `v1.1.3`） |
| Plugin 子目录 | `miniapps/mimic-tear` |
| 目标区域 | CN（首次上 US 需另开一份「新插件」提交） |
| 启用端 | 桌面端 |

> **提交记录**：CN 区域已于 **2026-11-01** 以「新插件」提交，Ref 钉在 **`v1.1.3`**（当时的 `main`）。
> 再上架 CN 选「**更新插件**」；**首次上 US 另开一份「新插件」提交**——两个区域各生成独立的
> submission_id 与发布记录。submission_id 在表单的「我的提交记录」里能查到，**记得保存**。
>

---

## 许可证

[MIT](LICENSE)。代码、文案、图标均为本项目所有。

《艾尔登法环》（Elden Ring）与 FromSoftware 为其各自权利人的作品，本项目与之无隶属或授权关系，仅在命名与设计立意上致敬。文中引用的物品描述取自简体中文本地化文本，「大哥」「召唤大哥」「艾尔登之王」等称呼出自中文玩家社区的日常用法。
