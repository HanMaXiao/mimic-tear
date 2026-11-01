import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { ManagedProjects } from '../miniapps/mimic-tear/miniapp/node/managed-projects.mjs';
import { PatrolStore } from '../miniapps/mimic-tear/miniapp/node/patrol-store.mjs';
import { RuntimeStore } from '../miniapps/mimic-tear/miniapp/node/runtime-store.mjs';
import { ThreadSubscriptions } from '../miniapps/mimic-tear/miniapp/node/thread-subscriptions.mjs';
import { planRound, runRound } from '../miniapps/mimic-tear/miniapp/node/direct-delivery-runner.mjs';
import { createSingleFlight } from '../miniapps/mimic-tear/miniapp/node/single-flight.mjs';
import { makeRuntimeDb, tmpDir, cleanupDir } from './helpers/fixture.mjs';

const CLI = fileURLToPath(new URL('../miniapps/mimic-tear/miniapp/node/patrol-cli.mjs', import.meta.url));

/**
 * 方案 A：直通的负责会话必须是 **Mini App 自己拥有的会话**。
 *
 * 宿主的所有权闸（`gateway.js` 的 `requireOwned`）规定 Mini App 只能续自己拥有的会话，
 * 而原来那条线的负责会话是**桌面端用户会话**（`purpose=null`）→ 16 次调用全被
 * `SESSION_NOT_FOUND` 拒，**一条都没真投出去**。
 *
 * 落法：订阅项记下 `ownerAgent`，**第一次投递时由 Mini App 建出会话**（第一次就把事件
 * 投进去，不建空会话），拿到 sessionId 写回订阅表；之后一律续它。
 *
 * 这里用**真实模块**（ManagedProjects / RuntimeStore / ThreadSubscriptions / planRound），
 * 不注入替身——上一轮的两个缺陷都栽在「替身的形状和真实模块不一样」上。
 * 唯一注入的是 `agent`：那是宿主边界，不是我们的模块。
 */

/**
 * 一个记录调用的假宿主 agent。
 *
 * @param {{sessionId?:string, status?:string, fail?:boolean, failCreate?:boolean}} [options]
 * @returns {{run:Function, create:Function, calls:any[]}}
 */
function fakeAgent(options = {}) {
  const calls = [];
  return {
    calls,
    async create(input) {
      calls.push({ op: 'create', ...input });
      if (options.failCreate) throw new Error('create failed');
      return { sessionId: options.sessionId ?? 'mvs-owned-created' };
    },
    async run(input) {
      calls.push({ op: 'run', ...input });
      if (options.fail) throw new Error('SESSION_NOT_FOUND');
      return {
        sessionId: options.sessionId ?? 'mvs-owned-created',
        status: options.status ?? 'finished',
        text: '好的',
      };
    },
  };
}

/**
 * 跑一次 CLI。
 *
 * @param {string[]} args
 * @returns {any}
 */
function runCli(args) {
  const output = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  return JSON.parse(output.replace(/^\uFEFF+/, ''));
}

/**
 * 在夹具库里加一个 **Mini App 自己拥有的**会话（`purpose = miniapp:mimic-tear`）。
 *
 * @param {string} dbPath
 * @param {string} sessionId
 */
function addOwnedSession(dbPath, sessionId) {
  const db = new DatabaseSync(dbPath);
  db.prepare(
    `INSERT INTO local_runtime_sessions
       (session_id, agent_name, status, archived, visibility, session_type, purpose,
        parent_session_id, workspace_dir, title, created_at_ms, updated_at_ms,
        error_code, error_message, project_id)
     VALUES (?, 'mavis', 'idle', 0, 'visible', 'root', 'miniapp:mimic-tear',
             NULL, 'D:/projects/alpha', '仿身泪滴自有会话', 100, 5000, NULL, NULL, 1)`,
  ).run(sessionId);
  db.close();
}

