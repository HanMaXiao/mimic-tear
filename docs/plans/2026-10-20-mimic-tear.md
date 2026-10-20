# 仿身泪滴（Mimic Tear）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付一个 MiniMax Code 内的 Mini App，把 MiniMax Code 运行时的项目/会话/Goal/待答问题聚合成"大哥的指挥部"，并能把指令真实投递给目标项目会话。

**Architecture:** Node 侧用 `node:sqlite` 以 readOnly 打开运行时库 `~/.minimax/v2/sqlite/runtime-state.sqlite`，配合 `<项目>/.mavis/plans/` 状态日志与本机 skill 目录，聚合出"总览 / 决策收件箱 / 项目详情 / 能力库"四类视图；Client 只做呈现。所有写操作（派工、确认）走唯一的领域服务 `ProjectService`，派工再经 `context.agent.run` 由"大哥" agent 用原生 `mavis` 工具 `session send` 投递。**绝不写运行时库。**

**Tech Stack:** Node.js 24 内置 `node:sqlite` / `node:http` / `node:fs`（零第三方依赖）；`node:test` + `node:assert/strict` 做单测；Client 为原生 HTML/CSS/JS + SSE；Host 侧用 `miniapp` 工具（init → publish → inspect → open）与 `mavis` 工具（agent create / session send）。

**Spec:** `docs/specs/2026-10-20-mimic-tear-design.md`

---

## Global Constraints

以下每条都直接来自规格，全局适用于所有任务：

- **零第三方运行时依赖**：包内不得出现 `node_modules`；只用 Node 内置模块。
- **`node:sqlite` 必须无 flag 可用**：Host 运行时为 Electron 42.8.0 / Node v24.18.0（实测已验证）。最低要求 Node ≥ 23.4。
- **运行时库只读**：`MIMIC_RUNTIME_DB` 可覆盖路径，默认 `path.join(os.homedir(), '.minimax/v2/sqlite/runtime-state.sqlite')`。**任何代码路径都不得以写模式打开它。**
- **单一写路径**：`HTTP / MCP / 后台 → 校验 → ProjectService → 持久化提交 → SSE 广播`。先提交再广播；广播失败不回滚。
- **持久化只在 `context.dataDir`**：`dispatches.json` / `acks.json` / `boss-session.json`。Client 不得持有领域数据。
- **Client 不得出现**：凭据、Host 对象、内部端口、`/api/` 之外的内部路径、运行时库的绝对路径。
- **视觉基线**：`minimax-code-visual-ui.md`。`--mcode-*` CSS 变量；浅色/深色随 `prefers-color-scheme`；卡片 12px 圆角、控件 8px、1px 边框；**禁止 emoji、远程字体、远程图片、CDN、渐变、霓虹**；中文文案。
- **可访问性**：语义化 HTML（`header`/`nav`/`main`/`section`/`table`）、连续标题层级、每个可交互元素有可见文字或 `aria-label`、键盘可达、`role="status"`/`role="alert"`、`prefers-reduced-motion` 降级。
- **四态齐备**：加载 / 空 / 错误 / 工作中，错误时保留页面结构。
- **测试位置**：单测放仓库根 `tests/`（不放进 Mini App 包内，避免污染发布负载）；用 `node --test tests/`。
- **提交粒度**：一个意图一个 commit，`git add -- <显式路径>`，禁止 `git add -A`。

---

## Review Focus

规格暗示但没有任务会自然覆盖、且最可能伤到真实使用的五个失败模式。每一行都必须在拥有对应代码的任务里有一条测试钉住它。

1. **运行时库缺失或被锁** → 页面必须保留完整结构并给出可操作的排查提示（期望路径 + 版本要求），**绝不白屏、绝不 500 空响应**。
2. **项目路径含空格/中文/已被删除** → 拼接与读取不能抛错；找不到 `.mavis/plans` 时静默隐藏该区块，不影响项目详情其余部分。
3. **组织树出现孤儿节点**（父会话不属于同一 project 或已被清理） → 节点不得丢失，必须提升为根节点。
4. **问卷 `request_json` 结构随版本变化或损坏** → 解析失败必须降级为"无法解析该问卷内容"的可读文案，不得抛出到页面级错误。
5. **派工重复提交**（用户连点两次 / 网络重试） → 同一 `idempotencyKey` 不得向目标会话投递两次，第二次返回既有记录。

---

## File Structure

