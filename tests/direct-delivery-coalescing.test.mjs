import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { ManagedProjects } from '../miniapps/mimic-tear/miniapp/node/managed-projects.mjs';
import { PatrolStore } from '../miniapps/mimic-tear/miniapp/node/patrol-store.mjs';
import {
  IN_FLIGHT_EXPIRY_MS,
  ThreadSubscriptions,
} from '../miniapps/mimic-tear/miniapp/node/thread-subscriptions.mjs';
import { deliverToThreads } from '../miniapps/mimic-tear/miniapp/node/direct-delivery.mjs';
import { makeTrigger } from '../miniapps/mimic-tear/miniapp/node/trigger.mjs';
import { renderDelivery } from '../miniapps/mimic-tear/miniapp/node/thread.mjs';
import { makeRuntimeDb, tmpDir, cleanupDir } from './helpers/fixture.mjs';

/**
 * 「在途合并」（唤醒收敛）的验收。
 *
 * 设计依据：`.agents/notes/proposed/architecture/2026-11-01-direct-delivery-wakeup-coalescing.md`
 *
 * 关键：**判定在途读在途标记，不读 `delivered`**——`delivered` 要等负责会话那一轮结束
 * 才落盘（实测滞后 11 分钟），拿它判「正在处理同类事件」，窗口永远是空的。
 *
 * 真实模块（`ManagedProjects` / `PatrolStore` / `ThreadSubscriptions` / `deliverToThreads` /
 * `makeTrigger` / `renderDelivery`），只注入宿主边界上的 `agent`。
 */

/**
 * 一个可手动放行的假宿主 agent。
 *
 * @param {{hold?:boolean}} [options] hold=true 时 run 一直挂着（= 负责会话那一轮没结束）
 * @returns {{calls:any[], release:Function, agent:any}}
 */
function fakeAgent(options = {}) {
  const calls = [];
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  const agent = {
    calls,
    async create() {
      return { sessionId: 'mvs-owned-created' };
    },
    async run(input) {
      calls.push(input);
      // 只挂住**第一笔**（= 负责会话那一轮还没结束）；后面的投递照常走完。
      if (options.hold && calls.length === 1) {
        await gate;
      }
      return { sessionId: input.sessionId, status: 'finished', text: '好' };
    },
  };
  return { calls, release: () => release(), agent };
}

/**
 * 造一个投递件（真实触发器 + 真实渲染的正文）。
 *
 * @param {string} projectName
 * @param {number} at 活动时间
 * @param {string} [id]
 * @returns {any}
 */
function deliveryOf(projectName, at, id) {
  const trigger = makeTrigger({
    type: 'project-activity',
    source: 'runtime',
    subject: projectName,
    projectName,
    summary: `最近一次活动在 ${new Date(at).toISOString()}`,
    at,
    refs: [projectName],
    severity: 'low',
    ...(id ? { id } : {}),
  });
  const thread = { projectName, ownerSessionId: '', ownerAgent: 'mavis' };
  return { trigger, thread, text: renderDelivery(trigger, thread) };
}

/**
 * 等一个条件成立。
 *
 * @param {() => Promise<boolean>|boolean} check
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
async function waitFor(check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    if (await check()) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => { setTimeout(resolve, 30); });
  }
  return false;
}

/**
 * 铺一套真实环境。
 *
 * @param {string} dir
 * @returns {Promise<{dataDir:string, managed:any, subscriptions:any, patrol:any}>}
 */
async function setup(dir) {
  const dataDir = join(dir, 'data');
  const managed = new ManagedProjects(dataDir);
  const subscriptions = new ThreadSubscriptions(dataDir);
  const patrol = new PatrolStore(dataDir);
  await managed.add('alpha', '大老板点名要盯这个');
  await subscriptions.add('alpha', null, '大老板拍板：方案 A', { projectId: 1, ownerAgent: 'mavis' });
  return { dataDir, managed, subscriptions, patrol };
}

