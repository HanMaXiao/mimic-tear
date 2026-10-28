# 优化建议清单（2026-10-28）

这份文件记录 **2026-10-28 这一轮工作是从哪份建议清单来的**：推荐了什么、每条依据是什么、哪些已经做掉了、哪些还欠着。

- 第 1–9 条**照录**推荐当时的原话，含优先级与依赖关系，不做增删。
- 每条下面另起一行 **验收方式**，是本轮清账时补的可执行口径——推荐原文里的「验收」说的是**要达成什么**，这里说的是**怎么核**。
- 相关文档：设计规格 `docs/specs/2026-10-20-mimic-tear-design.md`、实施计划 `docs/plans/2026-10-20-mimic-tear.md`。

---

## 0. 这份清单的依据

推荐不是凭感觉提的，每一条都对着仓库的现状。下面是本轮清账时重新核过一遍的事实（核对方式写在右列）：

| 事实 | 值 | 怎么核的 |
| --- | --- | --- |
| 服务端 API 路由 | **21 条**（另有 2 条静态资源分支） | 逐条读 `miniapps/mimic-tear/miniapp/node/server.mjs` 的 `handler`（第 105–404 行）的路由分支 |
| SSE 事件 | **12 类** | 同上，读 `broadcast()` 的全部调用点（含 `broadcastChatEvent` 的 switch） |
| 测试条数 | **411 项全绿** | `node --test` 的 TAP 输出：`tests 411 / pass 411 / fail 0`（2026-10-28 复测） |
| 测试文件数 | **38 个** | `tests/` 下 37 个 `*.test.mjs` + `tests/helpers/fixture.mjs` |
| 客户端单文件规模 | app.js **1927** 行 / styles.css **2765** 行 | 2026-10-28 实测 |
| 领域层单文件规模 | view-model.mjs **860** 行 / project-service.mjs **855** 行 | 2026-10-28 实测 |
| 客户端实际调用的端点 | 见 `client/assets/app.js` 的 `API` 常量表 | 该常量表**没有** `/api/watchdog/alerts` 与 `/api/dispatch/:id`——这两条服务端有、客户端没调 |

> 第 8、9 条正文里写的行数是**推荐当时**的口径；它们下面的「验收方式」给的是 **2026-10-28 的实测基线**，两者差 1 行（文件末尾换行的计数口径不同），不是矛盾。

---

## 1. P1 · Node 运行时边界层：路由表外置 + 安全响应头 + 轮询降频

把 server.mjs 里 300 行 if-chain 路由抽成声明式路由表 node/api-routes.mjs；新增 node/security.mjs 统一产出安全响应头（CSP、X-Content-Type-Options、Referrer-Policy、frame-ancestors）；把 3 秒轮询里的 getChatMessageCount() 与 revision() 短路降频。

**验收方式**：`node --test` 全绿（2026-10-28 基线 411 项 / pass 411 / fail 0）；重构前后对同一组请求打全部 21 条路由，响应体与 SSE 广播行为逐条比对不变；响应头里能读到 CSP、X-Content-Type-Options、Referrer-Policy、frame-ancestors，且 `GET /api/stream` 的 SSE 流不被这些头打断；轮询降频后 `chat.history` 事件仍能在宿主侧栏说话后送达。

## 2. P1 · 板面补齐看门狗告警与派工状态恢复

GET /api/watchdog/alerts 与 GET /api/dispatch/:id 服务端早已存在、客户端从未调用；新增告警面板与刷新后的派工状态恢复。

**验收方式**：客户端 `API` 常量表里出现 `/api/watchdog/alerts` 与 `/api/dispatch/:id`（现在两条都没有）；告警面板四态（加载 / 空 / 错误 / 工作中）各有一条断言；`tests/client-contract.test.mjs` 新增断言把这两条端点钉住，防止再漂移。

## 3. P1 · 结论来源字段与值班派工入账

收件箱结论加 source: 'duty' | 'board'；值班路径的派工也进 dispatches.json。

**验收方式**：收件箱条目带上 `source` 字段，旧记录读出来默认是 `'board'`；值班路径产生的派工出现在 `dispatches.json` 里；看板路径的幂等语义不变——同一 `idempotencyKey` 重复提交仍返回 `duplicate: true` 且不重复投递。

## 4. P2 · 规格与文档债清账

§5 API 表、§14 悬空引用、§3.2 页面口径、§12 待确认、测试计数与路径漂移、计划 checkbox 全 stale。

**验收方式**：逐条对着仓库核——`server.mjs` 的路由分支数 = 21；`broadcast()` 调用点覆盖 12 类事件；`node --test` 的 TAP 首行 `tests 411`；`tests/` 下 37 个 `*.test.mjs` + `tests/helpers/fixture.mjs` = 38 个文件；`client/assets/app.js` 与 `client/assets/styles.css` 两个路径真实存在；计划文档 Task 1–11 的 checkbox 全为 `- [x]` 且每条都带一句指明 commit 的补记。

