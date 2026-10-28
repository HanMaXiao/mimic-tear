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

看板的 HTTP API 跑在宿主分配的回环端口上（页面和 Agent 都能访问）。**宿主的鉴权在端口前面，直连一律 401**——读不到就说读不到，不要改口说「看起来正常」。

路由表的权威来源是服务端 `miniapp/node/api-routes.mjs` 里的 `API_ROUTES`，共 **21 条**。下面逐条对得上它（方法、路径、返回都是真的）：

| 方法 | 路径 | 返回 |
| --- | --- | --- |
| GET | `/api/stream` | SSE 长连接；连上先推一条 `snapshot` |
| GET | `/api/overview` | KPI + 项目卡数组 + 需关注项 + 值班状态（`duty` 里带最近 3 条看门狗告警） |
| GET | `/api/projects` | 项目卡列表 |
| GET | `/api/projects/:id` | 项目详情：组织树、goals、questions、tasks、plan |
| GET | `/api/inbox` | 决策收件箱条目（运行时问题 + 巡检结论） |
| GET | `/api/skills` | 能力库：本机已装技能的扫描结果，按领域分组 |
| GET | `/api/skill-library` | 大哥封装的可复用技能库：`entries` / `stats` / `domains` / `dispatchable` / `stale` / `retired` / `updatedAt` |
| GET | `/api/dispatch/:id` | 单条派工记录（刷新后恢复在途派工的结果靠它）；查不到 404 |
| GET | `/api/patrol` | 巡检配置与历史结论：`{ config, findings }` |
| GET | `/api/watchdog/alerts?limit=N` | 看门狗告警流水：`{ alerts }`，`limit` 默认 20 |
| GET | `/api/chat/duty` | 值班交班记录：`{ rounds }`（按轮次分组） |
| GET | `/api/chat/history` | 对话记录：`{ messages }` |
| GET | `/api/chat/session` | 大哥会话 id：`{ bossSessionId, agent }` |
| POST | `/api/dispatch` | 派工；返回 202 `{ dispatchId, status: 'queued' }` |
| POST | `/api/inbox/ack` | 确认一条收件箱条目，body `{ id }` |
| POST | `/api/patrol/config` | 巡检开关与间隔，body `{ enabled, intervalMinutes }` |
| POST | `/api/patrol/run` | 立刻跑一次巡检；返回 202 `{ status: 'started' }`，结果走 SSE |
| POST | `/api/duty/intent` | 值班意向，body `{ mode: 'on-duty' \| 'resting', requestedBy, note }` |
| POST | `/api/chat` | 给大哥发一句话，body `{ text }`；返回 202 `{ status: 'started', bossSessionId }` |
| POST | `/api/chat/answer` | 回答大哥的问卷，body `{ requestId, answers }`；返回 202 `{ status: 'started' }` |
| POST | `/api/permissions/:requestId` | 交还工具权限决定，body `{ decision: 'allowOnce' \| 'deny' }` |

另外三条静态路由：`GET /`（单页应用入口）、`GET /index.html`、`GET /assets/:file`。

错误口径：未命中路由 404 `{ error: 'not_found' }`；参数不对 400 `{ error: 'invalid_project_id' | 'empty_message' | 'missing_request_id' }`；处理异常 500 `{ error: 'internal_error', message }`。

底层数据同源：运行时状态库 `~/.minimax/v2/sqlite/runtime-state.sqlite`（`node:sqlite`，**只读**打开）。看板读不到时，可以直接查这张库，但结论要说明是从库里读的。

## SSE 事件

`GET /api/stream` 是一条 SSE 长连接。服务端一共广播 **12 类事件**（`api-routes.mjs` 的 `broadcast:` 声明 + `server.mjs` 的 `broadcast()` 调用点）：