test('CLI：thread add 拒掉「不是仿身泪滴自己拥有」的会话', async () => {
  const dir = tmpDir();
  try {
    const dataDir = join(dir, 'data');
    const dbPath = makeRuntimeDb(dir);

    // sess-alpha-lead 是桌面端用户会话（purpose=null）——宿主不让我们续它。
    let rejected = false;
    let message = '';
    try {
      runCli(['thread', 'add', 'alpha', 'sess-alpha-lead', '大老板点名这条线有负责会话',
        '--data-dir', dataDir, '--db', dbPath]);
    } catch (error) {
      rejected = error.status === 2;
      message = String(error.stderr ?? '');
    }
    assert.ok(rejected, '指向桌面端会话的投递口必须被拒——不然它会安静地一条都投不出去');
    assert.match(message, /自己拥有/, '报错要说清为什么');

    const subscriptions = new ThreadSubscriptions(dataDir);
    assert.equal((await subscriptions.list()).length, 0, '被拒的订阅不能进账');
  } finally {
    cleanupDir(dir);
  }
});

test('CLI：thread add 放行仿身泪滴自己拥有的会话', async () => {
  const dir = tmpDir();
  try {
    const dataDir = join(dir, 'data');
    const dbPath = makeRuntimeDb(dir);
    addOwnedSession(dbPath, 'mvs-owned-alpha');

    const result = runCli(['thread', 'add', 'alpha', 'mvs-owned-alpha', '大老板点名这条线有负责会话',
      '--data-dir', dataDir, '--db', dbPath]);
    assert.equal(result.ok, true);
    assert.equal(result.ownerSessionId, 'mvs-owned-alpha');
  } finally {
    cleanupDir(dir);
  }
});

test('CLI：thread own 让这条线改由仿身泪滴自建负责会话', async () => {
  const dir = tmpDir();
  try {
    const dataDir = join(dir, 'data');
    const dbPath = makeRuntimeDb(dir);

    const result = runCli(['thread', 'own', 'alpha', '大老板拍板：方案 A，这条线由仿身泪滴自建负责会话',
      '--data-dir', dataDir, '--db', dbPath]);
    assert.equal(result.ok, true);
    assert.equal(result.ownerSessionId, null, '会话还没建——第一次投递时才建');
    assert.equal(result.ownerAgent, 'mavis');

    const facts = runCli(['facts', '--data-dir', dataDir, '--db', dbPath]);
    const thread = facts.threads.find((entry) => entry.projectName === 'alpha');
    assert.ok(thread, '事实表里要看得见这条线');
    assert.equal(thread.ownerAgent, 'mavis');
    assert.equal(thread.owned, null, '还没建出负责会话');
  } finally {
    cleanupDir(dir);
  }
});

test('CLI：事实表要标出「负责会话是不是仿身泪滴自己的」', async () => {
  const dir = tmpDir();
  try {
    const dataDir = join(dir, 'data');
    const dbPath = makeRuntimeDb(dir);
    addOwnedSession(dbPath, 'mvs-owned-alpha');

    runCli(['thread', 'add', 'alpha', 'mvs-owned-alpha', '大老板点名这条线有负责会话',
      '--data-dir', dataDir, '--db', dbPath]);

    const facts = runCli(['facts', '--data-dir', dataDir, '--db', dbPath]);
    const thread = facts.threads.find((entry) => entry.projectName === 'alpha');
    assert.equal(thread.owned, true, '自己拥有的会话要标出来');
  } finally {
    cleanupDir(dir);
  }
});

test('没有负责会话、但有 ownerAgent 的线：要被计划投递', async () => {
  const dir = tmpDir();
  let store = null;
  try {
    const dataDir = join(dir, 'data');
    const managed = new ManagedProjects(dataDir);
    const subscriptions = new ThreadSubscriptions(dataDir);
    const patrol = new PatrolStore(dataDir);

    await managed.add('alpha', '大老板点名要盯这个');
    // 负责会话交出去建：订阅项只记 ownerAgent。
    await subscriptions.add('alpha', null, '大老板拍板：这条线改由 Mini App 自建负责会话', {
      projectId: 1,
      ownerAgent: 'mavis',
    });

    store = RuntimeStore.open(makeRuntimeDb(dir));
    const probe = await planRound({ store, patrol, managed, subscriptions, agent: null });

    assert.equal(
      probe.plan.deliveries.length > 0,
      true,
      '有 ownerAgent 的线必须有投递口——「没有订阅项 = 没有投递口」，会话是实现细节',
    );
    assert.equal(probe.plan.deliveries[0].thread.ownerAgent, 'mavis');
    assert.equal(probe.plan.deliveries[0].thread.ownerSessionId, null);
  } finally {
    store?.close();
    cleanupDir(dir);
  }
});