## 5. P1 · Agent Harness：插件 Skill 契约同步与项目验证技能入库

插件 Skill 的 SSE 事件表缺 chat.* 七类事件、端点表缺 /api/skill-library 等；补「paused ≠ 在等决策」硬规则；把本机 ~/.minimax/skills 下三个项目验证技能收进仓库。

**验收方式**：拿插件 Skill（`miniapps/mimic-tear/skills/mimic-tear-board/SKILL.md`）里写的每一个端点与每一个事件名，逐个在 `server.mjs` 里 grep，命中才算通过。已核出的两处具体漂移：① 端点表**没有** `/api/skill-library`；② SSE 那一行只写了 `snapshot` / `update` / `dispatch` / `patrol` / `permission`，**缺 7 类**——`chat.delta` / `chat.message` / `chat.tool` / `chat.question` / `chat.done` / `chat.history` / `duty`。

## 6. P1 · 项目 Harness：发布漂移守卫、打包守卫与 CI 增强

发布副本 ~/.minimax/plugins/mimic-tear 与仓库的逐字节比对（现只在被 gitignore 的 Saved/preview/check-published.cjs）、无 node_modules/无第三方依赖的打包守卫、零依赖风格守卫、CI 增加这些步骤、提交纪律守卫（禁止 git add -A）。

**验收方式**：守卫脚本自身带测试（`node --test` 能跑）；`.github/workflows/ci.yml` 里能看到新增的这几步（现在只有一个 `node --test`）；打包守卫在包里出现 `node_modules` 或第三方依赖时红；提交纪律守卫在提交命令里出现 `git add -A` 时红。依据：逐字节比对脚本确实只在被 gitignore 的 `Saved/` 下，仓库里看不见——`.gitignore` 里那一行是 `Saved/`。

## 7. P2 · 测试策略：跨层 API 契约测试与共享夹具单点化

路由表 ↔ 客户端端点表 ↔ 规格 §5 三方对账；cron 表 DDL 从 duty-evidence.test.mjs 收敛到共享夹具。

**验收方式**：一条测试同时读三份清单——`server.mjs` 的路由分支、`client/assets/app.js` 的 `API` 常量表、规格 §5 的表格——三者端点集合相等才绿；`local_runtime_v2_cron_runs` 的建表 DDL 在 `tests/` 下只出现一次（现在只在 `tests/duty-evidence.test.mjs` 第 31 / 69 行，共享夹具 `tests/helpers/fixture.mjs` 里没有）；漂移能在 CI 被拦下。

## 8. P2 · 客户端模块化拆分：app.js 与 styles.css 按视图拆分

app.js 1926 行、styles.css 2764 行，按视图边界拆成原生 ES 模块与多个样式表（不用 @import）。

**验收方式**：`tests/client-contract.test.mjs` 与 `tests/client-behavior.test.mjs` 全绿；拆分后 `index.html` 仍用 `<script type="module" src="/assets/app.js">` 加载（现在是这一行），样式表里不出现 `@import`；拆分前基线（2026-10-28 实测）：**app.js 1927 行 / styles.css 2765 行**。

## 9. P2 · Node 领域层拆分：view-model 与 project-service 按职责拆分

859 行 / 853 行两个领域大文件按职责拆分，导出签名保持不变，重复判定的规则收敛到同一个纯函数。

**验收方式**：既有测试全绿（2026-10-28 基线 411 项）；`view-model.mjs` 与 `project-service.mjs` 的对外导出名与参数列表逐个未变；重复判定的那条规则收敛到同一个纯函数，并有测试直接覆盖它。拆分前基线（2026-10-28 实测）：**view-model.mjs 860 行 / project-service.mjs 855 行**。

---

## 依赖关系

用于排序与并行冲突规避：

| 项 | 依赖 |
| --- | --- |
| 第 5 项 | 第 1 项、第 4 项 |
| 第 7 项 | 第 1 项、第 2 项、第 4 项 |
| 第 8 项 | 第 2 项 |
| 第 9 项 | 第 3 项 |
| 其余 | 无依赖 |

## 本轮状态（2026-10-28）

| # | 优先级 | 状态 |
| --- | --- | --- |
| 1 | P1 | 本轮并行推进中 |
| 2 | P1 | 本轮并行推进中 |
| 3 | P1 | 本轮并行推进中 |
| 4 | P2 | **本轮已完成**（规格 §5 / §3.2 / §12 / §14、两份 README、三份计划文档的计数与路径漂移、计划 Task 1–11 的 checkbox） |
| 5 | P1 | 未开始（依赖第 1、4 项——第 4 项已闭合） |
| 6 | P1 | 未开始 |
| 7 | P2 | 未开始（依赖第 1、2、4 项） |
| 8 | P2 | 未开始（依赖第 2 项） |
| 9 | P2 | 未开始（依赖第 3 项） |

> 状态列是 2026-10-28 的快照，随推进更新。