| 事件 | 载荷字段 | 什么时候来 |
| --- | --- | --- |
| `snapshot` | 概览快照（见下） | 连上 `/api/stream` 时立刻推一条 |
| `update` | 概览快照（见下） | 运行时版本号变了；值班意向写入后；巡检结束后；一轮对话结束后 |
| `dispatch` | `dispatchId`、`status`、`delivered`、`text`、`error` | `POST /api/dispatch` 的后台投递出结果时 |
| `patrol` | `runAt`、`conclusion`、`dispatches`、`proposals`、`executed`、`findings`、`error`；失败时是 `{ error, findings: [] }` | 巡检跑完（板面循环或 `POST /api/patrol/run`） |
| `permission` | `requestId`、`sessionId`、`toolName`、`reason` | 大哥发起工具权限请求 |
| `chat.delta` | `text` | 一轮对话的流式增量 |
| `chat.message` | `text` | 一条消息定稿 |
| `chat.tool` | `name`、`phase`；`phase='finished'` 时多一个 `ok` | 工具调用开始 / 结束 |
| `chat.question` | `requestId`、`mode`、`request` | 大哥被问卷卡住 |
| `chat.done` | `status`、`text`、`error`、`request`；出错路径没有 `request` | 一轮对话结束 |
| `chat.history` | `messages` | 运行时消息数变了（宿主侧栏里说了话） |
| `duty` | `rounds` | 值班交班轮次有变化 |

概览快照（`snapshot` / `update` 的载荷）：`generatedAt`、`kpi`、`projects`、`attention`、`internalProjectCount`、`dataWarning`、`duty`。

三件容易搞错的事：

- `chat.message` 服务端会广播，页面当前**没有**订阅它；其余 11 类页面都订阅。
- `POST /api/chat/answer` 只推 `chat.*` 与 `chat.done`，**不推 `update`**；`POST /api/chat` 结束时才额外推一条 `update`。
- `patrol` 与 `update` 成对出现：先 `patrol`（这一轮的结论），后 `update`（刷新后的快照）。

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

同一个 `idempotencyKey` 重复提交返回 **200** `{ dispatchId, status, duplicate: true, delivered, text, error }`——**不重复投递**。页面刷新后可以用 `GET /api/dispatch/:id` 把在途派工的结果读回来。

不经过看板、就在会话里工作时，用 `mavis` 工具的 `session send` 把指令原样投递给目标会话，不要改写内容。

## 硬规则

1. **不要编状态。** 看板或库里读不到，就说读不到；不要用「看起来正常」代替一次真实读取。
2. **派工只负责送达。** 你不替目标会话干它该干的活，只确认「投给了谁、结果如何」。
3. **确认与排除走接口。** 确认一条收件箱条目：`POST /api/inbox/ack`（body `{ id }`）；排除必须带理由，不许静默丢弃。
4. **值班状态是事实，不是判断。** 「值班中 / 可能掉线 / 尚未巡检」三种说法各自对应不同的事实，引用时不要混用。
5. **用户的原话优先。** 用户给的指令原样传递；你的判断另起一段写，别混进指令里。
6. **`paused` 不等于「在等决策」。** 收件箱里 `kind='goal-paused'` 的条目只说明「这条工作停住了」，它**不是**一条「等你拍板」。两件事混在一起，就会把一个已经停掉的 goal 报成待决策项，让用户去等一个根本不会来的答案。

   判定「在等决策」要查这两个字段：

   - **goal 的 `status`（连同原因 `status_reason`）**——看板里是 `goals[].status` / `goals[].statusReason`，运行时表是 `local_runtime_thread_goals.status` / `.status_reason`。`paused` 且 `status_reason` 是 `no_progress`，意思是自动续跑被 no_progress 检测停掉了。
   - **goal 的 `execution_wait_reason`**——运行时表 `local_runtime_thread_goals.execution_wait_reason`。**它为空就是没有在等谁拍板**；非空才是真的在等（比如在等一份待答问卷）。

   看板的 `GOAL_SQL` 没有选 `execution_wait_reason` 这一列，所以 `/api/overview` 与 `/api/projects/:id` 都读不到它。此时要么直查运行时库，要么按收件箱条目的 `kind` 分流：`kind='questionnaire'` 才是「有人等你回答」，`kind='goal-paused'` 只是「工作停住了」。

   依据：`docs/plans/2026-10-22-mimic-tear-resume-plan.md`——`tg_z7054lfdtrmvg9gwab` 是 `paused(no_progress)`、`execution_wait_reason` 为空、无待答问卷，**不是在等谁拍板**。

## 权限与值守

- 值班状态：`POST /api/duty/intent`，body `{ mode: 'on-duty' | 'resting', requestedBy, note }` —— 谁要求的、为什么，要写清楚。
- 巡检：`POST /api/patrol/config`（开关与间隔）、`POST /api/patrol/run`（立刻跑一次，返回 202，结果走 SSE `patrol`）。
- 大哥发起的工具权限请求会经 SSE `permission` 推上来，决定走 `POST /api/permissions/:requestId`，body `{ decision: 'allowOnce' | 'deny' }`。没有明确授权时一律拒绝。