```
D:\Project\AppProject\Mimic Tear\
├── docs/
│   ├── specs/2026-10-20-mimic-tear-design.md      # 规格（已提交）
│   └── plans/2026-10-20-mimic-tear.md              # 本计划
├── tests/                                           # 单测（不随包发布）
│   ├── helpers/fixture.mjs                          # 临时 sqlite / 目录 fixture
│   ├── runtime-store.test.mjs
│   ├── plan-store.test.mjs
│   ├── skill-catalog.test.mjs
│   ├── view-model.test.mjs
│   ├── project-service.test.mjs
│   ├── boss-bridge.test.mjs
│   └── server.test.mjs
└── miniapps/mimic-tear/                             # 由 miniapp.init 生成骨架
    ├── .minimax-plugin/plugin.json
    ├── package.json
    ├── icon.png
    └── miniapp/
        ├── miniapp.json                             # manifest：surface "/", agentAccess
        ├── node/
        │   ├── server.mjs                           # HTTP + SSE + 静态资源 + 生命周期
        │   ├── miniapp-api.ts                       # Host 注入类型声明（从参考拷贝）
        │   ├── runtime-store.mjs                    # node:sqlite 只读读模型
        │   ├── plan-store.mjs                       # .mavis/plans 状态解析
        │   ├── skill-catalog.mjs                    # skill 扫描 + 领域归类
        │   ├── view-model.mjs                       # 纯函数：健康度/卡片/收件箱/组织树
        │   ├── project-service.mjs                  # 唯一领域服务（读写都在这）
        │   ├── boss-bridge.mjs                      # context.agent.run 派工通道
        │   ├── persistence.mjs                      # dataDir 下的 JSON 持久化
        │   └── domains.json                         # 领域 → skill 归类清单
        └── client/
            ├── index.html                           # 四视图骨架 + 语义结构
            ├── app.js                               # 路由 / 渲染 / SSE 客户端
            └── styles.css                           # --mcode-* 变量与组件样式
```

职责边界：`view-model.mjs` 全是纯函数（不碰 IO），因此最容易测；`project-service.mjs` 只做编排与校验；`server.mjs` 只做 HTTP/SSE 传输。

---

### Task 1: 工作区包骨架

**Files:**
- Create: `miniapps/mimic-tear/` （由 `miniapp` 工具的 `init` 生成）
- Modify: `miniapps/mimic-tear/miniapp/miniapp.json`

**Interfaces:**
- Consumes: 无
- Produces: `packagePath`（init 返回，工作区相对路径，后续所有编辑都只在此目录内）、`pluginId = mimic-tear`、可运行的 `miniapp/miniapp.json` 与 `miniapp/client/index.html` 占位。

- [ ] **Step 1: 调用 `miniapp` 工具 `{ action: "init", pluginId: "mimic-tear" }`**

  记录返回的 `packagePath` 与 `mode`。`mode` 必须是 `create`（本仓库此前没有该包）。若返回 `update`，先读完整 manifest 再决定。

- [ ] **Step 2: 读 `miniapp/miniapp.json` 与 `.minimax-plugin/plugin.json` 全文**

  确认 `schemaVersion`、两个 payload root、`runtime.entry` 指向 `./miniapp/node/server.mjs`、`surface.path`。

- [ ] **Step 3: 改写 `miniapp/miniapp.json` 为最终声明**

  `surface.path` 设为 `"/"`；`artifacts.client` = `["./miniapp/client"]`；`artifacts.node` = `["./miniapp/node"]`；`runtime.kind` = `"process"`；`runtime.entry` = `"./miniapp/node/server.mjs"`；`agentAccess` = `["session.run"]`；`agentConcurrency` = 4；`mcpEndpoints` = `[]`；`hostConnectorAccess` = `{ "providers": [] }`。

- [ ] **Step 4: 从参考拷贝 `miniapp/node/miniapp-api.ts`**

  源：`C:\Users\12391\.minimax\.builtin-skills\miniapp-creator\references\miniapp-api.ts`。

- [ ] **Step 5: 验证骨架可被 Host 识别**

  Run: `miniapp` 工具 `{ action: "inspect", pluginId: "mimic-tear" }`
  Expected: 返回包元数据，未报结构错误（此时尚未 publish，inspect 只做识别）。

- [ ] **Step 6: Commit**

```bash
git add miniapps/mimic-tear/.minimax-plugin/plugin.json miniapps/mimic-tear/package.json miniapps/mimic-tear/miniapp/miniapp.json miniapps/mimic-tear/miniapp/node/miniapp-api.ts
git commit -m "feat(mimic-tear): 初始化 Mini App 工作区包骨架"
```

---

### Task 2: RuntimeStore（运行时只读读模型）

**Files:**
- Create: `miniapps/mimic-tear/miniapp/node/runtime-store.mjs`
- Test: `tests/runtime-store.test.mjs`、`tests/helpers/fixture.mjs`

**Interfaces:**
- Consumes: 无（只依赖 Node 内置 `node:sqlite`）
- Produces:
  ```ts
  class RuntimeStore {
    static open(dbPath: string): RuntimeStore
    close(): void
    isAvailable(): boolean
    lastError(): string | null
    revision(): string
    listProjects(): ProjectRow[]
    listSessions(projectId?: number): SessionRow[]
    listGoals(): GoalRow[]
    listQuestionnaires(pendingOnly: boolean): QuestionnaireRow[]
    listActiveTasks(): TaskRow[]
  }
  interface ProjectRow { id:number; kind:string; workspaceDir:string; sessionCount:number; latestActivityAt:number|null; pinned:boolean; hidden:boolean; orderIndex:number }
  interface SessionRow { id:string; agentName:string; status:string; title:string; workspaceDir:string; purpose:string|null; purposeKind:string|null; parentSessionId:string|null; sessionType:string; visibility:string; createdAt:number; updatedAt:number; errorCode:number|null; errorMessage:string|null; projectId:number|null }
  interface GoalRow { id:string; sessionId:string; objective:string; status:string; createdAt:number; updatedAt:number; tokensUsed:number; timeUsedSeconds:number; statusReason:string|null; lastVerification:string|null }
  interface QuestionnaireRow { id:string; sessionId:string; agentName:string; requestJson:string; status:string; createdAt:number }
  interface TaskRow { id:string; ownerSessionId:string; kind:string; status:string; createdAt:number; updatedAt:number; endedAt:number|null }
  ```

