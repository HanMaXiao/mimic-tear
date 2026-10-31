# `.agents/` —— 本仓库的 Agent 工作台

这个目录是给 agent 看的**工作台**：一类是写下来的决策记录，一类是干活时照着走的技能说明。

```
.agents/
  notes/    决策记录（Agent Note）——为什么这么定，放弃了什么
  skills/   技能说明（SKILL.md）——某类活的流程、清单、判定口径
```

配套的入口是仓库根的 [`AGENTS.md`](../AGENTS.md)：那是每次开工都该先读的常驻约定。

## 与 `docs/` 的分工

三者各管一段，写之前先判断该落哪儿：

| 位置 | 管什么 | 什么时候更新 |
| --- | --- | --- |
| `docs/specs/` | **产品是什么**：架构、API、数据模型、验收标准 | 设计变了就改，改的是「有什么」 |
| `docs/plans/` | **一次执行发生了什么**：分批计划、踩坑、当时拍板 | 写完就冻结，是历史记录 |
| `.agents/notes/` | **一个决策为什么这么定**：取舍、代价、边界、什么条件下要重新考虑 | 决策落地后随代码同步更新 |

判据是「**事实**还是**理由**」：

- 「板面有 6 个视图、21 条 API 路由、12 种 SSE 事件」→ 事实，写进 `docs/specs/`。
- 「为什么运行时库只读、不许写」→ 理由，代码和规格都讲不清的那部分，写进 `.agents/notes/`。

`docs/specs/` 已经讲清楚的事，不要在 notes 里重写一遍。notes 记的是**规格没写、代码里也看不出来**的那一层。

## 与 `miniapps/mimic-tear/skills/` 的分工

那 4 个技能是**插件的一部分**：它们跟随插件发布，或者是为插件的运维流程服务的，随仓库版本控制、但不发给用户。

`.agents/skills/` 是**仓库开发流程的技能**：它们只服务于「在这个仓库里改代码」这件事，不进发布包、不进 `plugin.json` 的 `skills` 数组。

现有的三个项目自用技能——`mimic-tear-release-verification`、`mimic-tear-scheduled-task-launch-check`、`mimic-tear-watchdog-heartbeat-verify`——已经在做发布与运维链路的验收，`.agents/skills/` **不重复实现**，只在需要时引用它们。

## 硬约束

- **零第三方依赖**：`.agents/` 里的任何脚本只准用 Node 内置模块。这个仓库的 Mini App 运行时是裸 Node，没有安装步骤，装个依赖就等于装不上。
- **全部 LF**：`.gitattributes` 里 `* text=auto eol=lf`，新文件按 LF 写，别在 Windows 上手欠写出 CRLF。
- **禁 emoji、禁 `TODO`/`FIXME`**：`scripts/check-style.mjs` 会扫包目录里的 `.md`；`.agents/` 在包目录之外，但同一套规矩对这里也成立。
- **提交必须路径限定**：`git add -A` 在这个仓库里是错的，理由见 [`docs/plans/2026-10-22-line-ownership.md`](../docs/plans/2026-10-22-line-ownership.md) §3。

## 门禁

```sh
node scripts/verify-agent-notes.mjs
```

它守住 notes 树的结构与格式：生命周期与分类是封闭集合，文件名带日期，每份 note 的抬头与必备小节固定。CI 里已经接上，非零退出即标红。
