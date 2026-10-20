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
   * @returns {Promise<{ bossSessionId:string, status:string, text:string,
   *                     error:string|null, delivered:boolean }>}
   */
  async dispatch(input) {
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
    const existingSessionId = await this.persistence.getBossSessionId();

    const onEvent = (event) => {
      if (event?.type === 'permission.requested') {
        void this.#handlePermission(event);
      }
    };

    /** @type {any} */
    let result;
    /** @type {'boss' | 'primary'} */
    let usedAgent = 'boss';

    try {
      if (existingSessionId) {
        result = await this.agent.run({ text: prompt, sessionId: existingSessionId }, { onEvent });
      } else {
        const agentName = await this.#resolveAgent();
        result = await this.agent.run(
          agentName ? { text: prompt, agent: agentName } : { text: prompt },
          { onEvent },
        );
        usedAgent = agentName ? 'boss' : 'primary';
      }
    } catch (error) {
      result = { sessionId: existingSessionId ?? '', status: 'error', error: { message: error?.message ?? String(error) } };
    }

    // Fallback chain: the dedicated boss agent may exist but lack the tool needed to deliver.
    // A failed turn delivered nothing, so retrying with the primary agent is safe.
    if (result?.status === 'error' && usedAgent === 'boss') {
      try {
        result = await this.agent.run({ text: prompt }, { onEvent });
        usedAgent = 'primary';
      } catch (error) {
        result = { sessionId: existingSessionId ?? '', status: 'error', error: { message: error?.message ?? String(error) } };
      }
    }

    const text = typeof result?.text === 'string' ? result.text : '';
    const delivered = result?.status === 'finished' && text.includes(DELIVERY_MARKER);

    if (result?.sessionId) {
      await this.persistence.setBossSessionId(result.sessionId);
    }

    return {
      bossSessionId: result?.sessionId ?? existingSessionId ?? '',
      status: result?.status ?? 'error',
      text,
      error: result?.status === 'finished' ? null : (result?.error?.message ?? '大哥未完成本轮派工'),
      delivered,
      usedAgent,
    };
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
