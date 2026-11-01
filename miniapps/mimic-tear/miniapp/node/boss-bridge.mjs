/**
 * The dispatch channel: how an instruction reaches a project session.
 *
 * The Mini App never writes to the runtime database. Instead it runs one agent turn and lets
 * the boss deliver the message with the runtime's own `mavis` tool (`session send`), which is
 * the supported way to put a message into a running session.
 *
 * The agent is addressed by name when the configured boss agent exists; otherwise the turn
 * falls back to the primary agent, which always has the `mavis` tool. Either way the boss
 * owns the wording and the decision about which session to target.
 */

/** Marker the boss is asked to end its reply with, so delivery can be verified. */
const DELIVERY_MARKER = '已投递';

/**
 * 把这一轮的运行选项交給宿主。
 *
 * `whenBusy` 只在**续用已有会话**时才有意义——宿主明确说它是「只在 `sessionId` 上认」的，
 * 所以新会话那一支不能带它。
 *
 * @param {{signal?:AbortSignal}} options
 * @returns {{signal?:AbortSignal}}
 */
function runOptions(options) {
  return options?.signal ? { signal: options.signal } : {};
}

export class BossBridge {
  /**
   * @param {{
   *   agent: any,
   *   persistence: { getBossSessionId: () => Promise<string|null>, setBossSessionId: (id:string)=>Promise<any> },
   *   bossAgentName?: string,
   *   onPermission?: (event:any) => Promise<'allowOnce'|'deny'>,
   * }} deps
   */
  constructor(deps) {
    this.agent = deps.agent;
    this.persistence = deps.persistence;
    this.bossAgentName = deps.bossAgentName ?? 'boss';
    this.onPermission = deps.onPermission ?? null;
  }

  /**
   * 大哥会话的 id。
   *
   * 轮次登记表用它判断「这条会话上还有没有别的轮次在跑」——**要在起轮次之前问**，
   * 因为会话正忙时的新指令走排队还是插话，取决于在跑的是什么。
   *
   * @returns {Promise<string>}
   */
  async sessionId() {
    const stored = await this.persistence.getBossSession();
    return stored?.sessionId ?? '';
  }

  /**
   * Build the instruction the boss receives.
   *
   * @param {{ projectName:string, projectPath:string, sessionId:string|null,
   *           sessionTitle:string|null, instruction:string }} input
   * @returns {string}
   */
  buildPrompt(input) {
    const target = input.sessionId
      ? `mvs 会话 ID：${input.sessionId}`
      : 'mvs 会话 ID：未指定';

    return [
      '你是「大哥」，仿身泪滴的总管，负责把大老板的指令派发给各项目的负责人会话。',
      '',
      '## 本次派工目标',
      `- 项目名称：${input.projectName}`,
      `- 项目路径：${input.projectPath}`,
      `- ${target}`,
      `- 目标会话标题：${input.sessionTitle ?? '（无）'}`,
      '',
      '## 大老板的原始指令（原样投递，不要改写内容）',
      '```text',
      input.instruction,
      '```',
      '',
      '## 执行要求',
      '1. 使用 mavis 工具的 `session send`，把上面的原始指令投递给目标会话。',
      '2. 目标会话 ID 已给出时直接使用；未给出时先用 mavis 工具 `session list` 按项目路径找到该项目下最合适的会话再投递。',
      '3. 投递后简短汇报：投给了哪个会话、投递结果如何。',
      '4. 不要自己执行这条指令的实质工作——那是目标会话的职责，你只负责送达。',
      '5. 最后一行必须是 `投递状态：已投递` 或 `投递状态：未投递`。',
    ].join('\n');
  }

  /**
   * Run one boss turn that delivers the instruction.
   *
   * @param {{ projectId:number, projectName:string, projectPath:string,
   *           sessionId:string|null, sessionTitle:string|null, instruction:string }} input
   * @param {{signal?:AbortSignal, whenBusy?:'queue'|'steer'}} [options]
   * @returns {Promise<{ bossSessionId:string, status:string, text:string,
   *                     error:string|null, delivered:boolean }>}
   */
  async dispatch(input, options = {}) {
    if (!this.agent) {
      return {
        bossSessionId: '',
        status: 'error',
        text: '',
        error: '当前运行时未开放 agent 能力，无法派工',
        delivered: false,
      };
    }

    const prompt = this.buildPrompt(input);

    const onEvent = (event) => {
      if (event?.type === 'permission.requested') {
        void this.#handlePermission(event);
      }
    };

    const { result, usedAgent } = await this.#runTurn(prompt, onEvent, options);

    const text = typeof result?.text === 'string' ? result.text : '';
    const delivered = result?.status === 'finished' && text.includes(DELIVERY_MARKER);

    if (result?.sessionId && usedAgent === 'boss') {
      await this.persistence.setBossSession({ sessionId: result.sessionId, agent: 'boss' });
    }

    return {
      bossSessionId: result?.sessionId ?? '',
      status: result?.status ?? 'error',
      text,
      error: result?.status === 'finished' ? null : (result?.error?.message ?? '大哥未完成本轮派工'),
      delivered,
      usedAgent,
    };
  }

