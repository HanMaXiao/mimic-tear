/**
 * 触发事件的**检测器**：从运行时快照里认出「发生了什么事」。
 *
 * ## 为什么用「水位线」而不是「上一份快照」
 *
 * 事件驱动的关键不是「记住上次看到什么」，而是「知道上次**看**到什么时候」。前者要存一份
 * 快照（会脏、会对不上），后者只要一个时间戳——而这个时间戳**已经存在**：交班戳
 * （`patrol-config.json` 的 `lastRunAt`）。上一轮交班之后发生的事，就是这一轮的事件。
 *
 * 所以这里没有新状态文件：**水位线就是交班戳**。这也顺带解决了另一个问题——大哥休息了五天，
 * 醒来时水位线还在五天前，于是那五天里发生的事**一条都不会漏**。
 *
 * ## 四类事件源
 *
 * | 类型 | 从哪来 | 怎么认 |
 * | --- | --- | --- |
 * | `duty-wake` | 这一轮本身 | 恒有一条 |
 * | `project-activity` | 项目的 `latestActivityAt` | 晚于水位线 |
 * | `questionnaire-opened` | 问卷卡的 `createdAt` | 晚于水位线 |
 * | `session-broken` | 会话的 `status` | 状态是 error/interrupted/aborted **且** 晚于水位线 |
 *
 * 检测器只认「变了什么」，不认「该不该管」——那是 `selectTriggers`（第一道闸）的事。
 * 两层分开，是为了让「过滤」这件事可以被单独测。
 */

import { BROKEN_SESSION_STATUSES, makeTrigger } from './trigger.mjs';

/**
 * 类型白名单：**这一套装置关心哪几类事件**。
 *
 * 漏加一类 = 那一类事件被**静默丢弃**，所以白名单的每一项都有单测守着（改白名单必须改测试）。
 * 默认四类全要；哪天某一类变成噪音，在这里关掉，而不是在提示词里写「别管这个」。
 *
 * @type {ReadonlyArray<string>}
 */
export const TRIGGER_WHITELIST = Object.freeze([
  'project-activity',
  'questionnaire-opened',
  'session-broken',
  'duty-wake',
]);

/**
 * 从快照里认出这一轮的事件。
 *
 * 纯函数：不碰 IO、不读时钟、不改入参。`projects` / `sessions` / `questionnaires` 都是
 * 已经解析好的行（项目名、问题正文这些都补好了），检测器只管「有没有变」。
 *
 * @param {{
 *   projects?:Array<{id?:number|string, name:string, latestActivityAt?:number}>,
 *   sessions?:Array<{id:string, status?:string, title?:string|null, updatedAt?:number, projectName?:string|null}>,
 *   questionnaires?:Array<{id:string, createdAt?:number, question?:string|null, sessionId?:string|null, projectName?:string|null}>,
 *   watermark?:number|null,
 *   now?:number,
 * }} [input]
 * @returns {import('./trigger.mjs').Trigger[]}
 */
export function detectTriggers(input = {}) {
  const projects = Array.isArray(input?.projects) ? input.projects : [];
  const sessions = Array.isArray(input?.sessions) ? input.sessions : [];
  const questionnaires = Array.isArray(input?.questionnaires) ? input.questionnaires : [];
  const watermark = Number.isFinite(Number(input?.watermark)) ? Number(input.watermark) : 0;
  const now = Number.isFinite(Number(input?.now)) ? Number(input.now) : Date.now();

  /** @type {import('./trigger.mjs').Trigger[]} */
  const triggers = [];

  // 1. 这一轮本身就是一次事件：它知道自己是被叫醒的。
  triggers.push(makeTrigger({
    type: 'duty-wake',
    source: 'duty',
    subject: 'duty',
    summary: '值班轮次醒来',
    at: now,
    severity: 'low',
  }));

  // 2. 项目有活动。
  for (const project of projects) {
    const activityAt = Number(project?.latestActivityAt ?? 0);
    if (!Number.isFinite(activityAt) || activityAt <= watermark) continue;
    triggers.push(makeTrigger({
      type: 'project-activity',
      source: 'runtime',
      subject: String(project.name),
      projectName: String(project.name),
      summary: `最近一次活动在 ${new Date(activityAt).toISOString()}`,
      at: activityAt,
      refs: [String(project.id ?? project.name)],
      severity: 'low',
    }));
  }

  // 3. 新问卷卡。
  for (const questionnaire of questionnaires) {
    const createdAt = Number(questionnaire?.createdAt ?? 0);
    if (!Number.isFinite(createdAt) || createdAt <= watermark) continue;
    const refs = [String(questionnaire.id)];
    if (questionnaire.sessionId) refs.push(String(questionnaire.sessionId));
    triggers.push(makeTrigger({
      type: 'questionnaire-opened',
      source: 'runtime',
      subject: String(questionnaire.id),
      projectName: questionnaire.projectName ?? null,
      summary: questionnaire.question ? `等人回答：${questionnaire.question}` : '等人回答',
      at: createdAt,
      refs,
      severity: 'medium',
    }));
  }

  // 4. 会话中断。状态是「停了」还不够——还得是水位线**之后**才停的，
  //    否则每轮都会把同一件旧事重新报一遍。
  for (const session of sessions) {
    if (!BROKEN_SESSION_STATUSES.has(session?.status)) continue;
    const updatedAt = Number(session?.updatedAt ?? 0);
    if (!Number.isFinite(updatedAt) || updatedAt <= watermark) continue;
    triggers.push(makeTrigger({
      type: 'session-broken',
      source: 'runtime',
      subject: String(session.id),
      projectName: session.projectName ?? null,
      summary: `${session.title ?? session.id}（${session.status}）`,
      at: updatedAt,
      refs: [String(session.id)],
      severity: 'high',
    }));
  }

  return triggers;
}