- [ ] **Step 1: 写 fixture helper**

  `tests/helpers/fixture.mjs` 导出 `makeRuntimeDb(dir: string): string`——用 `node:sqlite` 在 `dir` 下建一个与运行时同名的库，建出规格 §2.1 涉及的全部表与列（只需覆盖被查询的列），插入 3 个 project / 5 个 session（含一条 `parent_session_id` 指向同 project、两条跨 project 的孤儿）/ 2 个 goal / 3 个 questionnaire（1 pending）/ 若干 task。导出 `tmpDir()` 创建并返回临时目录。

- [ ] **Step 2: 写失败的测试 `tests/runtime-store.test.mjs`**

  断言：
  - `listProjects()` 返回 3 条，`workspaceDir` 为绝对路径，`sessionCount` 为数值
  - `listSessions(projectId)` 只返回该 project 的会话
  - `listQuestionnaires(true)` 只返回 `status` 非 `answered`/`dismissed` 的
  - `listGoals()` 的 `objective` 为完整原文（不被截断）
  - `revision()` 在两次调用间相同；向库写入后 revision 改变
  - `isAvailable()` 为 true，`lastError()` 为 null
  - **Review Focus 1**：`RuntimeStore.open('<不存在的路径>')` 不抛异常；`isAvailable()` 为 false；`lastError()` 非 null 且包含路径；`listProjects()` 返回 `[]`

- [ ] **Step 3: 运行测试确认失败**

  Run: `node --test tests/runtime-store.test.mjs`
  Expected: FAIL — `Cannot find module .../runtime-store.mjs`

- [ ] **Step 4: 实现 `runtime-store.mjs`**

  `node:sqlite` 的 `DatabaseSync(dbPath, { readOnly: true })`；查询全部写成显式列名并映射为 camelCase；`revision()` 用 `max(updated_at_ms)` + 表计数拼字符串；打开失败时把错误记入 `lastError()` 并让 `isAvailable()` 返回 false，**方法一律返回空数组而不是抛错**。

- [ ] **Step 5: 运行测试确认通过**

  Run: `node --test tests/runtime-store.test.mjs`
  Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add miniapps/mimic-tear/miniapp/node/runtime-store.mjs tests/runtime-store.test.mjs tests/helpers/fixture.mjs
git commit -m "feat(mimic-tear): 运行时只读读模型 RuntimeStore"
```

---

### Task 3: PlanStore（.mavis/plans 状态解析）

**Files:**
- Create: `miniapps/mimic-tear/miniapp/node/plan-store.mjs`
- Test: `tests/plan-store.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces:
  ```ts
  function readPlan(projectDir: string): PlanSnapshot | null
  interface PlanSnapshot { source: string; updatedAt: number; tasks: PlanTask[] }
  interface PlanTask { id: string|null; title: string; state: 'producing'|'ready'|'blocked'|'done'|'unknown'; assignedTo: string|null }
  ```

- [ ] **Step 1: 写失败的测试 `tests/plan-store.test.mjs`**

  fixture 目录内造 `<tmp>/.mavis/plans/`：一个 `status1.log`（含 `Tasks:` 段与 `✦ 任务A [producing]  verify=on` 这类行）、一个 `plan.yaml`（含 `tasks:` 列表，每项 `id`/`title`/`assigned_to`）、一个更新的 `status2.log`。断言：
  - `readPlan()` 返回最新日志对应的 snapshot
  - `tasks[].state` 正确解析出 `producing` / `ready` / `blocked`
  - `tasks[].id` / `assignedTo` 从 yaml 补齐（按标题匹配）
  - **Review Focus 2**：目录不存在 / 空目录 / 含乱码文件 → 返回 `null`，**不抛错**

- [ ] **Step 2: 运行测试确认失败**

  Run: `node --test tests/plan-store.test.mjs`
  Expected: FAIL — module not found

- [ ] **Step 3: 实现 `plan-store.mjs`**

  用 `node:fs` 读 `.mavis/plans/`：按 mtime 选最新的 `status*.log`；用行扫描解析 `Tasks:` 之后的 `[state]` 标记与标题（容忍全角/半角符号与 `✦`/`✔` 等前缀）；用**行扫描**（非完整 YAML 解析器）从最新 `*-plan*.yaml` 提取 `id`/`title`/`assigned_to` 三元组，按标题匹配回填。`id`/`title`/`assigned_to` 在 yaml 中的缩进与引号形式需容忍多种写法。

- [ ] **Step 4: 运行测试确认通过**

  Run: `node --test tests/plan-store.test.mjs`
  Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add miniapps/mimic-tear/miniapp/node/plan-store.mjs tests/plan-store.test.mjs
