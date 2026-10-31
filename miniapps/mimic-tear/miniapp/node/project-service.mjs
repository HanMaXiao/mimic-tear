/**
 * Mini App 唯一的领域服务。
 *
 * 所有读都在这里聚合运行时状态，所有写都从这里出去。Host 的路由（HTTP、MCP、后台刷新）
 * 全都调它，所以业务上的写只有一处会被校验、提交、然后交回去广播。
 *
 * 这个文件本身是**编排**：它读什么、写到哪儿、什么时候广播。判断都在拆出去的纯函数模块
 * 里：
 *
 * - `dispatch-flow.mjs` —— 派工写路径上的校验与载荷
 * - `inbox-assembly.mjs` —— 收件箱在服务层的装配
 * - `patrol-run.mjs` —— 一轮巡检里的纯计算
 * - `duty-status.mjs` / `inbox-builder.mjs` —— 值班状态与收件箱口径
 *
 * 写路径的顺序是：校验 → 提交 → 广播。
 */

import { buildDutyRounds } from './duty-rounds.mjs';
import { DutyIntent } from './duty-intent.mjs';
import { ManagedProjects } from './managed-projects.mjs';
import { SkillLibraryStore } from './skill-library.mjs';
import { readAlerts } from './watchdog-alerts.mjs';

import { DomainError } from './domain-error.mjs';
import {
  buildDispatchPayload,
  buildDispatchRecord,
  dispatchResult,
  validateDispatchRequest,
} from './dispatch-flow.mjs';
import {
  buildDutyStatus,
  resolveDutyIntervals,
  withDutyCards,
} from './duty-status.mjs';
import { assembleInbox, buildPatrolInboxItems } from './inbox-assembly.mjs';
import { buildInbox, buildKpi, selectAttentionItems } from './inbox-builder.mjs';
import { buildLines } from './line-view.mjs';
import { ThreadSubscriptions } from './thread-subscriptions.mjs';
import { buildOrgTree } from './org-tree.mjs';
import { buildPatrolFindings, resolvePatrolProposals } from './patrol-run.mjs';
import { buildPatrolBrief, parsePatrolReport } from './patrol-report.mjs';
import { buildProjectCards } from './project-cards.mjs';
import { DEFAULT_DESK_LIMIT } from './patrol-rules.mjs';
import { isInternalWorkspace, splitVisibleProjects } from './project-scope.mjs';
import { normalizeConclusionSource } from './conclusion-source.mjs';

export { DomainError };
export { isInternalWorkspace };

/** 技能库多久重扫一次，这样新装上的技能才能露出来。 */
const SKILL_REFRESH_MS = 10 * 60 * 1000;

/**
 * 桌面上界的兜底值：读不到 `patrol-config.json` 时用它。
 *
 * 它是**兜底**，不是「收件箱就这么大」——运行时原始项（会话异常等）不受它约束。
 */
const DEFAULT_ATTENTION_LIMIT = 20;

/**
 * Mini App 唯一的领域服务。
 *
 * 每个读都聚合运行时状态；每个写都走这个类。Host 的路由（HTTP、MCP、后台刷新）全都调它，
 * 所以业务上的一次改动只有一处会被校验、提交、然后交回去广播。
 */