  /**
   * Run one boss turn, with the fallback chain.
   *
   * The boss agent is preferred; if its turn fails, the primary agent takes over for that
   * one run. The fallback session is deliberately NOT persisted as the boss session —
   * persisting it would make every later dispatch run on the primary agent forever.
   *
   * @param {string} prompt
   * @param {(event: any) => void} onEvent
   * @param {{signal?:AbortSignal, whenBusy?:'queue'|'steer'}} [options]
   * @returns {Promise<{ result: any, usedAgent: 'boss'|'primary' }>}
   */
  async #runTurn(prompt, onEvent, options = {}) {
    const stored = await this.persistence.getBossSession();
    const signal = options?.signal;
    const whenBusy = options?.whenBusy;

    /** @type {any} */
    let result;
    /** @type {'boss'|'primary'} */
    let usedAgent;

    try {
      if (stored?.sessionId) {
        // A continued session keeps the agent it was created with.
        result = await this.agent.run(
          // `whenBusy` 只在续用会话时才有意义：新会话那一支不带它。
          { text: prompt, sessionId: stored.sessionId, ...(whenBusy ? { whenBusy } : {}) },
          { onEvent, ...runOptions(options) },
        );
        usedAgent = stored.agent === 'primary' ? 'primary' : 'boss';
      } else {
        const agentName = await this.#resolveAgent();
        result = await this.agent.run(
          agentName ? { text: prompt, agent: agentName } : { text: prompt },
          { onEvent, ...runOptions(options) },
        );
        usedAgent = agentName ? 'boss' : 'primary';
      }
    } catch (error) {
      result = { sessionId: stored?.sessionId ?? '', status: 'error', error: { message: error?.message ?? String(error) } };
      usedAgent = 'boss';
    }

    // 被叫停的轮次不重试——它是被大老板按停的，不是失败了。
    if (result?.status === 'error' && usedAgent === 'boss' && !signal?.aborted) {
      // The boss turn failed without delivering anything, so retrying is safe.
      try {
        result = await this.agent.run({ text: prompt }, { onEvent, ...runOptions(options) });
      } catch (error) {
        result = { sessionId: '', status: 'error', error: { message: error?.message ?? String(error) } };
      }
      usedAgent = 'primary';
      // Drop the failed boss session so the next dispatch starts a clean one.
      await this.persistence.setBossSession({ sessionId: '', agent: 'boss' });
    }