test('第一次投递就把事件投进去，并建出会话写回订阅表', async () => {
  const dir = tmpDir();
  let store = null;
  try {
    const dataDir = join(dir, 'data');
    const managed = new ManagedProjects(dataDir);
    const subscriptions = new ThreadSubscriptions(dataDir);
    const patrol = new PatrolStore(dataDir);

    await managed.add('alpha', '大老板点名要盯这个');
    await subscriptions.add('alpha', null, '大老板拍板：这条线改由 Mini App 自建负责会话', {
      projectId: 1,
      ownerAgent: 'mavis',
    });

    const agent = fakeAgent({ sessionId: 'mvs-owned-created' });
    store = RuntimeStore.open(makeRuntimeDb(dir));
    const { outcome } = await runRound({ store, patrol, managed, subscriptions, agent });

    assert.ok(agent.calls.length >= 2, '应该先建会话、再投递');
    assert.equal(agent.calls[0].op, 'create', '第一步是建会话——`create` 不跑轮次，立刻就拿到 id');
    assert.equal(agent.calls[0].agent, 'mavis', '建会话要指名负责 agent');
    assert.equal(agent.calls[1].op, 'run');
    assert.equal(agent.calls[1].sessionId, 'mvs-owned-created', '投递要续刚建出来的那个会话');
    assert.equal(agent.calls[1].agent, undefined, '续会话不传 agent——宿主会判 INVALID_ARGUMENTS');
    assert.ok(String(agent.calls[1].text).length > 0, '第一次就把事件投进去，不建空会话');

    assert.equal(outcome.delivered >= 1, true, '这些事件算投出去了');
    const entry = (await subscriptions.list()).find((item) => item.projectName === 'alpha');
    assert.equal(entry.ownerSessionId, 'mvs-owned-created', '建出来的会话必须写回订阅表');
    assert.ok(entry.delivered.length >= 1, '投出去了才记账');
  } finally {
    store?.close();
    cleanupDir(dir);
  }
});

test('已有负责会话时续它，不新建', async () => {
  const dir = tmpDir();
  let store = null;
  try {
    const dataDir = join(dir, 'data');
    const managed = new ManagedProjects(dataDir);
    const subscriptions = new ThreadSubscriptions(dataDir);
    const patrol = new PatrolStore(dataDir);

    await managed.add('alpha', '大老板点名要盯这个');
    await subscriptions.add('alpha', 'mvs-alpha-owner', '大老板点名这条线有负责会话', {
      projectId: 1,
      ownerAgent: 'mavis',
    });

    const agent = fakeAgent({ sessionId: 'mvs-alpha-owner' });
    store = RuntimeStore.open(makeRuntimeDb(dir));
    await runRound({ store, patrol, managed, subscriptions, agent });

    assert.ok(agent.calls.length >= 1);
    assert.equal(agent.calls[0].op, 'run', '有会话就续它，不建新的');
    assert.equal(agent.calls[0].sessionId, 'mvs-alpha-owner', '有会话就续它');
    assert.equal(agent.calls[0].agent, undefined, '有会话时不传 agent——续跑保持原 agent');
  } finally {
    store?.close();
    cleanupDir(dir);
  }
});

test('投递文本要带项目绝对路径 —— Mini App 建的会话不在项目目录里', async () => {
  const dir = tmpDir();
  let store = null;
  try {
    const dataDir = join(dir, 'data');
    const managed = new ManagedProjects(dataDir);
    const subscriptions = new ThreadSubscriptions(dataDir);
    const patrol = new PatrolStore(dataDir);

    await managed.add('alpha', '大老板点名要盯这个');
    await subscriptions.add('alpha', null, '大老板拍板：这条线改由 Mini App 自建负责会话', {
      projectId: 1,
      ownerAgent: 'mavis',
    });

    const agent = fakeAgent();
    store = RuntimeStore.open(makeRuntimeDb(dir));
    await runRound({ store, patrol, managed, subscriptions, agent });

    const text = String(agent.calls.find((call) => call.op === 'run').text);
    assert.ok(
      text.includes('D:/projects/alpha') || text.includes('D:\\projects\\alpha'),
      `消息里必须有项目的绝对路径（实际：${text}）——负责 agent 不知道去哪儿干活`,
    );
  } finally {
    store?.close();
    cleanupDir(dir);
  }
});