export class ProjectService {
  /**
   * @param {{
   *   store: import('./runtime-store.mjs').RuntimeStore,
   *   readPlan: (dir: string) => Promise<any>,
   *   skills: { skills: any[], failures: any[] },
   *   domains: any[],
   *   persistence: import('./persistence.mjs').Persistence,
   *   boss: { dispatch: (input: any) => Promise<any>, patrol: (input: any) => Promise<any> },
   *   patrol?: import('./patrol-store.mjs').PatrolStore,
   *   dutyIntent?: import('./duty-intent.mjs').DutyIntent,
   *   managed?: import('./managed-projects.mjs').ManagedProjects,
   *   skillLibrary?: import('./skill-library.mjs').SkillLibraryStore,
   *   refreshSkills?: () => Promise<{ skills: any[], failures: any[] }>,
   * }} deps
   */
  constructor(deps) {
    this.store = deps.store;
    this.readPlan = deps.readPlan;
    this.skillScan = deps.skills;
    this.domains = deps.domains;
    this.persistence = deps.persistence;
    this.boss = deps.boss;
    this.patrol = deps.patrol ?? null;
    // 值班意图与管辖名单住在值班配置同一个目录里，所以是就近找到的，而不是注入两遍。
    const sharedDir = deps.patrol?.dataDir ?? deps.dutyIntent?.dataDir ?? null;
    this.dutyIntent = deps.dutyIntent ?? (sharedDir ? new DutyIntent(sharedDir) : null);
    this.managed = deps.managed ?? (sharedDir ? new ManagedProjects(sharedDir) : null);
    // 可复用技能登记表住在它们旁边，同理：大哥从 CLI 写它，看板读它，两边必须看同一个文件。
    this.skillLibrary = deps.skillLibrary ?? (sharedDir ? new SkillLibraryStore(sharedDir) : null);
    this.refreshSkills = deps.refreshSkills ?? null;
    this.skillsScannedAt = Date.now();

    /** 聚合结果缓存，靠运行时版本号失效。 */
    this.cache = null;
  }

  /**
   * 值班状态：事实、已经做出的决定，以及大哥在看哪些项目。
   *
   * 值班意图刻意不算进运行时版本：用户让大哥去休息，必须立刻看到看板变化，不能等一个
   * 无关的会话事件。所以值班状态每次都是现读，出站时盖到卡片上——缓存还是缓存。
   *
   * @param {{config?:any, findings?:any[], dismissed?:any[]}} [input]
   * @returns {Promise<any>}
   */
  async dutyBlock(input = {}) {
    const [intent, managedEntries] = await Promise.all([
      this.dutyIntent ? this.dutyIntent.read() : null,
      this.managed ? this.managed.list() : [],
    ]);
    const watching = new Set(managedEntries.map((entry) => entry.name));
    const duty = buildDutyStatus({
      config: input.config ?? await this.getPatrolConfig(),
      findings: input.findings ?? [],
      dismissed: input.dismissed ?? [],
      intent,
      now: Date.now(),
    });
    // 值班心跳自己的状态：宿主的 cron 链是不是断了，以及心跳是不是补了一个没人建的槽位。
    // 这是一个新字段——看板会显示，客户端不用改。
    // 心跳自己的状态文件，不是运行时数据库。看板每几秒轮询一次总览，那里读运行时失败会
    // 变成每次轮询都冒一条数据告警；心跳五分钟一跳，本来就是合适的节奏，而且它会把自己
    // 看到的东西写下来。
    const { getDutyHeartbeatStatus } = await import('./duty-heartbeat.mjs');
    const heartbeat = await getDutyHeartbeatStatus({
      dataDir: this.patrol?.dataDir ?? null,
    });

    return { ...duty, watching: [...watching], heartbeat };
  }

  /**
   * 现在的值班意图——大哥被交代做什么、谁交代的。
   *
   * @returns {Promise<{ intent: any, duty: any }>}
   */
  async getDutyIntent() {
    const [intent, duty] = await Promise.all([
      this.dutyIntent ? this.dutyIntent.read() : null,
      this.dutyBlock(),
    ]);
    return { intent, duty };
  }

  /**
   * 记下关于大哥值班的那个决定。
   *
   * 「休息」是一个带理由的决定，不是 somebody 拨过的开关：意图里留着谁提的、从什么时候
   * 开始，所以看板能说清楚大哥为什么不在岗。
   *
   * @param {{mode?:string, requestedBy?:string, note?:string}} input
   * @returns {Promise<{ intent: any, duty: any }>}
   */
  async setDutyIntent(input = {}) {
    if (!this.dutyIntent) {
      throw new DomainError('duty_intent_unavailable', '当前运行时没有值班意图通道', 501);
    }
    const mode = input?.mode === 'resting' ? 'resting' : 'on-duty';
    const requestedBy = typeof input?.requestedBy === 'string' && input.requestedBy.trim()
      ? input.requestedBy.trim()
      : null;
    const note = typeof input?.note === 'string' ? input.note : '';
    const intent = await this.dutyIntent.setMode(mode, { requestedBy, note });
    return { intent, duty: await this.dutyBlock() };
  }