git commit -m "feat(mimic-tear): 解析 .mavis/plans 任务状态机"
```

---

### Task 4: SkillCatalog（能力库扫描与领域归类）

**Files:**
- Create: `miniapps/mimic-tear/miniapp/node/skill-catalog.mjs`
- Create: `miniapps/mimic-tear/miniapp/node/domains.json`
- Test: `tests/skill-catalog.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces:
  ```ts
  function scanSkills(roots: SkillRoot[]): SkillScan
  function classify(skills: SkillEntry[], domains: DomainDef[]): { groups: DomainGroup[]; unmapped: SkillEntry[] }
  interface SkillRoot { label: string; source: 'user'|'builtin'|'project'; dir: string }
  interface SkillScan { skills: SkillEntry[]; failures: { path: string; reason: string }[] }
  interface SkillEntry { name: string; description: string; source: string; path: string }
  interface DomainDef { key: string; label: string; match: string[]; keywords?: string[] }
  interface DomainGroup { key: string; label: string; skills: SkillEntry[] }
  ```

- [ ] **Step 1: 写失败的测试 `tests/skill-catalog.test.mjs`**

  fixture 造 3 个 skill 目录（每个含 `SKILL.md`，frontmatter 带 `name` 与 `description`）与 1 个缺 `SKILL.md` 的目录。断言：
  - `scanSkills()` 只收录有效 skill，坏目录进 `failures`
  - frontmatter 的 `name`/`description` 被正确读出，缺失 `name` 时用目录名兜底
  - `classify()` 按 `domains.json` 的 `match` 前缀归类；未命中进 `unmapped`
  - 关键词兜底：`match` 不中但 `keywords` 命中 description 时归入该域

- [ ] **Step 2: 运行测试确认失败**

  Run: `node --test tests/skill-catalog.test.mjs`
  Expected: FAIL — module not found

- [ ] **Step 3: 实现 `skill-catalog.mjs` 与 `domains.json`**

  扫描根目录由调用方传入（Task 6 负责组装本机真实路径）。`SKILL.md` 用行扫描读 YAML frontmatter（`---` 包裹区内的 `name:` / `description:`），**不引入 YAML 解析器**。`domains.json` 至少含 10 个域：`unreal` / `blender` / `frontend` / `desktop` / `mobile` / `backend` / `dotnet` / `gamedev` / `pm` / `research`，每个域带中文 `label`。

- [ ] **Step 4: 运行测试确认通过**

  Run: `node --test tests/skill-catalog.test.mjs`
  Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add miniapps/mimic-tear/miniapp/node/skill-catalog.mjs miniapps/mimic-tear/miniapp/node/domains.json tests/skill-catalog.test.mjs
git commit -m "feat(mimic-tear): 能力库扫描与领域归类"
```

---

### Task 5: 纯函数层 view-model（健康度 / 卡片 / 收件箱 / 组织树）

**Files:**
- Create: `miniapps/mimic-tear/miniapp/node/view-model.mjs`
- Test: `tests/view-model.test.mjs`

**Interfaces:**
- Consumes: Task 2 的 `ProjectRow` / `SessionRow` / `GoalRow` / `QuestionnaireRow` / `TaskRow` 类型
- Produces:
  ```ts
  type Health = 'active'|'idle'|'blocked'|'error'
  function computeHealth(input: { sessions: SessionRow[]; pendingQuestions: number; goals: GoalRow[]; planTasks: PlanTask[]; activeTasks: number }): Health
  function buildProjectCards(input: { projects: ProjectRow[]; sessionsByProject: Map<number, SessionRow[]>; goalsBySession: Map<string, GoalRow[]>; questionsBySession: Map<string, QuestionnaireRow[]>; plansByProject: Map<number, PlanSnapshot|null> }): ProjectCard[]
  function buildInbox(input: { projects: ProjectRow[]; sessions: SessionRow[]; goals: GoalRow[]; questionnaires: QuestionnaireRow[]; planTasksByProject: Map<number, PlanTask[]> }, acked: Set<string>): InboxItem[]
  function buildOrgTree(sessions: SessionRow[]): OrgNode[]
  function buildKpi(cards: ProjectCard[], inbox: InboxItem[]): Kpi
  interface Kpi { projects: number; active: number; pendingDecisions: number; errors: number }
  interface ProjectCard {
    id: number; name: string; path: string; sessionCount: number
    lastActivityAt: number | null; health: Health
    activeSessions: number; erroredSessions: number; pendingQuestions: number
    goals: GoalRow[]; planTasks: PlanTask[]
  }
  interface Overview { generatedAt: number; kpi: Kpi; projects: ProjectCard[]; attention: InboxItem[] }
  interface ProjectDetail {
    project: ProjectCard
    orgTree: OrgNode[]
    goals: GoalRow[]
    questions: QuestionnaireRow[]
    tasks: TaskRow[]
    plan: PlanSnapshot | null
  }
  interface OrgNode {
    id: string; agentName: string; title: string; status: string
    role: 'lead' | 'member'; purpose: string | null; error: string | null
    children: OrgNode[]
  }
  interface InboxItem {
    id: string; kind: 'questionnaire'|'goal-paused'|'session-error'|'task-failed'|'plan-blocked'
    severity: 'high'|'medium'|'low'
    projectId: number; projectName: string
    sessionId: string | null; sessionTitle: string | null
    title: string; body: string; createdAt: number; ageMinutes: number
    acknowledged: boolean
  }
  ```

- [ ] **Step 1: 写失败的测试 `tests/view-model.test.mjs`**

  断言：
  - `computeHealth`：有 `errorCode` → `error`；有 pending 问卷 / paused goal / blocked plan task → `blocked`；有 `status==='started'` 会话或 running task → `active`；否则 `idle`；**并验证优先级**（同时有 error 和 blocked 时返回 `error`）
  - `buildProjectCards`：卡片数量与项目数一致，`path` 取 `workspaceDir`，`name` 取目录 basename
  - `buildInbox`：`session-error` → `severity 'high'`；`goal-paused` → `'medium'`；`task-failed` → `'low'`；`acked` 集合中的条目 `acknowledged === true`；排序为 severity 降序再按 `createdAt` 降序
  - `buildInbox` 的问卷条目 body 取自 `requestJson` 的 question 文本
  - **Review Focus 4**：`requestJson` 是非法 JSON 或结构未知 → 该条目仍存在，body 为"无法解析该问卷内容"，**不抛出**
  - **Review Focus 3**：`buildOrgTree` 传入父会话不存在的子会话 → 该子节点被提升为根节点，**节点总数不减少**

- [ ] **Step 2: 运行测试确认失败**

  Run: `node --test tests/view-model.test.mjs`
  Expected: FAIL — module not found

- [ ] **Step 3: 实现 `view-model.mjs`**

  全部为纯函数，不 import 任何 IO 模块。问卷解析用 `try/catch` + 结构探测，解析失败降级为固定文案。

- [ ] **Step 4: 运行测试确认通过**

  Run: `node --test tests/view-model.test.mjs`
  Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add miniapps/mimic-tear/miniapp/node/view-model.mjs tests/view-model.test.mjs
git commit -m "feat(mimic-tear): 纯函数视图模型（健康度/收件箱/组织树）"
```