test('投递失败不记账：事件下一轮还会被计划到', async () => {
  const dir = tmpDir();
  let store = null;
  try {
    const dataDir = join(dir, 'data');
    const managed = new ManagedProjects(dataDir);
    const subscriptions = new ThreadSubscriptions(dataDir);
    const patrol = new PatrolStore(dataDir);

    await managed.add('alpha', '大老板点名要盯这个');
    await subscriptions.add('alpha', null, '大老板拍板：这条线改由 Mini App 自建负责会话', {
      projectId: 1,
      ownerAgent: 'mavis',
    });

    const agent = fakeAgent({ fail: true });
    store = RuntimeStore.open(makeRuntimeDb(dir));
    const { outcome } = await runRound({ store, patrol, managed, subscriptions, agent });

    assert.equal(outcome.delivered, 0);
    assert.ok(outcome.failed >= 1, '失败的要算失败');
    const entry = (await subscriptions.list()).find((item) => item.projectName === 'alpha');
    assert.equal(entry.delivered.length, 0, '失败的不记账——事件还在，下一轮还会被计划到');
    assert.equal(
      entry.ownerSessionId,
      'mvs-owned-created',
      '会话建出来了就续它——重试不该再建一个（那才是「一个项目两个负责人」）',
    );
  } finally {
    store?.close();
    cleanupDir(dir);
  }
});

test('建会话失败：既不写会话也不记账', async () => {
  const dir = tmpDir();
  let store = null;
  try {
    const dataDir = join(dir, 'data');
    const managed = new ManagedProjects(dataDir);
    const subscriptions = new ThreadSubscriptions(dataDir);
    const patrol = new PatrolStore(dataDir);

    await managed.add('alpha', '大老板点名要盯这个');
    await subscriptions.add('alpha', null, '大老板拍板：这条线改由 Mini App 自建负责会话', {
      projectId: 1,
      ownerAgent: 'mavis',
    });

    const agent = fakeAgent({ failCreate: true });
    store = RuntimeStore.open(makeRuntimeDb(dir));
    const { outcome } = await runRound({ store, patrol, managed, subscriptions, agent });

    assert.equal(outcome.delivered, 0);
    assert.equal(agent.calls.filter((call) => call.op === 'run').length, 0, '会话没建出来就不该投递');
    const entry = (await subscriptions.list()).find((item) => item.projectName === 'alpha');
    assert.equal(entry.ownerSessionId, null, '没建出话就不能写回一个假的 sessionId');
    assert.equal(entry.delivered.length, 0);
  } finally {
    store?.close();
    cleanupDir(dir);
  }
});

test('投递轮次不许重叠：上一轮没跑完，下一轮被跳过', async () => {
  // 投递要等负责 agent 那一轮跑完（可能好几分钟），而循环每 30 秒跳一次。
  // 重叠起来：同一个事件被投两次、还建出两个负责会话（2026-11-01 真机撞出来的）。
  const flight = createSingleFlight();
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });

  const first = flight.run(async () => {
    await gate;
    return '第一轮';
  });
  assert.equal(flight.busy, true, '第一轮在跑');

  const second = await flight.run(async () => '第二轮');
  assert.equal(second.skipped, true, '上一轮没跑完，这一轮必须跳过');
  assert.equal(second.value, null);

  release();
  assert.equal((await first).value, '第一轮');
  assert.equal(flight.busy, false, '跑完之后要能再跑下一轮');

  const third = await flight.run(async () => '第三轮');
  assert.equal(third.skipped, false, '空闲时照常跑');
  assert.equal(third.value, '第三轮');
});

test('越权闸仍然有效：名单外的项目一条都投不出去', async () => {
  const dir = tmpDir();
  let store = null;
  try {
    const dataDir = join(dir, 'data');
    const managed = new ManagedProjects(dataDir);
    const subscriptions = new ThreadSubscriptions(dataDir);
    const patrol = new PatrolStore(dataDir);

    // 只管 alpha。beta 有订阅项，但不在管辖名单里。
    await managed.add('alpha', '大老板点名要盯这个');
    await subscriptions.add('beta', null, '这条线有投递口，但不在管辖名单里', {
      projectId: 2,
      ownerAgent: 'mavis',
    });

    const agent = fakeAgent();
    store = RuntimeStore.open(makeRuntimeDb(dir));
    const { outcome } = await runRound({ store, patrol, managed, subscriptions, agent });

    assert.equal(agent.calls.length, 0, '名单外的项目一条都不能投');
    assert.equal(outcome.attempted, 0);
  } finally {
    store?.close();
    cleanupDir(dir);
  }
});