    return { result, usedAgent };
  }

  /**
   * Run one proactive patrol turn.
   *
   * Unlike a dispatch, the boss is not given an instruction to deliver — it is given the
   * facts and asked what actually needs doing. Whether a finding is worth dispatching is
   * the boss's own judgement; it must escalate the rest.
   *
   * @param {{ brief: string }} input
   * @param {{signal?:AbortSignal, whenBusy?:'queue'|'steer'}} [options]
   * @returns {Promise<{ bossSessionId: string, status: string, text: string, error: string|null }>}
   */
  async patrol(input, options = {}) {
    if (!this.agent) {
      return {
        bossSessionId: '',
        status: 'error',
        text: '',
        error: '当前运行时未开放 agent 能力，无法巡检',
      };
    }

    const prompt = this.buildPatrolPrompt(input);

    const onEvent = (event) => {
      if (event?.type === 'permission.requested') {
        void this.#handlePermission(event);
      }
    };

    const { result, usedAgent } = await this.#runTurn(prompt, onEvent, options);

    if (result?.sessionId && usedAgent === 'boss') {
      await this.persistence.setBossSession({ sessionId: result.sessionId, agent: 'boss' });
    }

    return {
      bossSessionId: result?.sessionId ?? '',
      status: result?.status ?? 'error',
      text: typeof result?.text === 'string' ? result.text : '',
      error: result?.status === 'finished' ? null : (result?.error?.message ?? '大哥未完成本轮巡检'),
      usedAgent,
    };
  }

  /**
   * One turn of conversation with the boss.
   *
   * Unlike a dispatch (the boss is told to deliver an instruction) or a patrol (the boss is
   * given facts to judge), a chat turn is simply the boss being talked to. It runs on the same
   * session as the duty rounds and the board's dispatches, so one thread holds the whole
   * story — which is the point: the user asked to be able to see what the boss is doing.
   *
   * @param {{ text: string }} input
   * @param {(event: any) => void} [onEvent] receives the runtime's run events
   * @param {{signal?:AbortSignal, whenBusy?:'queue'|'steer'}} [options]
   * @returns {Promise<{ bossSessionId:string, status:string, text:string, error:string|null,
   *                     request:any, usedAgent:string }>}
   */
  async chat(input, onEvent = () => {}, options = {}) {
    if (!this.agent) {
      return {
        bossSessionId: '',
        status: 'error',
        text: '',
        error: '当前运行时未开放 agent 能力，无法对话',
        request: null,
        usedAgent: 'boss',
      };
    }

    const text = String(input?.text ?? '').trim();
    if (!text) {
      return { bossSessionId: '', status: 'error', text: '', error: '消息不能为空', request: null, usedAgent: 'boss' };
    }

    const forward = (event) => {
      onEvent(event);
      if (event?.type === 'permission.requested') {
        void this.#handlePermission(event);
      }
    };

    const { result, usedAgent } = await this.#runTurn(text, forward, options);

    if (result?.sessionId && usedAgent === 'boss') {
      await this.persistence.setBossSession({ sessionId: result.sessionId, agent: 'boss' });
    }

    return {
      bossSessionId: result?.sessionId ?? '',
      status: result?.status ?? 'error',
      text: typeof result?.text === 'string' ? result.text : '',
      // `steered` 不是错：这条指令被正在跑的那一轮读进去了，回复由那一轮给出。
      error: result?.status === 'finished' || result?.status === 'steered'
        ? null
        : (result?.error?.message ?? '大哥没有回复'),
      // A turn that paused on a questionnaire carries it here; the page renders it and
      // continues the turn with `answer`.
      request: result?.request ?? null,
      usedAgent,
    };
  }

  /**
   * Answer a questionnaire the boss paused on and continue its turn.
   *
   * @param {{ requestId: string, answers: any[], sessionId?: string }} input
   * @param {(event: any) => void} [onEvent]
   * @returns {Promise<{ status:string, text:string, error:string|null, request:any }>}
   */
  async answerQuestion(input, onEvent = () => {}) {
    if (!this.agent) {
      return { status: 'error', text: '', error: '当前运行时未开放 agent 能力', request: null };
    }
    const sessionId = input?.sessionId || (await this.persistence.getBossSession())?.sessionId;
    if (!sessionId) {
      return { status: 'error', text: '', error: '找不到大哥的会话', request: null };
    }
    const result = await this.agent.answer(
      { sessionId, requestId: input.requestId, answers: input.answers ?? [] },
      { onEvent },
    );
    return {
      status: result?.status ?? 'error',
      text: typeof result?.text === 'string' ? result.text : '',
      error: result?.status === 'finished' ? null : (result?.error?.message ?? '大哥没有继续'),
      request: result?.request ?? null,
    };
  }

  /**
   * Build the patrol prompt.
   *
   * The boss decides for itself whether a finding is worth dispatching; there is no switch
   * that turns dispatching on or off.
   *
   * @param {{ brief: string }} input
   * @returns {string}
   */
  buildPatrolPrompt(input) {
    const dispatchRule = [
      '**该不该派工你自己判断**：对风险低、目标明确、不会改动别人成果的项，写进「我建议派工」段落，'
      + '由指挥部校验项目与会话归属后投递。没有值得派的就不要派——不要为了显得有产出而制造待办。',
      '**不要自己用 session send 投递**——所有派工都必须走指挥部，否则会绕过归属校验。',
      '**必须回问大老板**：需求变更、破坏性操作、跨项目冲突、要大额 token 的新开 Goal、连续失败 3 次以上。',
    ];

    return [
      '你是「大哥」，仿身泪滴的总管。现在是**主动巡检**：没有大老板的派工单，是你自己醒来看看有没有事需要办。',
      '',
      '## 当前事实（来自运行时，只读，勿加猜测）',
      input.brief,
      '',
      '## 你的任务',
      '1. 分清三类：真正需要大老板拍板的、你应该动手派工的、什么都不用做的。',
      '2. 不要为了显得有产出而制造待办。没有值得说的，就直说「本轮巡检没有需要大老板处理的事项」。',
      '3. 汇报要给出事实和代价，不要写「建议关注」这种空话。',
      ...dispatchRule,
      '',
      '## 输出格式（严格照此，便于机器读取）',
      '第一行：`巡检结论：<一句话>`',
      '然后是需要大老板决策的项，每行一条：',
      '`- 项目: <项目名> | 级别: high|medium|low | 摘要: <现在什么状态、卡在哪、你的建议和代价>`',
      '如果你建议派工，另起一段（项目名必须与事实清单里的完全一致）：',
      '`我建议派工：`',
      '`- 项目: <项目名> | 会话: <会话ID或"无"> | 指令: <要投递的指令原文>`',
      '最后一行：`巡检状态：已完成`',
    ].join('\n');
  }

  /**
   * The name of the agent to run, when it exists on this machine.
   * @returns {Promise<string|null>}
   */
  async #resolveAgent() {
    if (!this.bossAgentName || typeof this.agent.agents !== 'function') return null;
    try {
      const { agents } = await this.agent.agents();
      const found = (agents ?? []).some((a) => a?.name === this.bossAgentName);
      return found ? this.bossAgentName : null;
    } catch {
      return null;
    }
  }

  /**
   * Decide a tool permission request raised by the boss.
   *
   * Without a handler the request is denied, which is the safe default: a Mini App must not
   * silently grant execution rights on the user's behalf.
   */
  async #handlePermission(event) {
    let decision = 'deny';
    if (this.onPermission) {
      try {
        decision = await this.onPermission(event);
      } catch {
        decision = 'deny';
      }
    }
    try {
      await this.agent.reply({
        sessionId: event.sessionId,
        requestId: event.requestId,
        decision,
      });
    } catch {
      // The run may already have been cancelled; nothing to recover here.
    }
  }
}
