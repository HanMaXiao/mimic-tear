# 两条线的分工与提交边界（2026-10-22）

## 0. 为什么有这份

Mimic Tear 已划归大哥管辖。但仓库里现在**同时有两条线在动同一个工作树**：

| 线 | 会话 | 做什么 |
| --- | --- | --- |
| **UI/UX 线** | 本会话（mavis / mvs_f7241c…） | 看板客户端的视觉与交互重做 |
| **负责人线** | mvs_bf21987f「持续迭代大哥并让大哥接管管理」 | 运行时、大哥、管辖、派工、值班、看门狗 |

同一个工作树 + 同一批文件 + 两个 agent，归属不清就等于归属丢失。这份文件是给大哥
的判断依据：**要不要并线、按什么顺序并、哪些地方会撞车。**

---

## 1. 文件归属

| 文件 / 目录 | 归属 | 说明 |
| --- | --- | --- |
| `miniapps/mimic-tear/miniapp/client/index.html` | **UI/UX 线** | 看板结构 |
| `miniapps/mimic-tear/miniapp/client/assets/styles.css` | **UI/UX 线** | 视觉系统「值更台」 |
| `miniapps/mimic-tear/miniapp/client/assets/app.js` | **UI/UX 线** | 客户端逻辑 |
| `docs/specs/2026-10-20-mimic-tear-design.md` **§6 页面设计** | **UI/UX 线** | 其余章节归负责人线 |
| `miniapps/mimic-tear/miniapp/node/*.mjs` | **负责人线** | 运行时 / 看板服务 / 派工 / 值班 / 看门狗 / 管辖 |
| `miniapps/mimic-tear/miniapp/node/miniapp-api.ts` | **无人改** | Host 提供的样板声明文件，仓库里没有任何地方 import 它 |
| `tests/client-contract.test.mjs` | **UI/UX 线** | 客户端契约守门（变量集 / 圆角 / 无渐变 / 无 emoji / 远程资源…） |
| `tests/client-behavior.test.mjs` | **UI/UX 线** | 客户端行为守门（DOM shim 驱动） |
| `tests/` 其余全部 | **负责人线** | |
| `docs/plans/2026-10-22-line-ownership.md` | **UI/UX 线** | 本文件 |
| `docs/specs/` 其余章节、`docs/plans/2026-10-20-mimic-tear.md` | **负责人线** | |

**同一文件里再切一刀的只有 spec 那一个**：按章节切，不按文件切。

---

## 2. 三处真正的接缝

### 接缝 A —— API 载荷形状：`node/view-model.mjs`

我的客户端渲染的是 `/api/overview`、`/api/inbox`、`/api/projects/:id`、`/api/skills`
的 JSON，这些 JSON 的形状由 `view-model.mjs` 决定（`buildProjectCards` / `buildInbox`
/ `buildKpi` / `buildDutyStatus` / `buildOrgTree`）。

**它归负责人线改，我归 UI/UX 线消费。** 改动分两类：

- **加字段 = 安全**：负责人线可以单独发布，我的客户端忽略未知字段即可。
- **改字段名 / 改类型 / 删字段 = 破坏性**：必须「node 先落 → client 后跟 → 一次发布带上
  两边」。否则看板要么白屏，要么静默显示错值（后者更糟）。

**当前事实（2026-10-22 02:5x 实测）**：负责人线正在改 `view-model.mjs`，把 `expired`
状态的问卷从 `pendingQuestions` 里剔出去——修的是「一张过期测试卡把 Mimic Tear 钉在
`blocked`」这个已知问题。**字段名与形状没有变**，我的客户端兼容，**不需要跟改**。

### 接缝 B —— 同一个 spec 文件

两条线都往 `docs/specs/2026-10-20-mimic-tear-design.md` 写。归属按章节切（见 §1），
但**提交时仍要按路径 + 补丁切**，因为路径限定只能解决「文件级」，解决不了「同一文件
里两个人的 hunk」。

### 接缝 C —— 发布单元

整个插件 `miniapps/mimic-tear` 是**一个包、一次发布**：客户端（`miniapp/client`）和
运行时（`miniapp/node`）是同一个 package 的两个 artifact。

所以「先发谁」不是一个独立决策：

- **形状不变的功能性改动**（我这次改的纯 UI）→ 可以单独发，客户端不依赖运行时的新字段。
- **破坏性形状改动** → 两条线必须合流发一次，否则发布出去就是坏的。

---

## 3. 提交纪律（这条是硬的）

**这个仓库里不许用会扫全树的提交方式。** `git add -A` / `git add .` / `git commit -a`
在这里是错的：它会把对方的**在制品**（写到一半的改动）一起卷进同一个 commit。

只允许两种姿势：

**① 路径限定**——只提交自己那几个文件：

```
git commit -F <msg> -- <path1> <path2> ...
```

**② 补丁快照**——共享文件（spec）用这个，它能保证提交进 index 的字节只有自己的：

```
git diff --output=<patch> -- <共享文件>      # git 自己写文件，绕开换行/编码
# 校验补丁只有自己的 hunk：hunk 数 + 关键词
git apply --cached <patch>                    # 只进 index，不碰工作区
git diff --cached                             # 提交前复核：只有自己的 hunk
git commit -F <msg>                           # 提交
git show --stat HEAD                          # 提交后复核：文件数与行数符合预期
```

每次提交后跑全量：`node --test "tests/*.test.mjs"`（**当前 250 项全绿**）。

---

## 4. 先后顺序

1. **形状不变的改动**：两条线互不阻塞，各自提交、各自发布。
2. **破坏性形状改动**：node 先落、client 后跟，**一次发布带上两边**。大哥可以指定由谁先动。
3. **同一时刻只允许一条线改「共享面」**：spec 的同一章节 / `view-model.mjs` 的同一个函数。
   两个人同时改一个函数，合并时必然有一边要重做。

---

## 5. 本次快照（2026-10-22 02:5x）

**UI/UX 线已提交：**

| commit | 内容 | 文件数 |
| --- | --- | --- |
| `067d454` | `feat(miniapp): 看板 UI/UX 重做为「值更台」` | 3（client 三件套） |
| `5bffd98` | `docs(spec): §6 视觉系统「值更台」` | 1（单 hunk，27+/1-） |

**负责人线在我工作期间提交的（不是我动的）：**

| commit | 内容 |
| --- | --- |
| `84ff3ae` | `fix(patrol): 配置里的废键不能复活` |
| `ac61446` | `docs(spec): §24.7 顺手清掉一个废键：autoDispatch` |

**工作树当前残留**：`node/view-model.mjs`（负责人线的 `expired` 修正，**我没有碰**）。

**验证口径**：全量 250 项测试全绿；浏览器实测（5 视图 × 深浅两色 + 430px 窄屏 +
掉线态 + 弹窗态）0 控制台错误、0 横向溢出、焦点环可见。

---

## 6. 给大哥的两个判断点

1. **要不要并线？** 我的建议是**不并成一条**，但**认一条硬接缝**：`view-model.mjs` 的
   形状变更必须走「node 先落 → client 后跟 → 一次发布」的三段式，其余各干各的。
   并线的成本（两条线的判断互相阻塞）大于收益（只有一处真接缝）。
2. **「真答复」实测归谁？** 归**负责人线**（发卡是运行时的事）。客户端侧我已经就绪：
   问卷在对话里可直接选、在收件箱里有「按大哥的建议回复」/「去回答」。大老板点掉新卡后，
   只需要把 request_id 给我，我验一遍两个视图同步即可。
