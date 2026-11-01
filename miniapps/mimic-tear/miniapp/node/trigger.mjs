/**
 * 触发事件（Trigger）：环境里发生的事，以及**进模型之前的第一道闸**。
 *
 * ## 为什么要有 Trigger
 *
 * 大哥现在每 30 分钟醒来一次，把**全部事实**读一遍再决定干什么。问题是那批事实里
 * 绝大部分与他无关：16 个项目里他只管 1 个（管辖名单），几百条结论里绝大多数他已经报过，
 * 而收件箱里已经堆了 93 条大老板从未确认的结论（基线规格 §2.2.1）。
 *
 * 文章 §3.1 给的形状是「两级过滤」：**先用确定性代码筛掉噪音，再交给模型判断**。
 * 这一级必须是代码，不能是提示词——管辖权这件事已经用一次越权事故证明过：它不能只活在
 * 提示词里（主规格 §22.3）。
 *
 * ## Trigger 是什么
 *
 * 一条 Trigger = 「环境里发生了一件事」的最小描述：
 *
 * - `type` —— **封闭集合**。不在集合里的类型是**代码错误**，不是「以后再说」：
 *   白名单漏了新类型会**静默丢弃**事件，所以这里宁可抛异常。（F2.2）
 * - `subject` —— 主体的稳定标识（项目名 / 会话 id / 问卷 id）。
 * - `projectName` —— 归属的项目。**管辖闸就靠它**：名单外的项目，事件进不了候选。
 * - `at` —— 事情发生的时刻。
 * - `refs` —— 关联对象的 ID。这是**链式召回**的原料（文章 §3.3，Phase 3 才用上）。
 *
 * ## 两级过滤的分工
 *
 * - **本模块的 `selectTriggers`** = 程序层（Fast Path）。确定性：同样的输入永远得到同样的
 *   输出。它只认两件事：**类型在不在白名单里**、**归属的项目在不在管辖名单里**。
 * - **语义层（Slow Path）** = 模型自己判断「这条要不要动手」。留在提示词里，随时可加。
 *
 * 两级都过的才叫**候选**（candidate）。
 */

/**
 * 触发类型——**封闭集合**。
 *
 * 加新类型必须同时改这里、检测器（`trigger-source.mjs`）和白名单（`trigger-lists`）。
 * 只改检测器不改这里 → 检测器抛异常；只改白名单不改这里 → 白名单里的类型被忽略。
 * 两种都会在测试里暴露。
 *
 * @type {ReadonlyArray<string>}
 */
export const TRIGGER_TYPES = Object.freeze([
  'project-activity',
  'questionnaire-opened',
  'session-broken',
  'duty-wake',
]);

/**
 * 触发类型的中文名。给人看的。
 *
 * @type {Readonly<Record<string,string>>}
 */
export const TRIGGER_LABELS = Object.freeze({
  'project-activity': '项目有活动',
  'questionnaire-opened': '有新问卷卡',
  'session-broken': '会话中断',
  'duty-wake': '值班唤醒',
});

/**
 * 会话状态里「这活停了」的三种。
 *
 * @type {ReadonlySet<string>}
 */
export const BROKEN_SESSION_STATUSES = new Set(['error', 'interrupted', 'aborted']);

/**
 * @typedef {{
 *   id:string,
 *   type:string,
 *   source:string,
 *   subject:string,
 *   projectName:string|null,
 *   summary:string,
 *   at:number,
 *   refs:string[],
 *   severity:'low'|'medium'|'high',
 * }} Trigger
 */

/**
 * 触发事件的稳定标识。
 *
 * 同一件事、同一时刻，永远是同一个 id——这样「已报过」的判断才能落在 id 上，而不是落在
 * 一段可能改写的文字上（结论被撤回重写时，文字会变，id 不会）。
 *
 * @param {string} type
 * @param {string} subject
 * @param {number} at
 * @returns {string}
 */
export function triggerId(type, subject, at) {
  return `${type}:${subject}:${at}`;
}

/**
 * 造一条 Trigger，把形状定死。
 *
 * 未知类型**抛异常**而不是降级：这是代码错误，不是预期失败。白名单漏了新类型会静默
 * 丢事件——那种错要吵，不能被吞掉。
 *
 * @param {{type:string, source?:string, subject:string, projectName?:string|null,
 *          summary?:string, at?:number, refs?:string[], severity?:'low'|'medium'|'high'}} input
 * @returns {Trigger}
 */