---

### Task 6: 持久化 + ProjectService（唯一领域服务）

**Files:**
- Create: `miniapps/mimic-tear/miniapp/node/persistence.mjs`
- Create: `miniapps/mimic-tear/miniapp/node/project-service.mjs`
- Test: `tests/project-service.test.mjs`

**Interfaces:**
- Consumes: Task 2 `RuntimeStore`、Task 3 `readPlan`、Task 4 `scanSkills`/`classify`、Task 5 的纯函数
- Produces:
  ```ts
  class Persistence {
    constructor(dataDir: string)
    listDispatches(): DispatchRecord[]
    saveDispatch(rec: DispatchRecord): void
    findDispatchByKey(key: string): DispatchRecord | null
    listAcks(): string[]
    addAck(id: string): void
    getBossSessionId(): string | null
    setBossSessionId(id: string): void
  }
  interface DispatchRecord { id:string; idempotencyKey:string; projectId:number; projectName:string; targetSessionId:string|null; instruction:string; status:'queued'|'running'|'done'|'error'; bossSessionId:string|null; text:string; error:string|null; createdAt:number; updatedAt:number }
  class ProjectService {
    constructor(deps: { store: RuntimeStore; readPlan: (dir:string)=>PlanSnapshot|null; skills: SkillScan; domains: DomainDef[]; persistence: Persistence; boss: BossLike })
    getOverview(): Overview
    getInbox(): { items: InboxItem[] }
    getProjects(): { projects: ProjectCard[] }
    getProject(id: number): ProjectDetail | null
    getSkills(): { groups: DomainGroup[]; unmapped: SkillEntry[]; total: number; failures: number }
    async dispatch(input: { projectId:number; sessionId:string|null; instruction:string; idempotencyKey:string }): Promise<DispatchResult>
    ack(itemId: string): { ok:boolean }
  }
  // Task 6 只依赖这个鸭子类型，Task 7 的 BossBridge 必须满足它（测试用桩也用它）
  interface BossLike {
    dispatch(input: { projectId:number; projectName:string; projectPath:string; sessionId:string|null; sessionTitle:string|null; instruction:string }): Promise<{ bossSessionId:string; status:string; text:string; error:string|null; delivered:boolean }>
  }
  interface DispatchResult { dispatchId: string; status: 'queued'|'running'|'done'|'error'; bossSessionId: string|null; text: string; error: string|null; delivered: boolean; duplicate: boolean }
  ```

- [ ] **Step 1: 写失败的测试 `tests/project-service.test.mjs`**

  用 Task 2 的 fixture 库 + 假的 `readPlan` / 假的 boss（一个记录调用参数的桩）。断言：
  - `getOverview()` 的 `kpi.projects` 等于 fixture 的 project 数
  - `getProject(id)` 返回组织树、goals、questions、plan；不存在的 id 返回 `null`
  - `ack(id)` 后 `getInbox()` 中该项 `acknowledged === true`，且 ack 记录写进了 `dataDir/acks.json`
  - **Review Focus 5**：同一 `idempotencyKey` 连续调用 `dispatch()` 两次 → boss 桩只被调用一次，第二次返回第一条记录
  - `dispatch()` 对不存在的 `projectId` 抛业务错误（不调用 boss）
  - `dispatch()` 对空 instruction 抛业务错误
  - `getSkills()` 返回 domains 分组与 `unmapped`
  - 派工记录在 `dataDir/dispatches.json` 中可见

