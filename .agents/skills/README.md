# `.agents/skills/` —— 仓库开发流程的技能

这里的技能服务于**「在这个仓库里改代码」**这件事：某类活的流程、清单、判定口径。

## 与插件技能的区别

| | `.agents/skills/` | `miniapps/mimic-tear/skills/` |
| --- | --- | --- |
| 面向谁 | 改这个仓库的 agent | 插件的使用者，或插件自己的运维流程 |
| 会不会发出去 | **不会** | `plugin.json` 的 `skills` 数组里列出的会 |
| 放什么 | 仓库开发流程 | 板面操作、发布与监控链路验收 |

插件那边已经有三个项目自用的验证技能——`mimic-tear-release-verification`、`mimic-tear-scheduled-task-launch-check`、`mimic-tear-watchdog-heartbeat-verify`。**这里不重复实现它们**，需要时直接引用。

## 现有的四个

| 技能 | 干什么 |
| --- | --- |
| [`mimic-tear-agent-note`](mimic-tear-agent-note/SKILL.md) | 写一条 Agent Note，或者在生命周期之间挪它 |
| [`mimic-tear-api-seam`](mimic-tear-api-seam/SKILL.md) | 动 API 路由、SSE 事件或客户端接口时，三处对齐的清单 |
| [`mimic-tear-code-review`](mimic-tear-code-review/SKILL.md) | 评审这个仓库的一次改动 |
| [`mimic-tear-pre-push-checks`](mimic-tear-pre-push-checks/SKILL.md) | 推送前该跑哪些检查、以及提交纪律 |

## 写法

跟插件技能同一个形态：YAML frontmatter（`name` + `description`），然后是分节正文。

`description` 用 `Use this skill when … / Trigger phrases: … / Do NOT use it to …` 三段式——**触发条件写清楚，比写得多漂亮有用**。正文用中文，技术词和标识符保持英文。

**先改仓库里的这份。** 本机安装目录（`~/.minimax/skills/`）是运行时副本，两处不一致时以仓库为准。
