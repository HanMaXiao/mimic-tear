/**
 * 项目健康度的判定规则。
 *
 * 健康度只有一套判定：看板、CLI、测试读的都是这个函数的结果。任何地方另写一份「什么算
 * 阻塞」，看板上就会出现两个互相打架的健康度。
 */

/**
 * @typedef {'active'|'idle'|'blocked'|'error'} Health
 */

/**
 * 一个项目的健康度，由第一条命中的规则决定。
 *
 * 顺序编码的是紧急程度：报错的项目压过只是在等的项目；什么都没跑的项目是 idle，不是
 * blocked。
 *
 * @param {{ sessions: any[], pendingQuestions: number, goals: any[],
 *           planTasks: any[], activeTasks: number }} input
 * @returns {Health}
 */
export function computeHealth(input) {
  const sessions = input.sessions ?? [];
  const goals = input.goals ?? [];
  const planTasks = input.planTasks ?? [];

  if (sessions.some((s) => s.status === 'error' || s.errorCode != null)) return 'error';
  if ((input.pendingQuestions ?? 0) > 0) return 'blocked';
  if (goals.some((g) => g.status === 'paused' && g.dismissedAt == null)) return 'blocked';
  if (planTasks.some((t) => t.state === 'blocked')) return 'blocked';
  if (sessions.some((s) => s.status === 'started')) return 'active';
  if ((input.activeTasks ?? 0) > 0) return 'active';
  return 'idle';
}
