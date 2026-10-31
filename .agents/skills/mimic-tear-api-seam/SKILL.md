---
name: mimic-tear-api-seam
description: |
  Use this skill when 要动 API 路由、SSE 事件、或者客户端调用的接口——
  规格 §5 的 API 表、服务端路由表、客户端端点表这三处必须同时对齐。
  Trigger phrases: 加一条 API / 改个路由 / 加个 SSE 事件 / 前端调不通 / 404 /
  接口对不上 / api-routes / 契约测试挂了 / 加个事件。
  Do NOT use it to 改纯前端的视觉或交互（那不碰契约），也不要用它做代码评审。
---

# 动接口时，三处对齐

这个仓库的接口契约**在三个地方各有一份**，而且是**机器核对**的：`tests/api-contract.test.mjs` 做三方对账。

```
docs/specs/2026-10-20-mimic-tear-design.md §5   ← 人读的权威
miniapps/mimic-tear/miniapp/node/api-routes.mjs ← 服务端路由表（声明式）
miniapps/mimic-tear/miniapp/client/assets/     ← 客户端端点表
```

**只改一处，对账测试就红。** 这是好事——它把「三处口径不一致」从人工检查变成了 CI 红灯。

## 改动前先分清是哪一类

| 改什么 | 要动的地方 |
| --- | --- |
| **加一条 API 路由** | `api-routes.mjs` 的路由表 + 规格 §5 的 API 表 + 客户端（如果前端要用） |
| **加一个 SSE 事件** | 服务端 `broadcast()` 的调用点 + 规格 §5 的 SSE 事件表 + 客户端订阅端（`assets/runtime/stream.js` 一带） |
| **改一条已有路由的载荷形状** | 三处全改 + **所有调用方**（这是最容易漏的一类） |
| **只改前端显示** | 不碰契约 |

**载荷形状变了，所有调用方都要跟着改。** 「调用方」包括 `assets/views/` 下的视图、`assets/shared/api.js`，以及插件技能 `mimic-tear-board/SKILL.md` 里那张接口表——**那份表是发给用户的**，改了接口就要改它。

## 服务端这边

路由表是声明式的，在 `api-routes.mjs`。加一条路由要同时想清楚：

- **载荷形状**：字段名、类型、嵌套。
- **失败怎么返回**：错误响应的形状由 `domain-error.mjs` 和 `security.mjs` 统一定义，不要自己造。
- **写不写**：**所有写操作走同一条路径**——`HTTP → 校验 → ProjectService → 持久化提交 → SSE 广播`。先提交再广播，广播失败不回滚。路由里**不要直接写文件**。
- **只读还是写**：读运行时库的路由一律只读 `runtime-state.sqlite`。

**只有服务端有的路由**，要在 `api-contract.test.mjs` 的 `SERVER_ONLY_ENDPOINTS` 白名单里**显式登记**——没登记就红。这是有意的：白名单强制你承认「这条路由前端不用」。

## 客户端这边

客户端**没有构建步骤**，是原生 ES 模块。改端点表时注意：

- 客户端源码在 `assets/` 下按目录分（`views/`、`shared/`、`runtime/`、`assets/`）。
- 契约测试是**扫目录**拿文件清单的，不是写死文件名——所以**新增一个 `assets/` 下的文件会自动被纳入**，不用改测试。
- 但如果改的是「客户端只扫 `.js` 和 `.css`」这个约定本身，`scripts/check-style.mjs` 会同步红（它检查契约测试还在扫整个 `assets` 目录）。

## SSE 事件

服务端在 `broadcast()` 的调用点发事件，事件名在规格 §5 的表里。

**加事件要同时想清楚**：什么时候发、载荷是什么、客户端要不要它（不要就别加——事件是成本）。

## 改完过一遍

```sh
node --test tests/api-contract.test.mjs
node --test tests/security.test.mjs
node --test tests/client-contract.test.mjs
```

三条一起跑：契约测试管三方对账，安全测试管响应头和路由可达性，客户端契约测试管客户端自己的约定。

然后跑全套：

```sh
node --test
```

## 容易漏的地方

- **插件技能里的接口表**：`miniapps/mimic-tear/skills/mimic-tear-board/SKILL.md` 记着 21 条路由和 12 种 SSE 事件。改接口不改正文，用户手上的技能就是错的。
- **规格 §5 是「人读的权威」**。它同时被契约测试读——**改了规格要跑契约测试**，不然 CI 红给你看。
- **条数是产物不是常量**。文档里写「21 条路由」的地方，数字会过期。正确的说法是「以 `api-routes.mjs` 与 `tests/api-contract.test.mjs` 为准」。
