import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { PatrolStore } from '../miniapps/mimic-tear/miniapp/node/patrol-store.mjs';
import { ProjectService } from '../miniapps/mimic-tear/miniapp/node/project-service.mjs';
import { RoundControl } from '../miniapps/mimic-tear/miniapp/node/round-control.mjs';
import { RuntimeStore } from '../miniapps/mimic-tear/miniapp/node/runtime-store.mjs';
import { makeRuntimeDb, tmpDir, cleanupDir } from './helpers/fixture.mjs';

/**
 * 等一个条件成立。
 *
 * @param {() => boolean} predicate
 * @param {string} what 说清楚在等什么
 * @returns {Promise<void>}
 */
async function waitFor(predicate, what) {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`等不到：${what}`);
}

/**
 * 一个能卡住的大哥。
 *
 * 宿主在会话正忙时的行为在这里被复刻：`whenBusy: 'steer'` 时文本被正在跑的那一轮读走，
 * 回复由那一轮给出（这一轮拿到的是空的）；否则这一轮自己回答。
 *
 * @returns {{boss:any, calls:any, gates:any}}
 */
function makeBoss() {
  const calls = { patrol: [], chat: [], dispatch: [] };
  // 每一轮各持一份释放函数——共用一个槽位的话，第二次会把第一次的覆盖掉。
  const gates = { patrol: [], chat: [] };

  const wait = (which, options) => new Promise((resolve) => {
    gates[which].push(resolve);
    options?.signal?.addEventListener('abort', () => resolve('aborted'), { once: true });
  });

  /** 放行所有卡住的轮次。 */
  const release = (which) => {
    const pending = gates[which].splice(0, gates[which].length);
    for (const resolve of pending) resolve();
  };

  const boss = {
    async sessionId() {
      return 'sess-boss';
    },
    async patrol(input, options = {}) {
      calls.patrol.push({ input, options });
      await wait('patrol', options);
      const aborted = options.signal?.aborted === true;
      return {
        bossSessionId: 'b1',
        status: aborted ? 'aborted' : 'finished',
        text: aborted ? '' : '巡检原文：alpha 有 1 项要你拍板',
        error: null,
      };
    },
    async chat(input, onEvent = () => {}, options = {}) {
      calls.chat.push({ input, options });
      if (options.whenBusy === 'steer') {
        // 插话进了正在跑的那一轮：这一轮拿到的是空的，回复由那一轮给出。
        return { bossSessionId: 'b1', status: 'steered', text: '', error: null, request: null };
      }
      await wait('chat', options);
      return { bossSessionId: 'b1', status: 'finished', text: '对话回复', error: null, request: null };
    },
    async dispatch(input, options = {}) {
      calls.dispatch.push({ input, options });
      return {
        bossSessionId: 'b1',
        status: 'finished',
        text: '投递状态：已投递',
        error: null,
        delivered: true,
      };
    },
  };

  return { boss, calls, gates, release };
}

/**
 * 一个只存派工记录的落盘层。
 */
class PersistenceStub {
  constructor() {
    this.dispatches = new Map();
    this.acks = new Set();
    this.dismissed = new Map();
  }
  async saveDispatch(record) {
    this.dispatches.set(record.id, record);
    return record;
  }
  async findDispatchByKey() {
    return null;
  }
  async listDispatches() {
    return [...this.dispatches.values()];
  }
  async listAcks() {
    return [...this.acks];
  }
  async addAck(id) {
    this.acks.add(id);
  }
  async listDismissed() {
    return [...this.dismissed].map(([id, reason]) => ({ id, reason, at: Date.now() }));
  }
  async getBossSession() {
    return { sessionId: 'sess-boss', agent: 'boss' };
  }
  async setBossSession() {
    return null;
  }
}

function makeService() {
  const dir = tmpDir();
  const store = RuntimeStore.open(makeRuntimeDb(dir));
  const patrol = new PatrolStore(join(dir, 'data'));
  const rounds = new RoundControl();
  const { boss, calls, gates, release } = makeBoss();

  const service = new ProjectService({
    store,
    readPlan: async () => null,
    skills: { skills: [], failures: [] },
    domains: [],
    persistence: new PersistenceStub(),
    boss,
    patrol,
    rounds,
  });

  return { service, store, patrol, rounds, calls, gates, release, dir };
}

