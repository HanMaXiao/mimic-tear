/**
 * 收件箱在服务层的装配。
 *
 * 看板的收件箱比「运行时原始项」多两块：大哥巡检出来的结论，以及问卷的可回答形状。装配
 * 这一步以前长在 ProjectService 里，现在拆成纯函数，所以能单独测——不必起一整个运行时。
 *
 * 排序和年龄用的是 `inbox-builder.mjs` 里那一份口径：同一个收件箱，排序和「多久以前」在
 * 两个视图里必须一致。
 */

import { normalizeConclusionSource } from './conclusion-source.mjs';
import { ageMinutes, sortBySeverity } from './inbox-builder.mjs';
import { questionnaireShape } from './questionnaire-rules.mjs';

/**
 * 把大哥的巡检结论变成收件箱条目。
 *
 * @param {any[]} findings
 * @returns {any[]}
 */
export function buildPatrolInboxItems(findings) {
  return (findings ?? []).map((finding) => ({
    id: `patrol:${finding.id}`,
    kind: 'patrol',
    severity: finding.severity,
    projectId: finding.projectId ?? 0,
    projectName: finding.projectName ?? '全局',
    sessionId: null,
    sessionTitle: null,
    title: finding.title,
    body: finding.body,
    createdAt: finding.createdAt,
    ageMinutes: ageMinutes(finding.createdAt),
    acknowledged: finding.acknowledged,
    // Where the conclusion came from: the duty boss's own round, or the board's
    // patrol loop. A conclusion written before the field existed reads as 'board'.
    source: normalizeConclusionSource(finding.source),
    // 'user' = 大老板点过「标记已知」；'boss' = 大哥撤回了自己的结论（已不适用）。
    handledBy: finding.acknowledgedBy ?? null,
    handledReason: finding.note ?? '',
  }));
}

/**
 * 给问卷条目补上它的形状，以及大哥已经做过的决定。
 *
 * 有了这个形状，页面就能直接给出「按大哥的选择回答」，而不是只弹一个 toast。
 *
 * @param {any[]} items
 * @param {any[]} answered 大哥已经答过的问卷
 * @returns {any[]}
 */
export function attachQuestionnaireShapes(items, answered) {
  const answeredByRequest = new Map((answered ?? []).map((entry) => [entry.requestId, entry]));
  return (items ?? []).map((item) => {
    if (item.kind !== 'questionnaire') return item;
    const shape = questionnaireShape(item.requestJson ?? '');
    const decision = answeredByRequest.get(item.requestId);
    return {
      ...item,
      requestId: item.requestId,
      stepIds: shape.stepIds,
      options: shape.options,
      recommendation: decision
        ? {
          optionIds: decision.optionIds ?? [],
          answer: decision.answer ?? '',
          rationale: decision.rationale ?? '',
          decidedAt: decision.answeredAt,
        }
        : null,
    };
  });
}

/**
 * 装配完整的收件箱：巡检结论 + 运行时原始项，按严重度排好。
 *
 * @param {any[]} runtimeItems 运行时原始项
 * @param {any[]} patrolItems 巡检结论条目
 * @param {any[]} [answered] 大哥已经答过的问卷
 * @returns {any[]}
 */
export function assembleInbox(runtimeItems, patrolItems, answered) {
  const items = [...(patrolItems ?? []), ...(runtimeItems ?? [])];
  return sortBySeverity(attachQuestionnaireShapes(items, answered));
}
