import test from 'node:test';
import assert from 'node:assert/strict';

import { BossBridge } from '../miniapps/mimic-tear/miniapp/node/boss-bridge.mjs';

function makeAgent(overrides = {}) {
  const calls = { run: [], reply: [] };
  return {
    calls,
    async agents() {
      return { agents: [{ name: 'boss', displayName: '大哥', primary: false }, { name: 'mavis', displayName: 'Mavis', primary: true }] };
    },
    async run(input, options) {
      calls.run.push({ input, options });
      if (options?.onEvent) {
        options.onEvent({ type: 'turn.started', sessionId: 'boss-1', turnId: 't1', model: {} });
        options.onEvent({ type: 'text.delta', sessionId: 'boss-1', turnId: 't1', text: '正在投递' });
        options.onEvent({ type: 'turn.finished', sessionId: 'boss-1', turnId: 't1', status: 'finished', text: '投递状态：已投递' });
      }
      return { sessionId: 'boss-1', status: 'finished', text: '投递状态：已投递' };
    },
    async reply(input) {
      calls.reply.push(input);
    },
    ...overrides,
  };
}

const INPUT = {
  projectId: 1,
  projectName: 'alpha',
  projectPath: 'D:/projects/alpha',
  sessionId: 'mvs_target',
  sessionTitle: 'Alpha 主会话',
  instruction: '把登录页做完备',
};

test('boss-bridge', async (t) => {
  await t.test('prompt 包含项目、目标会话与原始指令，并要求用 mavis 工具投递', () => {
    const bridge = new BossBridge({ agent: makeAgent(), persistence: makePersistence() });
    const prompt = bridge.buildPrompt(INPUT);

    assert.match(prompt, /alpha/);
    assert.match(prompt, /D:\/projects\/alpha/);
    assert.match(prompt, /mvs_target/);
    assert.match(prompt, /Alpha 主会话/);
    assert.match(prompt, /把登录页做完备/);
    assert.match(prompt, /session send/, '必须指示用 session send 投递');
    assert.match(prompt, /投递状态：已投递/, '必须要求可验证的投递标记');
  });

  await t.test('未指定目标会话时让大哥自行选择', () => {
    const bridge = new BossBridge({ agent: makeAgent(), persistence: makePersistence() });
    const prompt = bridge.buildPrompt({ ...INPUT, sessionId: null, sessionTitle: null });

    assert.match(prompt, /未指定/);
    assert.match(prompt, /session list/, '未指定时要让大哥先找会话');
  });

  await t.test('首次派工创建大哥会话并记录下来', async () => {
    const persistence = makePersistence();
    const agent = makeAgent();
    const bridge = new BossBridge({ agent, persistence });

    const result = await bridge.dispatch(INPUT);

    assert.equal(result.delivered, true);
    assert.equal(result.bossSessionId, 'boss-1');
    assert.equal(agent.calls.run.length, 1);
    assert.equal(agent.calls.run[0].input.agent, 'boss', 'boss agent 存在时应指名使用');
    assert.equal(persistence.bossSessionId, 'boss-1');
  });

  await t.test('后续派工复用同一个大哥会话', async () => {
    const persistence = makePersistence();
    persistence.bossSessionId = 'boss-existing';
    const agent = makeAgent();
    const bridge = new BossBridge({ agent, persistence });

    await bridge.dispatch(INPUT);

    assert.equal(agent.calls.run[0].input.sessionId, 'boss-existing');
    assert.equal(agent.calls.run[0].input.agent, undefined, '续用会话时不能再指定 agent');
  });

  await t.test('boss agent 不存在时回落到主 agent', async () => {
    const agent = makeAgent({
      async agents() {
        return { agents: [{ name: 'mavis', displayName: 'Mavis', primary: true }] };
      },
    });
    const bridge = new BossBridge({ agent, persistence: makePersistence() });

    await bridge.dispatch(INPUT);

    assert.equal(agent.calls.run[0].input.agent, undefined, '找不到 boss 时不指名');
    assert.ok(agent.calls.run[0].input.text.length > 0);
  });

  await t.test('agents() 抛错时同样回落到主 agent', async () => {
    const agent = makeAgent({
      async agents() {
        throw new Error('不可用');
      },
    });
    const bridge = new BossBridge({ agent, persistence: makePersistence() });

    await bridge.dispatch(INPUT);
    assert.equal(agent.calls.run[0].input.agent, undefined);
  });

  await t.test('没有 agent 能力时返回可读错误，不抛异常', async () => {
    const bridge = new BossBridge({ agent: null, persistence: makePersistence() });
    const result = await bridge.dispatch(INPUT);

    assert.equal(result.delivered, false);
    assert.match(result.error, /agent/);
  });

  await t.test('agent.run 抛错时返回错误而不是未捕获异常', async () => {
    const agent = makeAgent({
      async run() {
        throw new Error('运行时拒绝');
      },
    });
    const bridge = new BossBridge({ agent, persistence: makePersistence() });

    const result = await bridge.dispatch(INPUT);
    assert.equal(result.status, 'error');
    assert.equal(result.delivered, false);
    assert.match(result.error, /运行时拒绝/);
  });

  await t.test('回复里没有投递标记时判定为未投递', async () => {
    const agent = makeAgent({
      async run() {
        return { sessionId: 'boss-1', status: 'finished', text: '我没有投递' };
      },
    });
    const bridge = new BossBridge({ agent, persistence: makePersistence() });

    const result = await bridge.dispatch(INPUT);
    assert.equal(result.delivered, false);
    assert.equal(result.status, 'finished');
  });

  await t.test('权限请求：没有 handler 时一律拒绝', async () => {
    const agent = makeAgent({
      async run(input, options) {
        options.onEvent({
          type: 'permission.requested',
          sessionId: 'boss-1',
          requestId: 'req-1',
          toolName: 'bash',
          reason: '需要执行命令',
        });
        return { sessionId: 'boss-1', status: 'finished', text: '投递状态：已投递' };
      },
    });
    const bridge = new BossBridge({ agent, persistence: makePersistence() });

    await bridge.dispatch(INPUT);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(agent.calls.reply.length, 1);
    assert.equal(agent.calls.reply[0].decision, 'deny');
  });

  await t.test('权限请求：有 handler 时使用 handler 的决定', async () => {
    const agent = makeAgent({
      async run(input, options) {
        options.onEvent({
          type: 'permission.requested',
          sessionId: 'boss-1',
          requestId: 'req-2',
          toolName: 'bash',
          reason: '需要执行命令',
        });
        return { sessionId: 'boss-1', status: 'finished', text: '投递状态：已投递' };
      },
    });
    const bridge = new BossBridge({
      agent,
      persistence: makePersistence(),
      onPermission: async () => 'allowOnce',
    });

    await bridge.dispatch(INPUT);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(agent.calls.reply[0].decision, 'allowOnce');
  });
});

function makePersistence() {
  return {
    bossSessionId: null,
    async getBossSessionId() {
      return this.bossSessionId;
    },
    async setBossSessionId(id) {
      this.bossSessionId = id;
    },
  };
}