test('未命中：没有在途就正常投递，投完转成已投出、在途撤掉', async () => {
  const dir = tmpDir();
  try {
    const { subscriptions } = await setup(dir);
    const { calls, agent } = fakeAgent();

    const outcome = await deliverToThreads({
      agent,
      subscriptions,
      deliveries: [deliveryOf('alpha', Date.now() - 1000)],
    });

    assert.equal(calls.length, 1, '没有在途就该真投一次');
    assert.equal(outcome.delivered, 1);
    const entry = (await subscriptions.list())[0];
    assert.equal((entry.delivered ?? []).length, 1, '投出去了要记账');
    assert.deepEqual(entry.inFlight ?? {}, {}, '在途标记要撤掉——留着就永远「在处理中」');
  } finally {
    cleanupDir(dir);
  }
});

test('命中在途：同类事件并进来，本轮不投（事件不丢，等那一轮结束后补投）', async () => {
  const dir = tmpDir();
  try {
    const { subscriptions } = await setup(dir);
    const { calls, agent } = fakeAgent({ hold: true });

    // 第一笔：在途（负责会话那一轮还没结束）。
    const first = deliverToThreads({
      agent,
      subscriptions,
      deliveries: [deliveryOf('alpha', Date.now() - 5000)],
    });
    const marked = await waitFor(async () => Boolean(
      await subscriptions.getInFlight('alpha', 'project-activity'),
    ));
    assert.ok(marked, '第一笔应该写在途标记');

    // 第二笔：同类事件 → 并进来。
    const second = await deliverToThreads({
      agent,
      subscriptions,
      deliveries: [deliveryOf('alpha', Date.now() - 1000)],
    });

    assert.equal(calls.length, 1, '命中在途的事件不该再投一次');
    assert.equal(second.results[0].reason, 'merged_into_inflight');
    const record = await subscriptions.getInFlight('alpha', 'project-activity');
    assert.equal(record.merged.length, 1, '并进来的事件要留在在途记录里——不能丢');
    assert.equal((await subscriptions.list())[0].delivered.length, 0, '并进来的还没投，不能记账');

    // 收尾：把第一轮放行（避免测试挂着）。
    first.catch(() => {});
  } finally {
    cleanupDir(dir);
  }
});

test('尾巴投递：在途期间并进来的活动，等那一轮结束后按合并后的最新值再投一次', async () => {
  const dir = tmpDir();
  try {
    const { subscriptions } = await setup(dir);
    const { calls, release, agent } = fakeAgent({ hold: true });

    const first = deliverToThreads({
      agent,
      subscriptions,
      deliveries: [deliveryOf('alpha', Date.now() - 9000)],
    });
    await waitFor(async () => Boolean(await subscriptions.getInFlight('alpha', 'project-activity')));

    // 在途期间来了两次新活动 → 都并进来（note 的判据：连续 3 次活动）。
    const middleAt = Date.now() - 5000;
    await deliverToThreads({
      agent,
      subscriptions,
      deliveries: [deliveryOf('alpha', middleAt)],
    });
    const latestAt = Date.now() - 500;
    await deliverToThreads({
      agent,
      subscriptions,
      deliveries: [deliveryOf('alpha', latestAt)],
    });
    assert.equal(calls.length, 1, '并进来的那两笔本轮都不投');

    const record = await subscriptions.getInFlight('alpha', 'project-activity');
    assert.equal(record.merged.length, 2, '两次活动都并进来了——事件不丢');

    // 第一轮结束 → 尾巴投递：按合并后的**最新**活动时点再投一次。
    release();
    await first;

    assert.equal(calls.length, 2, '一串活动只多唤一次（第一发 + 尾巴），而不是每条各唤一次');
    const tailText = String(calls[1].text);
    assert.ok(
      tailText.includes(new Date(latestAt).toISOString()),
      `尾巴投递要带合并后的最新活动时点（实际：${tailText}）`,
    );
    assert.ok(
      !tailText.includes(new Date(middleAt).toISOString()),
      '中间那次活动被折叠了——负责人看到的是「现在怎么样」，不是一串历史',
    );
    const entry = (await subscriptions.list())[0];
    assert.equal(entry.delivered.length, 3, '三条事件都要记账（事件不丢）');
    assert.deepEqual(entry.inFlight ?? {}, {}, '在途标记不能悬挂');
  } finally {
    cleanupDir(dir);
  }
});

