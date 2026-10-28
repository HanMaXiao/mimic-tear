/**
 * 视图模型的稳定入口。
 *
 * 这里没有任何实现，只有一排再导出。真正的规则住在按职责拆开的模块里：
 *
 * - `health-rules.mjs` —— 项目健康度的判定
 * - `project-cards.mjs` —— 总览上的项目卡
 * - `inbox-builder.mjs` —— 决策收件箱、KPI，以及收件箱条目的共享口径（严重度顺序、条目年龄、
 *   「需你处理」）
 * - `org-tree.mjs` —— 组织树的还原
 * - `duty-status.mjs` —— 值班状态与漏轮证据
 * - `patrol-report.mjs` —— 巡检简报与巡检报告的解析
 * - `questionnaire-rules.mjs` —— 问卷卡的规则（过期口径、可回答形状）
 * - `project-scope.mjs` —— 项目的可见性与命名
 * - `conclusion-source.mjs` —— 结论/派工的来源归一
 *
 * 全部是纯函数：不碰 IO、不读时钟、不改入参。所以聚合规则（健康度优先级、收件箱严重度、
 * 组织树形状）不用起运行时、不用数据库、不用文件系统就能测。
 *
 * 这个文件是**对外的稳定面**：`patrol-store.mjs`、`patrol-cli.mjs`、`watchdog-rules.mjs`、
 * `duty-heartbeat.mjs` 这些模块都从这里取函数，导出名和签名不许变。拆分的细节留在这个
 * 文件里面，别的地方不用跟着改。
 */

export { normalizeConclusionSource } from './conclusion-source.mjs';
export { isUnresolvedQuestion, questionnaireShape, questionnaireBody } from './questionnaire-rules.mjs';
export { computeHealth } from './health-rules.mjs';
export { projectName } from './project-scope.mjs';
export { buildProjectCards } from './project-cards.mjs';
export {
  buildInbox,
  buildKpi,
  sessionErrorBody,
  severityRank,
  compareBySeverity,
  sortBySeverity,
  ageMinutes,
  selectAttentionItems,
} from './inbox-builder.mjs';
export { buildOrgTree } from './org-tree.mjs';
export {
  dutyStaleAfterMinutes,
  buildDutyStatus,
  computeDutyEvidence,
  withDutyCards,
  resolveDutyIntervals,
  DEFAULT_BOARD_INTERVAL_MINUTES,
  DEFAULT_DUTY_INTERVAL_MINUTES,
} from './duty-status.mjs';
export { buildPatrolBrief, parsePatrolReport } from './patrol-report.mjs';

/**
 * @typedef {import('./health-rules.mjs').Health} Health
 * @typedef {import('./conclusion-source.mjs').ConclusionSource} ConclusionSource
 * @typedef {import('./project-cards.mjs').ProjectCard} ProjectCard
 * @typedef {import('./inbox-builder.mjs').InboxItem} InboxItem
 * @typedef {import('./inbox-builder.mjs').Kpi} Kpi
 * @typedef {import('./org-tree.mjs').OrgNode} OrgNode
 * @typedef {import('./duty-status.mjs').DutyStatus} DutyStatus
 */

/**
 * 总览页的完整载荷。
 *
 * @typedef {{
 *   generatedAt:number,
 *   kpi:import('./inbox-builder.mjs').Kpi,
 *   projects:any[],
 *   attention:import('./inbox-builder.mjs').InboxItem[],
 *   internalProjectCount:number,
 *   dataWarning:string|null,
 *   duty:any,
 * }} Overview
 */
