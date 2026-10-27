---
name: mimic-tear-board
description: 读取仿身泪滴看板的项目状态、待决策问题与大哥值班情况，判断哪些项目卡住、哪些问题在等用户回答，并把指令下发给对应项目的负责人会话。
---

# 仿身泪滴看板

这个 Skill 配合「仿身泪滴」Mini App 使用。看板是状态的唯一出口：所有结论都要能追到它读到的数据，不能凭印象。

## 什么时候用

- 用户问「我的项目现在什么状态」「谁卡住了」「有没有人在等我回答」→ 读状态，再回答。
- 用户说「把这条指令发给 X 项目的负责人」→ 走派工。
- 用户问「大哥在值班吗」「它多久没交班了」→ 读值班与告警。

## 读状态

看板的 HTTP API 跑在宿主分配的回环端口上（页面和 Agent 都能访问）：

| 方法 | 路径 | 返回 |
| --- | --- | --- |
| GET | `/api/overview` | KPI + 项目卡数组 + 需关注项 + 值班状态 |
| GET | `/api/projects` | 项目卡列表 |
| GET | `/api/projects/:id` | 项目详情：组织树、goals、questions、tasks、plan |
| GET | `/api/inbox` | 决策收件箱条目（运行时问题 + 巡检结论） |
| GET | `/api/skills` | 能力库，按领域分组 |
| GET | `/api/patrol` | 巡检配置与历史结论 |
| GET | `/api/watchdog/alerts?limit=N` | 看门狗告警流水 |
| GET | `/api/chat/duty` | 值班交班记录（按轮次分组） |
| GET | `/api/stream` | SSE：`snapshot` / `update` / `dispatch` / `patrol` / `permission` |

底层数据同源：运行时状态库 `~/.minimax/v2/sqlite/runtime-state.sqlite`（`node:sqlite`，**只读**打开）。看板读不到时，可以直接查这张库，但结论要说明是从库里读的。

## 派工

```
POST /api/dispatch
{
  "projectId": 30,                 // 必填
  "sessionId": "mvs_xxx",          // 可选；省略时由大哥自己挑该项目的负责人会话
  "instruction": "……",             // 必填，原样传递
  "idempotencyKey": "…"            // 必填，防止重复投递
}
```

返回 **202** `{ dispatchId, status: 'queued' }` —— 这是受理，不是完成。真实结果通过 SSE 的 `dispatch` 事件推送（`running` / `done` / `error`）。

不经过看板、就在会话里工作时，用 `mavis` 工具的 `session send` 把指令原样投递给目标会话，不要改写内容。

## 硬规则

1. **不要编状态。** 看板或库里读不到，就说读不到；不要用「看起来正常」代替一次真实读取。
2. **派工只负责送达。** 你不替目标会话干它该干的活，只确认「投给了谁、结果如何」。
3. **确认与排除走接口。** 确认一条收件箱条目：`POST /api/inbox/ack`（body `{ id }`）；排除必须带理由，不许静默丢弃。
4. **值班状态是事实，不是判断。** 「值班中 / 可能掉线 / 尚未巡检」三种说法各自对应不同的事实，引用时不要混用。
5. **用户的原话优先。** 用户给的指令原样传递；你的判断另起一段写，别混进指令里。

## 权限与值守

- 值班状态：`POST /api/duty/intent`，body `{ mode: 'on-duty' | 'resting', requestedBy, note }` —— 谁要求的、为什么，要写清楚。
- 巡检：`POST /api/patrol/config`（开关与间隔）、`POST /api/patrol/run`（立刻跑一次，返回 202，结果走 SSE `patrol`）。
- 大哥发起的工具权限请求会经 SSE `permission` 推上来，决定走 `POST /api/permissions/:requestId`，body `{ decision: 'allowOnce' | 'deny' }`。没有明确授权时一律拒绝。