  /**
   * 大哥主动巡检的设置。
   * @returns {Promise<any>}
   */
  async getPatrolConfig() {
    if (!this.patrol) {
      // 兜底值跟值班状态读的是同一份常量：两边各写一份，看板就会拿看板的间隔去算大哥
      // 的掉线阈值。
      const intervals = resolveDutyIntervals(null);
      return {
        enabled: false,
        intervalMinutes: intervals.intervalMinutes,
        dutyIntervalMinutes: intervals.dutyIntervalMinutes,
        deskLimit: DEFAULT_DESK_LIMIT,
        lastRunAt: null,
        lastBoardPatrolAt: null,
        lastSignature: null,
      };
    }
    return this.patrol.getConfig();
  }

  /**
   * 值班轮次，按对话分组。
   *
   * 值班大哥跑在它自己的 cron 会话上，所以 Host 的聊天侧边栏（只显示一个会话）永远看不到
   * 这些轮次。用户想看的就是这些轮次。
   *
   * @param {{ limit?:number }} [options]
   * @returns {Promise<import('./duty-rounds.mjs').DutyRound[]>}
   */
  async getDutyRounds(options = {}) {
    if (!this.patrol) return [];
    const findings = await this.patrol.list();
    return buildDutyRounds(findings, { limit: options.limit ?? 20 });
  }

  /**
   * 看门狗的告警日志——关掉看板也能活下来的那条通道。
   *
   * 文件不管通知有没有送到都会写，所以它是「没人看着的时候看门狗看到了什么」的唯一记录。
   * 看板把它读回来，显示最近几条。
   *
   * @param {{ limit?:number }} [options]
   * @returns {Promise<{ alerts: import('./watchdog-alerts.mjs').AlertRecord[] }>}
   */
  async getWatchdogAlerts(options = {}) {
    const dir = this.patrol?.dataDir ?? null;
    if (!dir) return { alerts: [] };
    return { alerts: await readAlerts(dir, options.limit ?? 20) };
  }

  /**
   * 大哥的对话，从运行时读回来。
   *
   * 记录是 Host 的，不是 Mini App 的：同一个会话既出现在 Host 聊天侧边栏，也出现在这里。
   * 把它读回来，就是 Mini App 能显示侧边栏里说了什么——也是刷新页面之后对话还在的原因。
   *
   * @returns {Promise<Array<{id:string, role:string, text:string, source:string, createdAt:number}>>}
   */
  async getChatHistory() {
    const stored = await this.persistence.getBossSession();
    if (!stored?.sessionId) return [];
    const messages = this.store.listSessionMessages(stored.sessionId);
    // 大哥自己那半边才是有意思的；用户那半边已经在屏幕上了。
    return messages;
  }

  /**
   * 大哥的会话里有多少条消息。
   *
   * 这个计数是便宜的变更检测器：它动了，就是有人说了话——在 Mini App 里，或者在 Host
   * 聊天侧边栏里。
   *
   * @returns {Promise<number>}
   */
  async getChatMessageCount() {
    const stored = await this.persistence.getBossSession();
    if (!stored?.sessionId) return 0;
    return this.store.countSessionMessages(stored.sessionId);
  }

  /**
   * 改大哥主动巡检的设置。
   * @param {{ enabled?: boolean, intervalMinutes?: number }} patch
   */
  async setPatrolConfig(patch) {
    if (!this.patrol) {
      throw new DomainError('patrol_unavailable', '当前部署不支持主动巡检', 501);
    }
    return this.patrol.setConfig(patch ?? {});
  }