- [ ] **Step 2: 运行测试确认失败**

  Run: `node --test tests/project-service.test.mjs`
  Expected: FAIL — module not found

- [ ] **Step 3: 实现 `persistence.mjs` 与 `project-service.mjs`**

  `persistence.mjs` 用 `node:fs/promises` 读写 `dataDir` 下的三个 JSON；写入用"先写临时文件再 rename"避免半写。`project-service.mjs` 聚合四个只读源，**所有写操作都在这里**，并且顺序是：校验 → `persistence.saveDispatch` 提交 → 返回。

- [ ] **Step 4: 运行测试确认通过**

  Run: `node --test tests/project-service.test.mjs`
  Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add miniapps/mimic-tear/miniapp/node/persistence.mjs miniapps/mimic-tear/miniapp/node/project-service.mjs tests/project-service.test.mjs
git commit -m "feat(mimic-tear): 领域服务与持久化（唯一写路径）"
```

---

### Task 7: BossBridge（派工通道）

**Files:**
- Create: `miniapps/mimic-tear/miniapp/node/boss-bridge.mjs`
- Test: `tests/boss-bridge.test.mjs`

**Interfaces:**
- Consumes: Host 注入的 `context.agent`（`run` / `answer` / `agents`）；Task 6 的 `Persistence`
- Produces:
  ```ts
  interface AgentClientLike {
    run(input: { text: string; sessionId?: string; agent?: string }, opts?: { onEvent?: (e:any)=>void }): Promise<{ sessionId:string; status:'finished'|'error'|'aborted'; text?:string; error?:string }>
    agents(): Promise<{ agents: { name: string; displayName: string; primary: boolean }[] }>
  }
  class BossBridge {
    constructor(deps: { agent: AgentClientLike; persistence: Persistence; bossAgentName?: string })
    async dispatch(input: { projectId:number; projectName:string; projectPath:string; sessionId:string|null; sessionTitle:string|null; instruction:string }): Promise<{ bossSessionId:string; status:string; text:string; error:string|null; delivered:boolean }>
    buildPrompt(input: {...same...}): string
  }
  ```

- [ ] **Step 1: 写失败的测试 `tests/boss-bridge.test.mjs`**

  用一个假 agent 桩（记录 `run()` 的入参、模拟 `onEvent` 推 `text.delta` / `tool.started` / `turn.finished`）。断言：
  - `buildPrompt()` 里包含项目名、项目路径、目标会话 id/标题、原始指令
  - `buildPrompt()` 明确要求"使用 mavis 工具的 session send 把指令投递给目标会话"，并给出目标 session id
  - `dispatch()` 会复用 `persistence.getBossSessionId()` 的会话（第二次不再新建）
  - `dispatch()` 在 `agent.run` 返回 `status:'error'` 时返回 `delivered:false` 与错误文本，**不抛未捕获异常**
  - `dispatch()` 在 `onEvent` 收到 `permission.requested` 时调用 `agent.reply`（若桩提供）

- [ ] **Step 2: 运行测试确认失败**

  Run: `node --test tests/boss-bridge.test.mjs`
  Expected: FAIL — module not found

- [ ] **Step 3: 实现 `boss-bridge.mjs`**

  `agents()` 用来探测 `bossAgentName` 是否可用；不可用时回落到不带 `agent` 参数的默认 agent（规格 §3.3 降级链）。prompt 用中文，明确目标会话 id、要求用 `mavis` 工具 `session send` 投递、要求回报投递结果。

- [ ] **Step 4: 运行测试确认通过**

  Run: `node --test tests/boss-bridge.test.mjs`
  Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add miniapps/mimic-tear/miniapp/node/boss-bridge.mjs tests/boss-bridge.test.mjs
git commit -m "feat(mimic-tear): 派工通道 BossBridge"
```

---

### Task 8: Server（HTTP + SSE + 静态资源）

**Files:**
- Create: `miniapps/mimic-tear/miniapp/node/server.mjs`
- Test: `tests/server.test.mjs`

**Interfaces:**
- Consumes: Task 6 的 `ProjectService`、Task 7 的 `BossBridge`、Host 的 `context`（`listen`/`signal`/`logger`/`agent`/`dataDir`）
- Produces: `export async function start(context): Promise<{ dispose(): Promise<void> }>`，并暴露路由：
  - `GET /` → Client HTML
  - `GET /assets/*` → 静态资源
  - `GET /api/overview` / `/api/inbox` / `/api/projects` / `/api/projects/:id` / `/api/skills` / `/api/dispatch/:id`
  - `POST /api/dispatch`
  - `GET /api/stream` → SSE

