# AGENTS.md

仿身泪滴（Mimic Tear）是跑在 [MiniMax Code](https://code.minimax.cn) 桌面端里的 **Mini App**：把散在各会话里的项目进度、待决策问题和团队层级汇到一块看板上，并把指令直接投递给对应项目的负责人会话。

这个仓库**就是那个插件**。没有第二个仓库，没有构建步骤——`miniapps/mimic-tear/` 里的源码就是发布物。

## 先读哪里

| 你要做什么 | 先读 |
| --- | --- |
| 了解产品 | [`README.md`](README.md) |
| 改运行时 / 板面 | 规格 [`docs/specs/2026-10-20-mimic-tear-design.md`](docs/specs/2026-10-20-mimic-tear-design.md) §3（架构与写路径）、§5（API 与 SSE） |
| 动接口契约 | [`mimic-tear-api-seam`](.agents/skills/mimic-tear-api-seam/SKILL.md) |
| 评审别人的改动 | [`mimic-tear-code-review`](.agents/skills/mimic-tear-code-review/SKILL.md) |
| 提交 / 推送 | [`mimic-tear-pre-push-checks`](.agents/skills/mimic-tear-pre-push-checks/SKILL.md) |
| 想知道某决策为什么这么定 | [`.agents/notes/`](.agents/notes/README.md) |

## 仓库结构

```plaintext
miniapps/mimic-tear/          插件本体
  .minimax-plugin/plugin.json  插件清单（提交市场时的入口）
  miniapp/miniapp.json        Mini App 声明（页面、Node 运行时、Agent 权限）
  miniapp/client/             前端（无构建步骤，原生 HTML/CSS/JS）
  miniapp/node/               Node 运行时（REST + SSE + 领域服务）
  skills/                     随插件分发 / 项目自用的技能
scripts/                      零依赖守卫脚本
tests/                        node:test 用例
docs/specs/                   设计规格
docs/plans/                   实施计划与踩坑记录
.agents/notes/                决策记录（Agent Note）
.agents/skills/               仓库开发流程的技能
```

## 硬约束

这几条是**不可协商**的，违反就是缺陷，不是风格问题。

- **零第三方依赖。** 包内不得出现 `node_modules`、lockfile、`package.json` 里不得声明 `dependencies`，import 说明符只有 `node:` 内置模块与相对路径。**Mini App 的运行时是裸 Node，没有安装步骤**——包里出现一个第三方 import，宿主加载时直接炸，而且是在用户装上之后才炸。`scripts/check-package.mjs` 把这条守成断言。
- **运行时库只读。** `~/.minimax/v2/sqlite/runtime-state.sqlite` **任何代码路径都不许以写模式打开**。插件**不自建状态库**——运行时是唯一数据源，插件自己的状态只写在 `context.dataDir` 里。
- **单一写路径。** 所有写操作走同一条链：`HTTP / MCP / 后台 → 校验 → ProjectService → 持久化提交 → SSE 广播`。**先提交再广播；广播失败不回滚。** 路由里不许直接写文件。
- **无构建步骤。** 客户端是原生 HTML/CSS/JS（原生 ES 模块 + SSE），没有打包器、没有 transpile。改完就是最终形态。
- **运行时不用 `console.log` / `console.error`**，走 `context.logger` 的结构化日志。
- **客户端不出现 emoji**；发布源码里不留 `TODO` / `FIXME`。
- **全部 LF。** `.gitattributes` 里 `* text=auto eol=lf`，别写出 CRLF。
- **Windows-only 假设是真的。** 看门狗是 Windows 计划任务，启动器是 VBScript，CI 因此跑在 `windows-latest`。

## 命令

```sh
node --test                        # 全部测试（node:test，无第三方依赖）
node scripts/check-published.mjs   # 发布漂移守卫：发布副本 vs 仓库
node scripts/check-package.mjs     # 打包守卫：零依赖、无本机路径泄漏
node scripts/check-style.mjs       # 风格守卫：console / TODO / emoji
node scripts/verify-agent-notes.mjs # 决策记录守卫：.agents/notes 的结构与格式
node scripts/install-hooks.mjs     # 装本机 pre-commit 钩子（可选，默认不装）
```

CI 就是 `node --test` + 上面四个守卫，全部零第三方依赖、只用 Node 标准库。

**条数是产物，不是常量。** 要准确的测试条数就跑一次 `node --test` 看最后几行——不要在文档里写死。

**`node --test` 不是零副作用**：它会创建/删除/恢复 Windows 计划任务 `MimicTear-DutyWatchdog`。这是必要的（那个任务必须被真的动过才算验收到），但要知道它在做什么。

给 agent 用的两个 CLI：

```sh
node "miniapps/mimic-tear/miniapp/node/session-cli.mjs" list|waiting|show <会话id>
node "miniapps/mimic-tear/miniapp/node/patrol-cli.mjs" facts|report <file>|paths
```

## 提交纪律

**这个仓库里不许用会扫全树的提交方式**：`git add -A` / `git add .` / `git commit -a` 都是错的——仓库里可能同时有**另一个 agent 的在制品**，全树扫会把人家的半成品卷进同一个 commit。

只允许两种形式：

```sh
git commit -F <msg> -- <path1> <path2> ...      # 路径限定
# 共享文件：git diff --output=<patch> -- <shared> → git apply --cached <patch> → 提交
```

动手前先 `git status --short`——**一个你说不清来路的改动，就不是你的**。完整纪律见 [`docs/plans/2026-10-22-line-ownership.md`](docs/plans/2026-10-22-line-ownership.md) §3。

## 改完记得同步发布副本

**源码目录和运行目录不会自动同步。** `~/.minimax/plugins/mimic-tear/` 里跑的那份要自己同步过去，否则**改的是源码、跑的是旧代码**。

`scripts/check-published.mjs` 逐字节比对两边并列出双向差集。验收走 `mimic-tear-release-verification` 技能（**四层**：代码在 / 测试过 / 生产路径跑起来是什么样 / 新代码真的跑起来过吗）——「发布成功」只证明文件落盘了，不证明新代码执行过。

## 文档与决策记录

| 位置 | 管什么 |
| --- | --- |
| `docs/specs/` | **产品是什么**：架构、API、数据模型、验收标准 |
| `docs/plans/` | **一次执行发生了什么**：分批计划、踩坑、当时拍板（写完即冻结） |
| `.agents/notes/` | **一个决策为什么这么定**：取舍、代价、边界、什么条件下要重新考虑 |

规格已经写死的约束**不要**在 note 里复述。note 记的是规格讲不清楚的那一层。写法见 [`.agents/notes/README.md`](.agents/notes/README.md)，动手时用 [`mimic-tear-agent-note`](.agents/skills/mimic-tear-agent-note/SKILL.md)。

## 你可能是被「直通投递」叫起来的平行会话

2026-11-01 起，仿身泪滴的直通会把某条线的事件**直接投进这个 Mini App 自己建出来的负责会话**（不经过大哥）。那个会话的工作目录是 plugin 目录（`agents/<agent>/miniapps/mimic-tear`），**不是项目目录**——消息里会带项目的绝对路径，第一跳要自己 `cd`。

同一条线于是可能有两个能干活的人（桌面端会话 + 直通会话）。**当同事，不要当对手**：

- 先看 `git status` 与 `git log`：**有人正在改这个仓库就只报告、不动手**。改动撞车比不改动更糟。
- 只做被指派的那件事，不顺手巡检、不顺手扩范围。
- 改动一律走分支 + PR（`main` 上不直接推，合并由大老板做）。**别替大老板合并。**
- 你的产出留在**这个会话和板面**里——它不会回到大老板当前那个窗口；需要他拍板的事，写进板面结论。

## 不要做的事

- 不要加依赖、不要加构建步骤、不要引入 `package.json`。
- 不要以写模式打开运行时库，不要绕过 `ProjectService` 写文件。
- 不要在运行时用 `console.*`，不要在客户端放 emoji，不要留 `TODO`/`FIXME`。
- 不要用全树式的 `git add`。
- 不要**手抄**路由表或 SSE 事件表——它们是声明式的单一来源。
- 不要把「看起来对」当成通过：**哪里有证据，哪里写**；没查到的写没查到；未通过项如实报告为未验证。
- 不要在 `main` 上直接推。改动走 PR，CI 绿了才合，用 **Squash and merge**。