  /**
   * 跑一轮主动巡检，把大哥发现的东西记下来。
   *
   * 事实由看板提供，判断由大哥提供。结论会落盘，所以板面关着时跑过的那一轮，重新打开
   * 还能看见。
   */
  async runPatrol() {
    if (!this.patrol) {
      throw new DomainError('patrol_unavailable', '当前部署不支持主动巡检', 501);
    }

    const snapshot = await this.snapshot();
    const brief = buildPatrolBrief(snapshot);

    // 每轮唯一，所以重复跑一轮不会重复投递同一个提案。
    this.patrolRunKey = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    const outcome = await this.boss.patrol({ brief });

    const report = parsePatrolReport(outcome.text);
    const findings = buildPatrolFindings(
      report,
      snapshot.cards,
      outcome.text || outcome.error || '本轮巡检没有产生结论。',
    );

    const created = [];
    // 入账被拒的结论（例如正文超了带宽上限）要**单独报出来**，不能悄悄少记一条——
    // 大哥得知道自己写的东西没进来。
    const rejected = [];
    for (const finding of findings) {
      // 看板自己的巡检循环。结论的来源在这里写下来，所以收件箱能把看板的产出和值班大哥的
      // 结论分开。
      try {
        created.push(await this.patrol.add({ ...finding, source: 'board' }));
      } catch (error) {
        rejected.push({
          projectName: finding?.projectName ?? null,
          severity: finding?.severity ?? null,
          title: finding?.title ?? null,
          error: error?.message ?? String(error),
        });
      }
    }

    // 大哥提建议，看板负责派工。要不要提建议是大哥自己的判断——没有一个开关能决定派不
    // 派工。提案走的是跟手动派工同一条被校验过的路径，所以大哥报错了项目或会话，会在这里
    // 被挡下来，而不是照样投出去。
    const executed = [];
    for (const { index, proposal, card, error } of resolvePatrolProposals(report, snapshot.cards)) {
      if (!card) {
        executed.push({ proposal, ok: false, error });
        continue;
      }
      try {
        const { record } = await this.prepareDispatch({
          projectId: card.id,
          sessionId: proposal.sessionId,
          instruction: proposal.instruction,
          idempotencyKey: `patrol:${this.patrolRunKey}:${index}`,
        });
        const result = await this.runDispatch(record);
        executed.push({ proposal, ok: result.delivered, error: result.error });
      } catch (error) {
        executed.push({ proposal, ok: false, error: error?.message ?? String(error) });
      }
    }

    // 看板自己的巡检戳。刻意**不是** lastRunAt：那一个的意思是「值班大哥交班了」，看板
    // 自己触发的巡检绝不能刷新它——否则大哥明明掉线了，看板上还会再显示一个阈值窗口的
    // 「值班中」。
    await this.patrol.setConfig({
      lastBoardPatrolAt: Date.now(),
      lastSignature: this.inboxSignature(snapshot),
    });

    return {
      runAt: Date.now(),
      conclusion: report.conclusion,
      dispatches: report.dispatches,
      proposals: report.proposals,
      executed,
      findings: created,
      rejected,
      error: outcome.error,
    };
  }

  /**
   * 与大哥的一轮对话。
   *
   * 这是看板的正门：用户跟大哥说话的方式跟跟别的 agent 说话一样。这一轮跑在大哥自己的会话
   * 上，所以对话和值班轮次共享同一份记忆——「我能看到大哥在干什么」这句话才是真的。
   *
   * @param {string} text
   * @param {(event: any) => void} [onEvent] 接收运行时的运行事件
   * @returns {Promise<any>}
   */
  async chat(text, onEvent) {
    if (!this.boss) {
      throw new DomainError('chat_unavailable', '当前运行时未开放 agent 能力，无法对话', 501);
    }
    const outcome = await this.boss.chat({ text }, onEvent);
    this.cache = null;
    return outcome;
  }

  /**
   * 回答大哥停下来问的问题，然后让它把这一轮接着说完。
   *
   * @param {{ requestId: string, answers: any[], sessionId?: string }} input
   * @param {(event: any) => void} [onEvent]
   * @returns {Promise<any>}
   */
  async answerChatQuestion(input, onEvent) {
    if (!this.boss) {
      throw new DomainError('chat_unavailable', '当前运行时未开放 agent 能力，无法对话', 501);
    }
    const outcome = await this.boss.answerQuestion(input, onEvent);
    this.cache = null;
    return outcome;
  }

  /**
   * 与决策相关的状态的一个廉价签名，用来判断一轮巡检有没有新东西可看。
   * @param {any} [snapshot]
   */
  inboxSignature(snapshot) {
    const state = snapshot ?? this.cache;
    if (!state) return 'empty';
    return JSON.stringify(state.inbox.map((item) => [item.id, item.severity, item.title]));
  }

