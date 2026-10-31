# 仿身泪滴 · Super-agent 对齐迭代 — Progress

> 本计划的执行日志。每个任务追加一行（commit 引用 + 测试增量）；每个阶段收尾追加一个 `**Phase N closeout**` 块。
> **测试增量是这里最重要的一行**——大老板靠它判断计划是否健康。

**Status:** **0/6 个阶段已落地**。基线 commit `ba7f6ec`（`chore: 作者署名统一为 HanMaXiao (#19)`）。基线测试：**602 项全绿**（`node --test` 的 TAP 输出：`tests 602 / pass 602 / fail 0`，2026-11-01 实测）。

**Roadmap anchor:** [`../../specs/2026-11-01-super-agent-baseline.md`](../../specs/2026-11-01-super-agent-baseline.md) §4 缺口台账
**Spec authority:** [`../../specs/2026-11-01-super-agent-baseline.md`](../../specs/2026-11-01-super-agent-baseline.md) §7 闸门
**Long-form plan:** 本目录三份文件（`task_plan.md` + `findings.md` + `progress.md`）

**大老板已拍板的决策（锁定 2026-11-01）：**
1. **以 Super-agent 文章为大哥演进的基线**——核心思想（一个助理管住一切、让用户置身事外）与大哥一致，差距在架构与细节的颗粒度。
2. **逐步深化迭代**，不搞一次性大重写——按 [`task_plan.md`](task_plan.md) 的 6 个阶段推进，每阶段有闸门。
3. **不照搬文章里为云端/多设备/多信道设计的那部分**（否决清单见基线规格 §5）。

**Working memory:**
- [`task_plan.md`](task_plan.md) — 阶段与任务清单
- [`findings.md`](findings.md) — 锁定的设计决策与开放问题
- [`progress.md`](progress.md) — 本文件

**Worktree:** **尚未创建**。按 [`findings.md`](findings.md) F0.1，worktree 与分支在 **Phase 1 真正开工时**从 `main`（`ba7f6ec`）切出：

```sh
git worktree add -b feature/super-agent-alignment <仓库外目录> main
```

---

## 计划开篇（2026-11-01）

- **产出**：基线规格 + 迭代计划三份文件 + 一份 Agent Note
- **文件**：
  - `docs/specs/2026-11-01-super-agent-baseline.md`（新建）
  - `docs/plans/2026-11-01-super-agent-alignment/task_plan.md`（新建）
  - `docs/plans/2026-11-01-super-agent-alignment/findings.md`（新建）
  - `docs/plans/2026-11-01-super-agent-alignment/progress.md`（新建，本文件）
  - `.agents/notes/proposed/architecture/2026-11-01-super-agent-as-evolution-baseline.md`（新建）
- **测试增量：** 602 → 602（**纯文档改动，不碰任何运行时文件**，一条测试都不该变——如果变了，说明改动越界了）
- **外部基线**：DeepSeek Harness《Super-agent 设计探索：迈向更自主的 Agent 系统》（2026-10-31）全文已读，锚点为原文小节号

### 本轮的关键发现（供后来的人省时间）

1. **大哥当前处于 `resting`**，值班 cron 的**调度 job 已 `cancelled`**（定义还在），最后一次成功投递 **2026-10-27 13:07**，此后 **219 个空槽**无人值班。
2. **心跳补偿锁死**（`reason = already_triggered`），**不会自己补**那 219 个空槽——这是一条断掉的恢复路径（→ G-10，Phase 1）。
3. **收件箱 100 条结论、93 条从未被确认**，来源 `board` 97 / `duty` 3。文章 §3.1 的「高噪音、低触发率」在我们这儿**已经是问题，不是优化项**（→ G-11，Phase 4）。
4. **管辖名单只有 1 项**（`Mimic Tear` 自己）——「替我管所有项目」这条主链路**从未在真实多项目负载下跑过**（External Validation Pending）。
5. **技能库 3 条 `active`、`usageCount` 全为 0**——匹配路径没有任何使用痕迹（→ G-11）。
6. **Mini App node 侧没有 goal 创建入口**（全目录 `createGoal|threadGoal|tokenBudget` 零命中）——这是主规格 §26 已记录的独立议题，**不混进本计划**。
7. 近 72 小时 `local_runtime_message_rows` 里 **`cron` 来源 0 条**——这段时间唯一在驱动整个系统的是**人**（`api = 873`）。

---

## Phase 1 — 让大哥能安全上岗

- **状态：** pending
- **对应缺口：** G-10 ｜ **对应闸门：** Gate 5
- **关键决策：** F1.1（采样补齐）/ F1.2（锁死可显式解除、不自愈）/ F1.3（摘要给大老板看）
- **开工前必须确认：** 大老板是否恢复大哥值班（D1）

## Phase 2 — 事实层：Trigger 与两级过滤

- **状态：** pending
- **对应缺口：** G-02、G-03 ｜ **对应闸门：** Gate 1
- **关键决策：** F2.1（Trigger 由 node 侧生成）/ F2.2（Fast Path 写代码里）/ F2.3（双段输出）

## Phase 3 — 直通：Thread 与订阅

- **状态：** pending
- **对应缺口：** G-04、G-05 ｜ **对应闸门：** Gate 2
- **关键决策：** F3.1（线 = 项目）/ F3.2（复用 `session send`）/ F3.3（名单是结构性闸）

## Phase 4 — 产出收敛与低打扰

- **状态：** pending
- **对应缺口：** G-11 ｜ **对应闸门：** Gate 1.5
- **关键决策：** F4.1（语义上界）/ F4.2（归档不删）/ F4.3（≤100 词断言）

## Phase 5 — 线视角的板面

- **状态：** pending
- **对应缺口：** G-01 ｜ **对应闸门：** Gate 3
- **关键决策：** F5.1（线 = 项目 + 作为 + 待决策）/ F5.2（旧总览降为下钻）

## Phase 6 — 韧性：判进展、全双工、状态收口

- **状态：** pending
- **对应缺口：** G-09、G-07、G-08 ｜ **对应闸门：** Gate 4
- **关键决策：** F6.1（确定性判据，不用模型判）/ F6.2（只改轮次层）/ F6.3（收口但不建库）

---

## 错误日志

（暂无。基线干净：`node --test` 602 项全绿。）

---

## 重启检查（下一个 session 的 5 个问题）

1. **本计划落到几个阶段了？**
   **0/6**（Phase 1 未开工）
2. **当前测试条数？**
   **602/602 全绿**（2026-11-01 基线）
3. **哪个阶段在进行？**
   **Phase 1 — 让大哥能安全上岗** ｜ 无
4. **所有测试在 `feature/super-agent-alignment` 上全绿吗？**
   尚未开分支（worktree 按 F0.1 在 Phase 1 开工时创建）
5. **基线规格 §4 的缺口台账与本文档还一致吗？**
   一致（G-01 ~ G-11）。若新增缺口，**两处同一次改动一起改**。