test('在途过期：旧标记作废，照常投递——过期口径是为了不让卡死的会话把一条线永久合并掉', async () => {
  const dir = tmpDir();
  try {
    const { subscriptions } = await setup(dir);
    const { calls, agent } = fakeAgent();

    // 种一个**过期**的在途标记（sentAt 在过期口径之前）。
    await subscriptions.claimDelivery(
      'alpha',
      'project-activity',
      makeTrigger({
        type: 'project-activity', source: 'runtime', subject: 'alpha', projectName: 'alpha',
        summary: '旧的', at: Date.now() - 5000, refs: ['alpha'],
      }),
      { now: Date.now() - IN_FLIGHT_EXPIRY_MS - 60_000 },
    );
    assert.ok(
      await subscriptions.getInFlight('alpha', 'project-activity'),
      '种下的过期标记要真的在',
    );

    const outcome = await deliverToThreads({
      agent,
      subscriptions,
      deliveries: [deliveryOf('alpha', Date.now() - 1000)],
    });

    assert.equal(calls.length, 1, '过期的在途不算在途——照常投递');
    assert.equal(outcome.delivered, 1);
  } finally {
    cleanupDir(dir);
  }
});

test('投递失败：在途撤掉、事件不记账，下一轮还能被计划到（重试成功才记账）', async () => {
  const dir = tmpDir();
  try {
    const { subscriptions } = await setup(dir);
    let failNext = true;
    const calls = [];
    const agent = {
      async create() { return { sessionId: 'mvs-owned-created' }; },
      async run(input) {
        calls.push(input);
        if (failNext) throw new Error('SESSION_NOT_FOUND');
        return { sessionId: input.sessionId, status: 'finished', text: '好' };
      },
    };

    const failed = await deliverToThreads({
      agent,
      subscriptions,
      deliveries: [deliveryOf('alpha', Date.now() - 1000)],
    });
    assert.equal(failed.delivered, 0, '失败的不记账');
    assert.equal(failed.failed, 1);
    const afterFail = (await subscriptions.list())[0];
    assert.deepEqual(afterFail.inFlight ?? {}, {}, '失败的在途要撤掉——留着会让这一轮永远被合并');
    assert.equal((afterFail.delivered ?? []).length, 0, '失败的事件下一轮还会被计划到');

    // 重试：同一个事件再来一次 → 成功 → 记账。
    failNext = false;
    const retry = await deliverToThreads({
      agent,
      subscriptions,
      deliveries: [deliveryOf('alpha', Date.now() - 1000)],
    });
    assert.equal(retry.delivered, 1);
    assert.equal(calls.length, 2, '重试确实又投了一次');
    assert.equal((await subscriptions.list())[0].delivered.length, 1);
  } finally {
    cleanupDir(dir);
  }
});

test('一条线在途时，别的线照常投递（在途是精确的，不是钝器）', async () => {
  const dir = tmpDir();
  try {
    const { subscriptions } = await setup(dir);
    await subscriptions.add('beta', null, '另一条线', { projectId: 2, ownerAgent: 'mavis' });
    const { calls, agent } = fakeAgent({ hold: true });

    // alpha 在途（挂住）。
    const first = deliverToThreads({
      agent,
      subscriptions,
      deliveries: [deliveryOf('alpha', Date.now() - 5000)],
    });
    await waitFor(async () => Boolean(await subscriptions.getInFlight('alpha', 'project-activity')));

    // beta 不该被 alpha 的在途挡住。
    const other = await deliverToThreads({
      agent,
      subscriptions,
      deliveries: [deliveryOf('beta', Date.now() - 1000)],
    });
    assert.equal(other.delivered, 1, '别的线照常投递——单飞闸那种钝器已经去掉了');
    assert.equal(calls.length, 2, 'alpha 一笔 + beta 一笔');

    first.catch(() => {});
  } finally {
    cleanupDir(dir);
  }
});