  /**
   * 总览要的一切：KPI、项目卡、需关注的列表。
   * @returns {Promise<import('./view-model.mjs').Overview>}
   */
  async getOverview() {
    const snapshot = await this.snapshot();
    const inbox = await this.collectInbox(snapshot);
    const patrolConfig = await this.getPatrolConfig();
    const findings = this.patrol ? await this.patrol.list() : [];
    const dismissed = await this.persistence.listDismissed();
    const duty = await this.dutyBlock({ config: patrolConfig, findings, dismissed });
    // 告警日志跟着值班状态一起走：总览上的一行就能说清楚「大哥在 03:20 不说话了」，不用
    // 用户去翻日志。
    const alerts = await this.getWatchdogAlerts({ limit: 3 });
    const attention = selectAttentionItems(inbox);
    // 线：管辖名单里的每个项目一条线 —— 「我的大哥在管什么、哪条线卡住了」的答案。
    // 名单外的项目**不是**线（那是大哥管不了的活），但它们仍在板面的项目台账里（下钻层）。
    const threads = this.dutyIntent?.dataDir
      ? await new ThreadSubscriptions(this.dutyIntent.dataDir).list()
      : [];
    return {
      generatedAt: Date.now(),
      kpi: buildKpi(snapshot.cards, inbox),
      // 卡片带着值班状态：一个项目要说清楚大哥看不看它，以及大哥到底在不在岗。
      projects: withDutyCards(snapshot.cards, duty, duty.watching),
      // 已确认的条目是已知的事：在这儿显示会让计数跟 KPI 和收件箱角标对不上。
      // 判定跟 KPI 用的是同一个函数，所以这两个数永远一致。
      attention,
      // 桌面上界的**结构性保证**：大哥自己的结论不超过这么多条（Phase 4 的 deskLimit）。
      // 运行时原始项（会话异常等）**不受它约束** —— 那是运行时的事实，大哥管不了。
      attentionLimit: Number(patrolConfig?.deskLimit) > 0
        ? Number(patrolConfig.deskLimit)
        : DEFAULT_ATTENTION_LIMIT,
      lines: buildLines({
        cards: snapshot.cards,
        attention,
        findings,
        threads,
        managedNames: duty.watching,
      }),
      internalProjectCount: snapshot.internalProjectCount,
      dataWarning: snapshot.dataWarning,
      // 大哥在不在岗、上次什么时候报的、有没有不说话了。
      duty: { ...duty, alerts: alerts.alerts },
    };
  }

  /**
   * 决策收件箱：运行时原始项，加上大哥巡检发现的东西。
   *
   * 总览和收件箱页必须读同一份列表，否则角标上的计数和页面内容会互相打架。
   *
   * @param {any} snapshot
   * @returns {Promise<any[]>}
   */
  async collectInbox(snapshot) {
    const patrolItems = this.patrol
      ? buildPatrolInboxItems(await this.patrol.list())
      : [];

    // 一张待答的问卷带着它可回答的形状，外加大哥已经做过的决定，所以页面能给出「按大哥的
    // 选择回答」，而不是只弹一个 toast。
    const answered = this.patrol ? await this.patrol.listAnswered() : [];

    return assembleInbox(snapshot.inbox, patrolItems, answered);
  }

  /**
   * 决策收件箱。
   * @returns {Promise<{ items: any[] }>}
   */
  async getInbox() {
    const snapshot = await this.snapshot();
    return { items: await this.collectInbox(snapshot) };
  }

  /**
   * 还在等回答的卡，按会话归拢。
   *
   * 这是「会话实况」页标「等回答」的**权威来源**，不是辅助信息：
   * 宿主的事件流只覆盖订阅之后新起的提问（页面一重载就断），而运行时里的待答卡
   * 是持久状态——订阅之前挂着的卡、页面关着时挂上的卡，都在这儿。
   *
   * @returns {{ asks: Array<{id:string, sessionId:string, createdAt:number}> }}
   */
  getPendingAsks() {
    const asks = this.store
      .listQuestionnaires(true)
      .filter((entry) => typeof entry.sessionId === 'string' && entry.sessionId.length > 0)
      .map((entry) => ({ id: entry.id, sessionId: entry.sessionId, createdAt: entry.createdAt }));
    return { asks };
  }