export function makeTrigger(input) {
  const type = String(input?.type ?? '');
  if (!TRIGGER_TYPES.includes(type)) {
    throw new Error(`未知的触发类型「${type}」。封闭集合是：${TRIGGER_TYPES.join(' / ')}`);
  }
  const subject = String(input?.subject ?? '');
  if (!subject) throw new Error('触发事件必须有主体（subject）——没有主体的事件没法去重。');
  const at = Number(input?.at);
  const severity = input?.severity ?? 'low';
  if (!['low', 'medium', 'high'].includes(severity)) {
    throw new Error(`未知的严重度「${severity}」`);
  }
  return {
    id: triggerId(type, subject, Number.isFinite(at) ? at : 0),
    type,
    source: String(input?.source ?? 'runtime'),
    subject,
    projectName: input?.projectName ? String(input.projectName) : null,
    summary: String(input?.summary ?? ''),
    at: Number.isFinite(at) ? at : 0,
    refs: Array.isArray(input?.refs) ? input.refs.map((ref) => String(ref)) : [],
    severity,
  };
}

/**
 * 第一道闸：程序层的确定性准入。
 *
 * 两条规则，顺序固定：
 *
 * 1. **类型不在白名单里** → 丢掉。白名单是「这类事我们要不要管」的显式清单；漏加一类会
 *    静默丢弃，所以白名单的每一项都有单测守着（`tests/trigger.test.mjs`）。
 * 2. **归属的项目不在管辖名单里** → 丢掉。**这一条不可绕过**：它不依赖提示词、不依赖模型，
 *    是结构性的。名单外的事件连候选都进不去。
 *
 * 没有归属项目的事件（比如「值班唤醒」）不适用第 2 条——它不属于任何项目。
 *
 * 排序是确定的：新的在前，同一时刻按 id 排。同样的输入永远得到同样的输出——
 * **确定性是这一层唯一的性质**，它不聪明，但可靠。
 *
 * @param {Trigger[]} triggers
 * @param {{managedNames?:Iterable<string>|null, allowTypes?:Iterable<string>|null}} [options]
 * @returns {{kept:Trigger[], dropped:{total:number, byType:Record<string,number>, outOfJurisdiction:number, typeNotAllowed:number}}}
 */
export function selectTriggers(triggers, options = {}) {
  const managed = new Set(
    options?.managedNames instanceof Set
      ? [...options.managedNames]
      : [...(options?.managedNames ?? [])].map((name) => String(name)),
  );
  const allowed = options?.allowTypes
    ? new Set([...options.allowTypes].map((type) => String(type)))
    : new Set(TRIGGER_TYPES);

  const kept = [];
  const byType = {};
  let outOfJurisdiction = 0;
  let typeNotAllowed = 0;

  for (const trigger of Array.isArray(triggers) ? triggers : []) {
    if (!trigger || typeof trigger !== 'object') continue;
    if (!allowed.has(trigger.type)) {
      typeNotAllowed += 1;
      byType[trigger.type] = (byType[trigger.type] ?? 0) + 1;
      continue;
    }
    // 管辖闸。有项目归属的才查名单；无归属的（值班唤醒）不受管辖限制。
    if (trigger.projectName && !managed.has(trigger.projectName)) {
      outOfJurisdiction += 1;
      byType[trigger.type] = (byType[trigger.type] ?? 0) + 1;
      continue;
    }
    kept.push(trigger);
  }

  kept.sort((a, b) => (b.at - a.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    kept,
    dropped: {
      total: typeNotAllowed + outOfJurisdiction,
      byType,
      outOfJurisdiction,
      typeNotAllowed,
    },
  };
}

/**
 * 一条 Trigger 的人话。
 *
 * @param {Trigger} trigger
 * @returns {string}
 */
export function describeTrigger(trigger) {
  const label = TRIGGER_LABELS[trigger?.type] ?? trigger?.type ?? '未知事件';
  const where = trigger?.projectName ? `（${trigger.projectName}）` : '';
  const summary = trigger?.summary ? `：${trigger.summary}` : '';
  return `${label}${where}${summary}`;
}