- [ ] **Step 1: 写失败的测试 `tests/server.test.mjs`**

  用假 context（`listen: { host:'127.0.0.1', port:0 }`、假 `logger`、假 `signal`、假 `agent`）与 Task 6 的 service 启动服务。断言：
  - `GET /api/overview` 返回 200 与 JSON，结构含 `kpi`/`projects`
  - `POST /api/dispatch` 无效 body → 400 且 JSON 含 `error`
  - `POST /api/dispatch` 有效 → 200 且 `dispatchId` 存在；同 key 重复 → 200 且不重复投递
  - `GET /api/stream` 保持连接并先收到一条 `snapshot` 事件
  - `GET /api/skills` 返回 200
  - 未知路径 → 404 JSON
  - `dispose()` 后服务器关闭

- [ ] **Step 2: 运行测试确认失败**

  Run: `node --test tests/server.test.mjs`
  Expected: FAIL — module not found

- [ ] **Step 3: 实现 `server.mjs`**

  `node:http`；**必须用 `createServer` 直接监听 `context.listen.port`**（不可用 https/http2/net/子进程）；不碰 `/__mavis/` 前缀；SSE 每 3 秒比较 `store.revision()`，变化则重聚合并广播 `update`；派工过程广播 `dispatch` 事件；`dispose()` 关闭 server、SSE 连接、轮询定时器。

- [ ] **Step 4: 运行测试确认通过**

  Run: `node --test tests/server.test.mjs`
  Expected: PASS

- [ ] **Step 5: 跑全量单测**

  Run: `node --test tests/`
  Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
git add miniapps/mimic-tear/miniapp/node/server.mjs tests/server.test.mjs
git commit -m "feat(mimic-tear): HTTP + SSE 服务与路由"
```

---

### Task 9: Client 四视图

**Files:**
- Create: `miniapps/mimic-tear/miniapp/client/index.html`
- Create: `miniapps/mimic-tear/miniapp/client/app.js`
- Create: `miniapps/mimic-tear/miniapp/client/styles.css`
- Modify: `miniapps/mimic-tear/miniapp/node/server.mjs`（若静态资源路由需调整）
- Test: `tests/client-contract.test.mjs`

**Interfaces:**
- Consumes: Task 8 的 REST + SSE 接口
- Produces: 四个视图（`#overview` / `#inbox` / `#project` / `#skills`），由 hash 路由切换。

- [ ] **Step 1: 写失败的测试 `tests/client-contract.test.mjs`**

  读 `index.html` / `app.js` 文本并断言：
  - 存在 `<header>` / `<nav>` / `<main>` / `<section>` 语义标签与 `<h1>`
  - 四个视图容器 id 都存在
  - 关键可访问性契约：`aria-label`（搜索框、刷新、导航）、`role="status"`、`role="alert"`、`<table>` 与 `<th scope>`
  - `app.js` 里出现全部四个 API 路径与 `/api/stream`
  - `styles.css` 定义 `--mcode-bg` / `--mcode-text` / `--mcode-accent` / `--mcode-danger` 等变量，且含 `prefers-color-scheme` 与 `prefers-reduced-motion` 块
  - 全文不含**远程资源引用**：除 `http://www.w3.org/2000/svg`（SVG 命名空间）与 `http://127.0.0.1` / `http://localhost`（同源）外，不出现其他 `http://` / `https://` 字面量；不含 emoji 表情字符

- [ ] **Step 2: 运行测试确认失败**

  Run: `node --test tests/client-contract.test.mjs`
  Expected: FAIL — 文件不存在

- [ ] **Step 3: 实现 `index.html`**

  语义骨架 + 四个视图容器 + 内联 SVG 图标（无 emoji）。

- [ ] **Step 4: 实现 `styles.css`**

  按 `minimax-code-visual-ui.md`：`:root` 定义浅色变量，`[data-theme='dark']` 定义深色变量，`@media (prefers-color-scheme: dark)` 自动映射；卡片 12px、控件 8px、1px 边框、`0 0 20px rgb(10 10 10 / 8%)` 阴影。

- [ ] **Step 5: 实现 `app.js`**

  hash 路由；`fetch` 四个读接口；`EventSource('/api/stream')` 订阅并刷新；`POST /api/dispatch` 提交派工；`ack` 交互；四态渲染（加载/空/错误/工作中）；错误用 `role="alert"` 就地展示，**不破坏页面结构**。

- [ ] **Step 6: 运行测试确认通过**

  Run: `node --test tests/client-contract.test.mjs`
  Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add miniapps/mimic-tear/miniapp/client/index.html miniapps/mimic-tear/miniapp/client/app.js miniapps/mimic-tear/miniapp/client/styles.css tests/client-contract.test.mjs