  /** @returns {Promise<{ projects: any[] }>} */
  async getProjects() {
    const snapshot = await this.snapshot();
    const duty = await this.dutyBlock();
    return { projects: withDutyCards(snapshot.cards, duty, duty.watching) };
  }

  /**
   * 一个项目的完整明细：组织树、Goal、问卷、任务与计划。
   * @param {number} id
   * @returns {Promise<any | null>}
   */
  async getProject(id) {
    const snapshot = await this.snapshot();
    const card = snapshot.cards.find((c) => c.id === id);
    if (!card) return null;

    const sessions = snapshot.sessions.filter((s) => s.projectId === id);
    const sessionIds = new Set(sessions.map((s) => s.id));
    const goals = snapshot.goals.filter((g) => sessionIds.has(g.sessionId));
    const questions = snapshot.questionnaires.filter((q) => sessionIds.has(q.sessionId));
    const plan = snapshot.plans.get(id) ?? null;
    const duty = await this.dutyBlock();

    return {
      project: withDutyCards([card], duty, duty.watching)[0],
      orgTree: buildOrgTree(sessions),
      goals,
      questions,
      tasks: snapshot.tasks.filter((t) => sessionIds.has(t.ownerSessionId)),
      plan,
      duty,
    };
  }

  /**
   * 能力库：大哥知道什么、能安排什么。
   *
   * 扫描会定期刷新——开机时拍的那张快照永远不会显示后来装上的技能，而大哥的知识恰恰就是
   * 装一个技能会变的东西。
   *
   * @returns {Promise<{ groups: any[], unmapped: any[], total: number, failures: number, scannedAt: number }>}
   */
  async getSkills() {
    const { classify } = await import('./skill-catalog.mjs');
    await this.#refreshSkillsIfStale();
    const { groups, unmapped } = classify(this.skillScan.skills, this.domains);
    return {
      groups,
      unmapped,
      total: this.skillScan.skills.length,
      failures: this.skillScan.failures.length,
      scannedAt: this.skillsScannedAt,
    };
  }

  /**
   * 可复用技能登记表：大哥打包过的那些技能，以及它们现在怎么样。
   *
   * 这是一个读。校验（技能文件还在吗、还带着登记时的名字吗）是一次写，所以它跑在大哥
   * 自己的计划任务上（CLI），而不是页面加载时——一个会改东西的 GET 会让「板面开着」变成
   * 登记表变动的原因。
   *
   * @returns {Promise<{
   *   entries: any[], stats: any, domains: string[],
   *   dispatchable: any[], stale: any[], retired: any[], updatedAt: number,
   * }>}
   */
  async getSkillLibrary() {
    if (!this.skillLibrary) {
      return { entries: [], stats: { total: 0, active: 0, stale: 0, retired: 0, domains: [] }, domains: [], dispatchable: [], stale: [], retired: [], updatedAt: 0 };
    }

    const library = await this.skillLibrary.read();
    const entries = library.entries;
    const stats = await this.skillLibrary.stats();

    return {
      entries,
      stats,
      domains: stats.domains,
      dispatchable: entries.filter((entry) => entry.status === 'active'),
      stale: entries.filter((entry) => entry.status === 'stale'),
      retired: entries.filter((entry) => entry.status === 'retired'),
      updatedAt: library.updatedAt,
    };
  }

