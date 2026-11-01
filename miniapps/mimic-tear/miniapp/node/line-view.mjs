/**
 * 线（Line）：一个管辖项目，加两样东西——大哥在这条线上的作为，和待你决策的事。
 *
 * ## 为什么要有「线」这一层
 *
 * 板面原来按**项目**组织，于是「我的大哥在管什么、哪条线卡住了」这两个问题没有地方问：
 * 一张十五行的项目表回答不了「我该看哪一行」。
 *
 * 文章 §8.2 说「以聊天窗口为中心的交互一定程度上是路径依赖的结果」，§2 说
 * 「Session 应当是系统的实现细节，而不应是用户的认知负担」。落到板面上就是一句话：
 * **上面那层该是「我的一个大哥 + 几条线 + 几件等我拍板」，不是一列项目。**
 *
 * ## 线的定义（已拍板，不要改）
 *
 * **线 = 一个管辖项目**（与 Thread 一一对应：每条线最多一个投递口）。
 *
 * - 不是「一次派工」——那会让同一个项目重复出现。
 * - 不是「跨项目目标」——我们没有「目标」这个实体，硬造会多一份真相。
 *
 * ## 下一步是推导出来的，不是生成的
 *
 * `nextStep` 给人看，但它**不能由模型现编**——那会变成一句每次都不一样的话。
 * 固定优先级推导，同样的状态永远给同样的答案。
 */

/**
 * @typedef {{
 *   projectName:string,
 *   projectId:number|string|null,
 *   health:string|null,
 *   thread:{ownerSessionId:string, active:boolean}|null,
 *   actions:Array<{id:string, title:string, severity:string, at:number|null}>,
 *   pending:Array<{id:string, title:string, severity:string}>,
 *   progress:{goalsActive:number, goalsTotal:number, tasksDone:number, tasksTotal:number},
 *   waitingOnYou:boolean,
 *   lastActivityAt:number|null,
 *   nextStep:string,
 * }} Line
 */

/**
 * 下一步：固定优先级。
 *
 * ① 在等你 → 「等你拍板」 ② 有中断的会话 → 「恢复这条线」
 * ③ 有在跑的 Goal → 「等它跑完」 ④ 其它 → 「暂无待办」
 *
 * @param {{pending:Array<any>, erroredSessions?:number, goals?:Array<any>}} input
 * @returns {string}
 */
export function deriveNextStep(input) {
  const pending = Array.isArray(input?.pending) ? input.pending : [];
  const goals = Array.isArray(input?.goals) ? input.goals : [];
  if (pending.length > 0) return '等你拍板';
  if (Number(input?.erroredSessions ?? 0) > 0) return '恢复这条线';
  if (goals.some((goal) => goal?.status === 'active')) return '等它跑完';
  return '暂无待办';
}

/**
 * 把总览的原始数据算成「线」。
 *
 * **只算管辖名单里的项目。** 名单外的项目不是「少了一条线」，是**不是大哥的活**——
 * 它们仍在板面的项目台账里（下钻层），但不该出现在「我的大哥在管什么」这一段。
 *
 * @param {{
 *   cards?:Array<any>,
 *   attention?:Array<any>,
 *   findings?:Array<any>,
 *   threads?:Array<any>,
 *   managedNames?:Iterable<string>|null,
 * }} input
 * @returns {Line[]}
 */
export function buildLines(input = {}) {
  const managed = new Set(
    input?.managedNames instanceof Set
      ? [...input.managedNames]
      : [...(input?.managedNames ?? [])].map((name) => String(name)),
  );
  const attention = Array.isArray(input?.attention) ? input.attention : [];
  const findings = Array.isArray(input?.findings) ? input.findings : [];
  const threads = Array.isArray(input?.threads) ? input.threads : [];

  /** @type {Map<string, any>} */
  const threadByProject = new Map();
  for (const thread of threads) {
    if (!thread?.projectName) continue;
    threadByProject.set(String(thread.projectName), thread);
  }

  const lines = [];
  for (const card of input?.cards ?? []) {
    const name = String(card?.name ?? '');
    if (!name || !managed.has(name)) continue;

    const pending = attention
      .filter((item) => item?.projectName === name)
      .map((item) => ({ id: item.id, title: item.title, severity: item.severity }));
    const actions = findings
      .filter((finding) => finding?.projectName === name)
      .slice()
      // 「最近动作」要真的是最近的：按时间倒序，不靠账本里的存放顺序。
      .sort((a, b) => (Number(b?.createdAt ?? 0) - Number(a?.createdAt ?? 0)))
      .slice(0, 5)
      .map((finding) => ({
        id: finding.id,
        title: finding.title,
        severity: finding.severity,
        at: finding.createdAt ?? null,
      }));

    const goals = Array.isArray(card?.goals) ? card.goals : [];
    const tasks = Array.isArray(card?.planTasks) ? card.planTasks : [];
    const thread = threadByProject.get(name) ?? null;

    lines.push({
      projectName: name,
      projectId: card?.id ?? null,
      health: card?.health ?? null,
      thread: thread && thread.ownerSessionId
        ? { ownerSessionId: String(thread.ownerSessionId), active: thread.active !== false }
        : null,
      actions,
      pending,
      progress: {
        goalsActive: goals.filter((goal) => goal?.status === 'active').length,
        goalsTotal: goals.length,
        tasksDone: tasks.filter((task) => task?.state === 'done').length,
        tasksTotal: tasks.length,
      },
      waitingOnYou: pending.length > 0,
      lastActivityAt: actions[0]?.at ?? card?.lastActivityAt ?? null,
      nextStep: deriveNextStep({
        pending,
        erroredSessions: card?.erroredSessions ?? 0,
        goals,
      }),
    });
  }

  // 在等你的线排前面——那是用户最该先看的一行。
  lines.sort((a, b) => {
    if (a.waitingOnYou !== b.waitingOnYou) return a.waitingOnYou ? -1 : 1;
    return a.projectName.localeCompare(b.projectName);
  });
  return lines;
}