test('没人跑的时候，对话正常起一轮，不带 whenBusy', async () => {
  const { service, calls, release, store, dir } = makeService();
  try {
    const chatPromise = service.chat('各项目什么状态');
    await waitFor(() => calls.chat.length === 1, '对话被发起');
    assert.equal(calls.chat[0].options.whenBusy, undefined, '会话空着，不用传 whenBusy');
    release('chat');
    await chatPromise;
  } finally {
    store.close();
    cleanupDir(dir);
  }
});

test('巡检轮次跑着的时候，对话插话进去 —— 不排队等它结束', async () => {
  const { service, calls, release, rounds, store, dir } = makeService();
  try {
    const started = await service.startPatrol();
    await waitFor(() => calls.patrol.length === 1, '巡检跑起来');

    const chatPromise = service.chat('顺便说说 alpha');
    await waitFor(() => calls.chat.length === 1, '对话被发起');
    assert.equal(
      calls.chat[0].options.whenBusy,
      'steer',
      '巡检轮次只读事实、不改文件，插话进去，不排队等它跑完',
    );

    // 巡检跑完，回复由那一轮给出。
    release('patrol');
    const outcome = await chatPromise;
    assert.equal(outcome.status, 'finished');
    assert.equal(outcome.text, '巡检原文：alpha 有 1 项要你拍板', '回复是那一轮的原文');
    assert.equal(outcome.steeredInto, started.id, '这条对话是插进哪一轮的，说得清');

    const summary = rounds.get(started.id);
    assert.equal(summary.status, 'finished');
  } finally {
    store.close();
    cleanupDir(dir);
  }
});

test('对话跑着的时候，第二条对话排队 —— 不插话进可能改文件的那一轮', async () => {
  const { service, calls, release, store, dir } = makeService();
  try {
    const first = service.chat('先做这个');
    await waitFor(() => calls.chat.length === 1, '第一条对话跑起来');

    const second = service.chat('再做一个');
    await waitFor(() => calls.chat.length === 2, '第二条对话被发起');
    assert.equal(
      calls.chat[1].options.whenBusy,
      'queue',
      '对话可能在改文件，插话会切人家半成品，所以排队',
    );

    release('chat');
    release('chat');
    await Promise.all([first, second]);
  } finally {
    store.close();
    cleanupDir(dir);
  }
});

test('叫停一轮巡检：这一轮落成 aborted，不算结论，但留痕', async () => {
  const { service, calls, rounds, store, dir } = makeService();
  try {
    const started = await service.startPatrol();
    await waitFor(() => calls.patrol.length === 1, '巡检跑起来');

    const stopped = service.stopRound(started.id);
    assert.equal(stopped.stopped, true, '叫停成功');

    const settled = await started.promise;
    assert.equal(settled.status, 'aborted', '被叫停的轮次是 aborted');
    assert.equal(rounds.get(started.id).status, 'aborted', '状态留痕，不是静默消失');
    assert.equal(calls.patrol[0].options.signal.aborted, true, '宿主那一轮确实收到了 abort');
  } finally {
    store.close();
    cleanupDir(dir);
  }
});

test('同一时刻只跑一轮巡检：重复启动直接跳过', async () => {
  const { service, calls, store, dir } = makeService();
  try {
    const first = await service.startPatrol();
    await waitFor(() => calls.patrol.length === 1, '第一轮跑起来');

    const second = await service.startPatrol();
    assert.equal(second.skipped, true, '第二轮被跳过');
    assert.equal(second.reason, 'slot_busy');
    assert.equal(second.id, first.id, '跳过时指向正在跑的那一轮');
    assert.equal(calls.patrol.length, 1, '大哥只被叫了一次');
  } finally {
    store.close();
    cleanupDir(dir);
  }
});

test('派工也是登记在册的轮次：会话正忙时对话知道该排队', async () => {
  const { service, calls, rounds, store, dir } = makeService();
  try {
    await service.runDispatch({ id: 'd1', projectId: 1, projectName: 'alpha', instruction: '干活' });
    const dispatchRound = rounds.list().find((round) => round.kind === 'dispatch');
    assert.ok(dispatchRound, '派工也要登记成轮次，否则别的指令不知道会话正忙');
    assert.equal(calls.dispatch[0].options.whenBusy, 'queue', '派工一律排队，不插话');
  } finally {
    store.close();
    cleanupDir(dir);
  }
});