  /**
   * 快照比刷新窗口还旧的时候，重扫技能库。
   */
  async #refreshSkillsIfStale() {
    if (!this.refreshSkills) return;
    const age = Date.now() - (this.skillsScannedAt ?? 0);
    if (age < SKILL_REFRESH_MS) return;
    this.skillScan = await this.refreshSkills();
    this.skillsScannedAt = Date.now();
  }

  /**
   * 确认一个收件箱条目，让它不再算作待决策。
   * @param {string} itemId
   * @returns {Promise<{ ok: boolean }>}
   */
  async ack(itemId) {
    if (!itemId || typeof itemId !== 'string') {
      throw new DomainError('invalid_item_id', '缺少收件箱条目 ID');
    }
    if (itemId.startsWith('patrol:')) {
      if (!this.patrol) {
        throw new DomainError('patrol_unavailable', '当前部署不支持主动巡检', 501);
      }
      const found = await this.patrol.ack(itemId.slice('patrol:'.length));
      this.cache = null;
      return { ok: found };
    }
    await this.persistence.addAck(itemId);
    this.cache = null;
    return { ok: true };
  }

  /**
   * 给一个项目下指令。
   *
   * 幂等键让重复提交变成空操作：同一个键不会两次到达目标会话。
   *
   * @param {{ projectId:number, sessionId:string|null, instruction:string, idempotencyKey:string }} input
   * @returns {Promise<any>}
   */
  async dispatch(input) {
    const { record, duplicate } = await this.prepareDispatch(input);
    if (duplicate) {
      return dispatchResult(record, { duplicate: true });
    }
    return this.runDispatch(record);
  }

  /**
   * 校验一次派工，把它记成 `queued`，但还不联系大哥。
   *
   * 把准备和执行拆开，页面才能立刻拿到 id，然后用 SSE 盯着结果，而不是让一个 HTTP 请求挂
   * 住一整个 agent 轮次。
   *
   * @param {{ projectId:number, sessionId:string|null, instruction:string, idempotencyKey:string }} input
   * @returns {Promise<{ record: any, duplicate: boolean }>}
   */
  async prepareDispatch(input) {
    const { projectId, instruction, idempotencyKey } = validateDispatchRequest(input);

    const existing = await this.persistence.findDispatchByKey(idempotencyKey);
    if (existing) return { record: existing, duplicate: true };

    const snapshot = await this.snapshot();
    const card = snapshot.cards.find((c) => c.id === projectId);
    if (!card) {
      throw new DomainError('unknown_project', '项目不存在或不可见', 404);
    }

    const targetSessionId = input.sessionId ?? null;
    const targetSession = targetSessionId
      ? snapshot.sessions.find((s) => s.id === targetSessionId && s.projectId === projectId)
      : null;
    if (targetSessionId && !targetSession) {
      throw new DomainError('unknown_session', '目标会话不存在或不属于该项目', 404);
    }

    const record = buildDispatchRecord({
      projectId,
      projectName: card.name,
      targetSessionId,
      instruction,
      idempotencyKey,
    });
    await this.persistence.saveDispatch(record);
    return { record, duplicate: false };
  }

  /**
   * 把一条准备好的派工交到大哥手上，并记下结果。
   * @param {any} record
   * @returns {Promise<any>}
   */
  async runDispatch(record) {
    const snapshot = await this.snapshot();
    const card = snapshot.cards.find((c) => c.id === record.projectId);
    const targetSession = record.targetSessionId
      ? snapshot.sessions.find((s) => s.id === record.targetSessionId)
      : null;

    // 这次派工命中了哪个已登记的技能。匹配是**确定性**的：同样的派工内容命中同样的
    // 技能（见 `skill-library.mjs` 里的稳定排序），不靠模型判断。
    const matched = await this.matchDispatchSkill(record);
    record.skillMatch = matched
      ? { id: matched.id, skillName: matched.skillName, score: matched.score }
      : null;

    record.status = 'running';
    record.updatedAt = Date.now();
    await this.persistence.saveDispatch(record);

    let outcome;
    try {
      outcome = await this.boss.dispatch(buildDispatchPayload(record, card, targetSession));
    } catch (error) {
      record.status = 'error';
      record.error = error?.message ?? String(error);
      record.updatedAt = Date.now();
      await this.persistence.saveDispatch(record);
      await this.#recordSkillUse(matched, false);
      return dispatchResult(record);
    }

    record.status = outcome?.delivered ? 'done' : 'error';
    record.bossSessionId = outcome?.bossSessionId ?? null;
    record.text = outcome?.text ?? '';
    record.error = outcome?.error ?? null;
    record.updatedAt = Date.now();
    await this.persistence.saveDispatch(record);
    await this.#recordSkillUse(matched, record.status === 'done');

    return dispatchResult(record);
  }

  /**
   * 派工内容命中哪个已登记的技能。
   *
   * 关键词命中就是全部依据：触发词、名字、标题、领域，谁在派工内容里出现谁就算数。
   * 命中多个时取分数最高的那个；分数一样时按技能名排（`match()` 里的排序是稳定的），
   * 所以同样的输入永远命中同样的技能。
   *
   * @param {any} record
   * @returns {Promise<any|null>}
   */
  async matchDispatchSkill(record) {
    if (!this.skillLibrary) return null;
    const text = [record?.projectName, record?.instruction].filter(Boolean).join('\n');
    if (!text.trim()) return null;
    const matches = await this.skillLibrary.match(text, { limit: 1 });
    return matches[0] ?? null;
  }

  /**
   * 记一次技能使用。
   *
   * 计数记不上**不该让派工失败**：派工本身已经完成了，技能登记表只是它的账。
   *
   * @param {any} matched
   * @param {boolean} success
   * @returns {Promise<any|null>}
   */
  async #recordSkillUse(matched, success) {
    if (!matched?.id || !this.skillLibrary) return null;
    try {
      return await this.skillLibrary.recordUse(matched.id, { success });
    } catch {
      return null;
    }
  }

  /**
   * 一条派工记录。
   * @param {string} id
   */
  async getDispatch(id) {
    const all = await this.persistence.listDispatches();
    return all.find((d) => d.id === id) ?? null;
  }

  /**
   * 派工账：两条投递路径的记录，最新的在前。
   *
   * 过去看板只看得到自己的投递——值班大哥用运行时的 `session send` 投递，什么都不写，于是
   * 两个大哥可以各讲各的，而看板毫不知情。现在两条路径写进同一本账，每条记录都标着自己的
   * 来源。
   *
   * @returns {Promise<any[]>}
   */
  async listDispatches() {
    const all = await this.persistence.listDispatches();
    const snapshot = await this.snapshot();
    const projectOfSession = new Map();
    for (const session of snapshot.sessions) {
      const card = snapshot.cards.find((c) => c.id === session.projectId);
      if (card) projectOfSession.set(session.id, card);
    }
    return all
      .map((record) => {
        const card = record.targetSessionId ? projectOfSession.get(record.targetSessionId) : null;
        return {
          ...record,
          // A record written before the field existed came from the board's dispatch
          // button: back then it was the only path that wrote dispatches.json.
          source: normalizeConclusionSource(record.source),
          // The duty path reports the session it delivered to; which project that
          // session belongs to is only knowable here, where the runtime is readable.
          projectId: record.projectId ?? card?.id ?? null,
          projectName: record.projectName ?? card?.name ?? null,
        };
      })
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  }

  /**
   * 当前快照是基于哪个运行时版本建的。
   * @returns {string}
   */
  currentRevision() {
    return this.store.revision();
  }

  /**
   * 聚合运行时状态，运行时版本没变就复用缓存。
   */
  async snapshot() {
    const revision = this.store.revision();
    if (this.cache && this.cache.revision === revision) return this.cache;

    const projects = this.store.listProjects();
    const { visible: visibleProjects, internalCount } = splitVisibleProjects(projects);
    const visibleIds = new Set(visibleProjects.map((p) => p.id));
    const allSessions = this.store.listSessions();
    const sessions = allSessions.filter((s) => visibleIds.has(s.projectId));
    const goals = this.store.listGoals();
    const questionnaires = this.store.listQuestionnaires(false);
    const tasks = this.store.listActiveTasks();

    const plans = new Map();
    await Promise.all(visibleProjects.map(async (project) => {
      try {
        plans.set(project.id, await this.readPlan(project.workspaceDir));
      } catch {
        plans.set(project.id, null);
      }
    }));

    const acks = new Set(await this.persistence.listAcks());
    // 大哥排除掉的条目，带上理由。它们离开待办列表，但理由跟着走，所以没有什么会悄悄地
    // 离开桌面。
    const dismissed = new Map(
      (await this.persistence.listDismissed()).map((entry) => [entry.id, entry.reason ?? '']),
    );
    const cards = buildProjectCards({ projects: visibleProjects, sessions, goals, questionnaires, plans });
    const inbox = buildInbox(
      { projects: visibleProjects, sessions, goals, questionnaires, plans },
      acks,
      dismissed,
    );

    this.cache = {
      revision,
      projects: visibleProjects,
      sessions,
      goals,
      questionnaires,
      tasks,
      plans,
      cards,
      inbox,
      internalProjectCount: internalCount,
      dataWarning: this.store.lastError(),
    };
    return this.cache;
  }
}
