# 仿身泪滴（Mimic Tear）

多智能体项目管理指挥部。一个跑在 [MiniMax Code](https://code.minimax.cn) 桌面端里的 **Mini App**：把散在各个会话里的项目进度、待决策问题和团队层级汇到一块看板上，并把指令直接投递给对应项目的负责人会话。

> 用人话：你是大老板。开发、盯盘、验收这些活全交给 agent 团队，你只保留决策。仿身泪滴就是大老板的常设岗位——**大哥**。

---

## 它解决什么

同时开着十几个项目、几十个 agent 会话时，真正的成本不在「agent 做不出来」，而在两件事：

1. **盯盘成本** —— 得逐个会话看进度、看谁卡住了、看有没有在问我问题。
2. **派工成本** —— 找到「负责这个项目的那位」，把话说清楚，再确认他收到了。

仿身泪滴把这两件事做成一个看板：状态自动聚合，问题自动进收件箱，指令一键下达。

## 视图

| 视图 | 干什么 |
| --- | --- |
| **总览** | KPI + 所有项目卡片 + 需要你关注的事项；顶部是大哥的值班状态 |
| **项目详情** | 组织树、Goal 进度、待回答问题、后台任务、任务级计划状态 |
| **决策收件箱** | 运行时产生的问题 + 大哥巡检结论，按严重度排序，可确认、可排除（排除必须写理由） |
| **能力库** | 把本机已安装的 skill 按领域分组 —— 这是大哥判断「这个活该派给谁」的依据 |
| **对话面板** | 直接和大哥说话；他说的话留在运行时里，刷新不丢 |
| **会话实况** | 宿主直读的会话清单：谁在跑、谁在等一个回答、每个会话最后一条回复是什么 |

「会话实况」和其它视图的数据来源不同：其它视图读运行时账本（**大哥写的**），
这一页直接问宿主（**宿主说的**），不经过大哥。所以它比大哥的账本更即时 ——
大哥说「一切正常」的同时，它照样能显示「有个会话卡在提问上」。

页面上的会话清单是**你侧边栏里的全部根对话**（宿主上限 50 条，本机实测 48 条即全量）；
运行时里另外那 136 条是 agent 自己派生的子会话，不属于「用户的对话」，所以不列。

**「等回答」有两个来源，取并集**：运行时里的待答卡（**权威**，页面关过重载过都还在）
＋ 宿主工具事件（**加速**，只覆盖订阅之后新起的提问）。

板面还能**弹成置顶的桌面窗口**（页头「放到桌面」），一直挂在屏幕上；
对话面板新增**语音输入**：麦克风 → 宿主本地识别 → 文字落进输入框，**不自动发送**。

## 数据从哪来

**运行时就是唯一数据源**，这个插件不自建状态库：

| 数据 | 来源 |
| --- | --- |
| 项目清单 / 团队层级 | `~/.minimax/v2/sqlite/runtime-state.sqlite`（只读，`node:sqlite`） |
| Goal 模式进度 | 同上 `local_runtime_thread_goals` |
| 待你回答的问题 | 同上 `questionnaire_requests` |
| 正在跑的后台任务 | 同上 `local_runtime_background_tasks` |
| 能力库 | `~/.agents/skills`、`~/.minimax/skills`、`~/.minimax/.builtin-skills` |
| 插件自己的状态 | Mini App 的 `dataDir`：`dispatches.json` / `acks.json` / `boss-session.json` 等 |
| 会话实况 | 宿主桥接 `agent.sessions()` / `agent.session()` / `agent.observe()`（需 `agentAccess: ["session.read"]`） |
| 语音识别 | 宿主本地识别 `window.mcode.miniapp.speech.transcribe`（需 `deviceAccess: ["microphone"]`） |

**只读**运行时库；写入只发生在插件自己的 `dataDir` 里。

> **权限**：`session.read` 和 `microphone` 两项都在插件详情里逐项开关，**默认都是开的**，
> 没有首次使用弹窗。关掉之后板面会如实显示「未授权」，而不是假装没有会话。

## 大哥自己怎么读会话

板面那一页读的是宿主的桥接（页面够得着、agent 够不着）；**大哥作为 agent 读的是运行时库**——
两边同一口径，所以他在汇报里写的会话状态，你在板面上能对上。

```
node "miniapps/mimic-tear/miniapp/node/session-cli.mjs" list      # 会话表：谁在跑、谁在等回答
node "miniapps/mimic-tear/miniapp/node/session-cli.mjs" waiting   # 只列在等回答的
node "miniapps/mimic-tear/miniapp/node/session-cli.mjs" show <会话id>  # 单个会话 + 最后一段回复
```

输出是一张表：**状态 / 等回答 / 更新时间 / 会话 id / agent / 项目 / 标题**，表头带总数。
口径与宿主给用户看的那份一致：只列**根对话**（可见、非子会话、非定时任务、非 Mini App 自己的会话）。

---

## 安装（另一台电脑）

### 方式 A：从 Git 仓库导入（最省事）

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

> 注意：`.minimax-plugin` 是隐藏目录，复制时别漏。目录名必须是 `mimic-tear`（要和 `plugin.json` 里的 `name` 一致）。

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

```bash
# 跑全部测试（node:test，无第三方依赖；条数以 node --test 的输出为准）
node --test

# 把插件发布到本机 MiniMax Code（安装目录 ~/.minimax/plugins/mimic-tear）
node miniapps/mimic-tear/miniapp/node/server.mjs   # 或用 Agent 的 /miniapp-creator
```

> **2026-10-28 补记**：用例数由 386 订正为 **411**（`node --test` 的 TAP 输出：`tests 411 / pass 411 / fail 0`，2026-10-28 复测）。386 是旧数字，已过期。
>
> **2026-10-28 再补记**：上面这个 411 又过期了——本轮补的守卫与契约测试把它推到了 **525**。
> 写死条数只会一次次过期，所以上面那行改成「以 `node --test` 的输出为准」：条数是**产物**，
> 不是**常量**。要一个准确的数字，跑一次 `node --test` 看最后那几行。

仓库结构：

```plaintext
miniapps/mimic-tear/          插件本体
  .minimax-plugin/plugin.json  插件清单（提交市场时的入口）
  icon.png                    插件图标
  skills/                     随插件分发的 Skill
  miniapp/
    miniapp.json              Mini App 声明（页面、Node 运行时、Agent 权限）
    client/                   前端（无构建步骤，原生 HTML/CSS/JS）
    node/                     Node 运行时（REST + SSE + 领域服务）
docs/specs/                  设计规格
docs/plans/                  实施计划与踩坑记录
tests/                       测试
```

**改完记得发布**：源码目录和运行目录不会自动同步，`~/.minimax/plugins/mimic-tear` 里跑的那份要自己同步过去，否则改的是源码、跑的是旧代码。

## 贡献

`main` 分支受保护：改动走 PR，CI 必须绿，禁止强推和删除分支。合并请用 **Squash and merge**（分支保护启用了线性历史）。

```bash
git checkout -b feature/xxx
# ...改动...
node --test                       # 本地先跑绿
git push -u origin feature/xxx
# 开 PR，等 CI 变绿后合入
```

## 上架插件市场

插件已按 MiniMax Plugin 规范打包（`.minimax-plugin/plugin.json` + 至少一种能力 + 合法图标与分类）。提交入口是[官方投稿表单](https://vrfi1sk8a0.feishu.cn/share/base/form/shrcnbnpeor3z72fUkeHzrOE7vb)，选 GitHub 来源时填：

| 表单字段 | 值 |
| --- | --- |
| 仓库地址 | `https://github.com/HanMaXiao/mimic-tear` |
| Ref | `main`（或某个 tag） |
| Plugin 子目录 | `miniapps/mimic-tear` |
| 目标区域 | CN（首次上 US 需另开一份「新插件」提交） |
| 启用端 | 桌面端 |

## 许可证

[MIT](LICENSE)。代码、文案、图标均为本项目所有。
