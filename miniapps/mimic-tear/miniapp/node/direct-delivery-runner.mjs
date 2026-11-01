/**
 * 直通的一轮：认事件 → 过第一道闸 → 算归属 → 投递。
 *
 * ## 为什么要单独一个模块
 *
 * 「这一轮该往哪投」这件事有**两个调用方**：板面运行时（真的投）和诊断（只看计划）。
 * 两边各算一次就会出现两份口径——而口径分叉的后果是「板面说投了、诊断说没投」。
 * 所以**只有这一份实现**，两个调用方都走它。
 *
 * ## 为什么默认关
 *
 * 直通和大哥的值班轮次**做的是同一件事**：让项目会话拿到该干的活。两边同时开就是同一份活
 * 干两遍——而收件箱已经堆了 93 条没人看的结论了，再加一份重复的是雪上加霜。
 *
 * 所以开关 `patrol-config.json` 的 `directDelivery` **默认 false**。打开它的前提是**大哥的
 * 提示词已经改成「事件直达了，你只管没有归属的事」**——那件事和本模块一起做完，直通才成立。
 * 在那之前打开它，等于让大哥和直通各干一遍。
 */

import { detectTriggers, TRIGGER_WHITELIST } from './trigger-source.mjs';
import { selectTriggers } from './trigger.mjs';
import { resolveManagedEntries } from './managed-projects.mjs';
import { planDeliveries } from './thread.mjs';
import { deliverToThreads } from './direct-delivery.mjs';

/**
 * 认这一轮的事件，过第一道闸，算出该投给谁。
 *
 * @param {{store:any, patrol:any, managed:any, subscriptions:any, now?:number}} input
 * @returns {Promise<{candidates:any[], threads:any[], managedNames:string[],
 *                    plan:ReturnType<typeof planDeliveries>}>}
 */
export async function planRound(input) {
  const now = Number(input?.now) || Date.now();
  const store = input?.store;
  const projects = store.listProjects();
  const visibleIds = new Set(projects.map((p) => p.id));
  const sessions = store.listSessions().filter((s) => visibleIds.has(s.projectId));
  const questionnaires = store.listQuestionnaires(true);

  const projectById = new Map(projects.map((p) => [p.id, p]));
  const nameOf = (projectId) => {
    const project = projectById.get(projectId);
    return project ? project.workspaceDir.split(/[\\/]/).pop() : null;
  };

  // 管辖名单必须**对着运行时的项目集解析过**才算数：`list()` 给的是名单本身，
  // 它不知道「这条授权还落在哪个项目上」。不解析的话名单是空的，每一条项目事件都会被
  // 判成「不在管辖范围」，直通一条也投不出去（2026-11-01 上岗验收时真机抓到的）。
  // 管辖名单必须**对着运行时的项目集解析过**才算数：`list()` 给的是名单本身，
  // 它不知道「这条授权还落在哪个项目上」。不解析的话名单是空的，每一条项目事件都会被
  // 判成「不在管辖范围」，直通一条也投不出去（2026-11-01 上岗验收时真机抓到的）。
  const managedEntries = resolveManagedEntries(await input.managed.list(), store.listProjects());
  const managedNames = managedEntries
    .filter((entry) => entry.matched)
    .map((entry) => entry.projectName ?? entry.name);

  const config = await input.patrol.getConfig();
  const watermark = config.lastRunAt ?? 0;

  const rawTriggers = detectTriggers({
    projects: projects.map((project) => ({
      id: project.id,
      name: project.workspaceDir.split(/[\\/]/).pop(),
      latestActivityAt: project.latestActivityAt ?? 0,
    })),
    sessions: sessions
      .filter((session) => session.status === 'error'
        || session.status === 'interrupted'
        || session.status === 'aborted')
      .map((session) => ({
        id: session.id,
        status: session.status,
        title: session.title,
        updatedAt: session.updatedAt,
        projectName: nameOf(session.projectId),
      })),
    questionnaires: questionnaires.map((questionnaire) => ({
      // 运行时存储层的主键字段就叫 `id`（`id: row.request_id`）。**CLI 那层才把它改名成
      // `requestId`** —— 两层同名不同义，写错哪一层都会静默产出 `undefined` 的主体。
      id: questionnaire.id,
      createdAt: questionnaire.createdAt,
      question: null,
      sessionId: questionnaire.sessionId,
      projectName: null,
    })),
    watermark,
    now,
  });

  const candidates = selectTriggers(rawTriggers, {
    managedNames,
    allowTypes: TRIGGER_WHITELIST,
  });

  const subscriptions = await input.subscriptions.list();
  const threads = subscriptions.map((entry) => ({
    projectId: entry.projectId ?? null,
    projectName: entry.projectName,
    ownerSessionId: entry.ownerSessionId ?? null,
    since: entry.since ?? null,
    reason: entry.reason ?? '',
    active: entry.active !== false,
  }));

  const delivered = subscriptions.flatMap((entry) => entry.delivered ?? []);
  const plan = planDeliveries({
    triggers: candidates.kept,
    threads,
    managedNames,
    allowTypes: TRIGGER_WHITELIST,
    delivered,
  });

  return { candidates, threads, managedNames, plan };
}

/**
 * 跑一轮直通：计划 + 投递。
 *
 * @param {{store:any, patrol:any, managed:any, subscriptions:any, agent:any,
 *          now?:number, whenBusy?:'queue'|'steer'}} input
 * @returns {Promise<{plan:any, outcome:any}>}
 */
export async function runRound(input) {
  const { plan } = await planRound(input);
  const outcome = await deliverToThreads({
    agent: input?.agent,
    deliveries: plan.deliveries,
    subscriptions: input?.subscriptions,
    whenBusy: input?.whenBusy,
  });
  return { plan, outcome };
}