git commit -m "feat(mimic-tear): 客户端四视图（总览/收件箱/项目详情/能力库）"
```

---

### Task 10: 发布与 Host 验收

**Files:**
- Modify: `miniapps/mimic-tear/miniapp/miniapp.json`（仅在 Host 校验报错时）
- Modify: `miniapps/mimic-tear/miniapp/node/server.mjs`（仅在验收暴露缺陷时）

**Interfaces:**
- Consumes: Task 1–9 的全部产物
- Produces: 已发布、已打开、通过规格 §9 十条验收项的 Mini App

- [ ] **Step 1: 发布**

  Run: `miniapp` 工具 `{ action: "publish", pluginId: "mimic-tear" }`
  Expected: 成功。失败则读 `references/diagnostics.md` 定位，**只改工作区包内文件**。

- [ ] **Step 2: 检查运行态**

  Run: `miniapp` 工具 `{ action: "inspect", pluginId: "mimic-tear" }`
  Expected: `runtime.status` 为 `running`。

- [ ] **Step 3: 打开页面**

  Run: `miniapp` 工具 `{ action: "open", pluginId: "mimic-tear" }`
  Expected: 成功，报告结构化结果（**不自行拼 URL**）。

- [ ] **Step 4: 读 Browser 技能并做页面验收**

  先用 `skill` 工具读 Browser 插件技能的完整名称，再用 `mcp_browser` 工具对已打开的页做 `inspect` / `query` / 交互。逐条核对规格 §9 的第 7、9、10 项：SSE 联动、无 console 错误、浅深色可读、键盘可达。

- [ ] **Step 5: 用 sqlite 探针逐条核对数值**

  写一个只读探针（`node -e` 即可，**不落盘到包里**）查 `local_runtime_projects` / `questionnaire_requests` / `local_runtime_sessions`，与页面上显示的数值逐项比对，核对规格 §9 第 2、3、4、5 项。

- [ ] **Step 6: 核对包内无 `node_modules`**

  Run: `Get-ChildItem -Recurse -Directory miniapps/mimic-tear | Where-Object Name -eq 'node_modules'`
  Expected: 无输出。

- [ ] **Step 7: Commit**

```bash
git add miniapps/mimic-tear
git commit -m "feat(mimic-tear): 发布并通过 Host 验收"
```

---

### Task 11: 「大哥」agent 与 mimic-tear-boss 技能

**Files:**
- Create: `C:\Users\12391\.minimax\agents\boss\` （由 `mavis agent create` 生成）
- Create: `C:\Users\12391\.minimax\agents\boss\skills\mimic-tear-boss\SKILL.md`

**Interfaces:**
- Consumes: 规格 §1.4 与 §8 的全部要点
- Produces: 可被 `context.agent.run({ agent: 'boss' })` 选中的本地 agent，及其技能

- [ ] **Step 1: 创建 agent**

  Run: `mavis` 工具 `agent create`，`name: "boss"`，`display_name: "大哥"`，`description: "仿身泪滴总管：统管全部项目的决策、派工与验收"`，`persona` 写入规格 §8.1 的五条决策原则与汇报纪律，**不传 model/effort**（继承默认）。

- [ ] **Step 2: 写技能**

  `SKILL.md` 含 frontmatter（`name: mimic-tear-boss`、中文 `description`）与正文四章：**角色与职责** / **决策原则**（规格 §8.1）/ **派工决策树**（规格 §8.2）/ **升级边界**（规格 §8.3）/ **领域→skill 地图**（指向 `domains.json` 的 10 个域，列出各域代表 skill 名称）。

- [ ] **Step 3: 验证 agent 可见**

  Run: `mavis` 工具 `agent list`（含 primary）
  Expected: 列表中出现 `boss`。

- [ ] **Step 4: Commit（仅仓库内可提交的部分）**

  本任务的产物在 `~/.minimax/agents/boss/`，**不在本仓库内**，不产生 git commit；在最终汇报中说明其位置与加载方式。

---

### Task 12: 派工链路端到端实测

**Files:**
- Modify: `miniapps/mimic-tear/miniapp/node/server.mjs` / `boss-bridge.mjs`（仅在实测暴露缺陷时）

**Interfaces:**
- Consumes: Task 7 / 10 的产物
- Produces: 规格 §9 第 6 项的实测证据

- [ ] **Step 1: 在 Mini App 里对一个真实项目发起一次派工**

  选一个空闲项目的会话，提交一条可辨识的指令（例如"【仿身泪滴派工自检】请回复当前项目状态摘要。"）。

- [ ] **Step 2: 到目标会话确认收到**

  Run: `mavis` 工具 `session messages --session-id <目标会话>`（或 `session list` 观察 updatedAt）
  Expected: 目标会话出现该指令。

- [ ] **Step 3: 若投递失败，按降级链修正**

  若 boss agent 拿不到 `mavis` 工具：把 `BossBridge` 的投递跳改由默认 agent 承担（规格 §3.3 降级），重跑 Step 1–2。

- [ ] **Step 4: 记录实测结论**

  在最终汇报中写明：实际生效的是首选路径还是降级路径。

- [ ] **Step 5: Commit**

```bash
git add miniapps/mimic-tear
git commit -m "fix(mimic-tear): 派工链路实测修正"
```

---

## 执行顺序

`Task 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12`

Task 2/3/4/5 彼此独立，可并行推进；Task 6 依赖 2/3/4/5；Task 7 依赖 6 的接口；Task 8 依赖 6/7；Task 9 依赖 8 的接口；Task 10 依赖 1–9；Task 11 独立于 1–10；Task 12 依赖 10。

**统一验证命令**：`node --test tests/`
