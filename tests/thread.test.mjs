import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeThread, planDeliveries, renderDelivery } from '../miniapps/mimic-tear/miniapp/node/thread.mjs';
import { ThreadSubscriptions } from '../miniapps/mimic-tear/miniapp/node/thread-subscriptions.mjs';
import {
  deliverToSession,
  deliverToThreads,
} from '../miniapps/mimic-tear/miniapp/node/direct-delivery.mjs';
import { makeTrigger } from '../miniapps/mimic-tear/miniapp/node/trigger.mjs';
import { makeRuntimeDb, tmpDir, cleanupDir } from './helpers/fixture.mjs';
import { RuntimeStore } from '../miniapps/mimic-tear/miniapp/node/runtime-store.mjs';
import { PatrolStore } from '../miniapps/mimic-tear/miniapp/node/patrol-store.mjs';
import { ManagedProjects } from '../miniapps/mimic-tear/miniapp/node/managed-projects.mjs';
import { planRound } from '../miniapps/mimic-tear/miniapp/node/direct-delivery-runner.mjs';

const CLI_PATH = fileURLToPath(new URL('../miniapps/mimic-tear/miniapp/node/patrol-cli.mjs', import.meta.url));

const MINUTE = 60_000;
const NOW = Date.parse('2026-11-01T12:00:00Z');

const THREAD = makeThread({
  projectId: 1,
  projectName: 'alpha',
  ownerSessionId: 'sess-alpha-lead',
  since: NOW - 60 * MINUTE,
  reason: '大老板让大哥盯 alpha',
});

const EVENT = makeTrigger({
  type: 'session-broken',
  subject: 'sess-alpha-w2',
  projectName: 'alpha',
  summary: '干活干到一半停了',
  at: NOW,
});

// ---------------------------------------------------------------------------
// 归属与投递计划（纯）
// ---------------------------------------------------------------------------

test('线必须有项目名——没有归属的事件投不出去', () => {
  assert.throws(() => makeThread({ projectName: '  ' }), /项目名/);
});

test('计划：三条闸各挡一样东西', () => {
  const base = { triggers: [EVENT], threads: [THREAD], managedNames: ['alpha'] };

  const ok = planDeliveries(base);
  assert.equal(ok.deliveries.length, 1, '正常情况要投出去');
  assert.equal(ok.skipped.total, 0);

  // 闸一：类型不在白名单。
  const noType = planDeliveries({ ...base, allowTypes: ['duty-wake'] });
  assert.equal(noType.deliveries.length, 0);
  assert.equal(noType.skipped.byReason.type_not_allowed, 1);

  // 闸二：没有订阅（没有投递口）。
  const noThread = planDeliveries({ ...base, threads: [] });
  assert.equal(noThread.skipped.byReason.no_subscription, 1);

  // 闸三：越权——线在订阅表里，但项目不在管辖名单。
  const outOfScope = planDeliveries({ ...base, managedNames: ['beta'] });
  assert.equal(outOfScope.deliveries.length, 0);
  assert.equal(outOfScope.skipped.byReason.out_of_jurisdiction, 1);

  // 没有负责会话的线 = 没有投递口。
  const noOwner = planDeliveries({
    ...base,
    threads: [makeThread({ projectName: 'alpha', ownerSessionId: null })],
  });
  assert.equal(noOwner.deliveries.length, 0);
  assert.equal(noOwner.skipped.byReason.no_subscription, 1);
});

test('计划：投过的不再投', () => {
  const result = planDeliveries({
    triggers: [EVENT],
    threads: [THREAD],
    managedNames: ['alpha'],
    delivered: [EVENT.id],
  });
  assert.equal(result.deliveries.length, 0);
  assert.equal(result.skipped.byReason.already_delivered, 1);
});

test('投递文本要短，且带得上项目名与事实', () => {
  const text = renderDelivery(EVENT, THREAD);
  assert.match(text, /alpha/);
  assert.match(text, /会话中断/);
  assert.match(text, /干活干到一半停了/);
  assert.ok(text.split('\n').length <= 3, '这条消息会占用项目会话的上下文，不能长');
});

// ---------------------------------------------------------------------------
// 订阅表
// ---------------------------------------------------------------------------

test('订阅表：理由必填，负责会话必填', async () => {
  const dir = tmpDir();
  try {
    const subscriptions = new ThreadSubscriptions(dir);
    await assert.rejects(() => subscriptions.add('alpha', 'sess-1', ''), /理由/);
    await assert.rejects(() => subscriptions.add('alpha', '', '大老板让大哥盯'), /负责会话/);

    await subscriptions.add('alpha', 'sess-alpha-lead', '大老板让大哥盯 alpha');
    const list = await subscriptions.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].ownerSessionId, 'sess-alpha-lead');
    assert.match(list[0].reason, /盯 alpha/);
  } finally {
    cleanupDir(dir);
  }
});

test('订阅表：投过的事件被记下来', async () => {
  const dir = tmpDir();
  try {
    const subscriptions = new ThreadSubscriptions(dir);
    await subscriptions.add('alpha', 'sess-alpha-lead', '大老板让大哥盯 alpha');
    await subscriptions.markDelivered('alpha', ['evt-1', 'evt-2']);
    await subscriptions.markDelivered('alpha', ['evt-2', 'evt-3']);

    const list = await subscriptions.list();
    assert.deepEqual(list[0].delivered.sort(), ['evt-1', 'evt-2', 'evt-3']);
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------------
// 直通投递
// ---------------------------------------------------------------------------

test('投递：跑完了才算执行，排队了不算', async () => {
  const finished = await deliverToSession({
    agent: { async run() { return { status: 'finished' }; } },
    sessionId: 'sess-1',
    text: '有事',
  });
  assert.equal(finished.delivered, true);
  assert.equal(finished.accepted, true);
  assert.equal(finished.reason, 'finished');

  const queued = await deliverToSession({
    agent: { async run() { return { status: 'queued' }; } },
    sessionId: 'sess-1',
    text: '有事',
  });
  assert.equal(queued.delivered, false, '排队不等于执行');
  assert.equal(queued.accepted, true, '但已经投出去了');
  assert.equal(queued.reason, 'queued');
});

test('投递：错了就是没投出去，事件还留着', async () => {
  const outcome = await deliverToSession({
    agent: { async run() { throw new Error('session_not_found'); } },
    sessionId: 'sess-1',
    text: '有事',
  });
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.delivered, false);
  assert.match(outcome.error, /session_not_found/);
});

test('投递：只有投出去的才记账，投失败的下一轮还会被计划到', async () => {
  const dir = tmpDir();
  try {
    const subscriptions = new ThreadSubscriptions(dir);
    await subscriptions.add('alpha', 'sess-alpha-lead', '大老板让大哥盯 alpha');

    const calls = [];
    const failed = await deliverToThreads({
      agent: { async run(input) { calls.push(input); throw new Error('boom'); } },
      deliveries: [{ trigger: EVENT, thread: THREAD, text: '有事' }],
      subscriptions,
    });
    assert.equal(failed.failed, 1);
    assert.equal(calls.length, 1);
    assert.deepEqual((await subscriptions.list())[0].delivered, [], '失败的不能记账');

    const ok = await deliverToThreads({
      agent: { async run(input) { calls.push(input); return { status: 'finished' }; } },
      deliveries: [{ trigger: EVENT, thread: THREAD, text: '有事' }],
      subscriptions,
    });
    assert.equal(ok.delivered, 1);
    assert.deepEqual((await subscriptions.list())[0].delivered, [EVENT.id]);
  } finally {
    cleanupDir(dir);
  }
});

test('投递：目标是项目会话，不是大哥的会话', async () => {
  const calls = [];
  await deliverToSession({
    agent: { async run(input) { calls.push(input); return { status: 'finished' }; } },
    sessionId: 'sess-alpha-lead',
    text: '有事',
  });
  assert.equal(calls[0].sessionId, 'sess-alpha-lead');
  assert.equal(calls[0].whenBusy, 'queue', '默认排队，不打断正在跑的轮次');
  assert.equal(calls[0].text, '有事');
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function runCli(dbPath, dataDir, args = ['facts']) {
  const stdout = execFileSync(
    process.execPath,
    [CLI_PATH, ...args, '--db', dbPath, '--data-dir', dataDir],
    { encoding: 'utf8' },
  );
  return JSON.parse(stdout);
}

test('CLI thread：开投递口要看得到，理由必填，会话必须真的存在', () => {
  const dir = tmpDir();
  try {
    const dbPath = makeRuntimeDb(dir);
    const dataDir = join(dir, 'data');

    // 没有理由 → 拒绝。
    assert.throws(
      () => runCli(dbPath, dataDir, ['thread', 'add', 'alpha', 'sess-alpha-lead']),
      (error) => {
        assert.equal(error.status, 2);
        assert.match(String(error.stderr), /理由/);
        return true;
      },
    );

    // 会话不存在 → 拒绝（落空的投递口是查不出来的）。
    assert.throws(
      () => runCli(dbPath, dataDir, ['thread', 'add', 'alpha', 'mvs-不存在', '大老板让大哥盯 alpha']),
      (error) => {
        assert.equal(error.status, 2);
        assert.match(String(error.stderr), /没有这个会话/);
        return true;
      },
    );

    // 正常开。
    const added = runCli(dbPath, dataDir, ['thread', 'add', 'alpha', 'sess-alpha-lead', '大老板让大哥盯 alpha']);
    assert.equal(added.ok, true);
    assert.equal(added.threads.length, 1);
    assert.equal(added.threads[0].ownerSessionId, 'sess-alpha-lead');

    // 事实表里要看得见这条线。
    const facts = runCli(dbPath, dataDir);
    assert.equal(facts.threads.length, 1);
    assert.equal(facts.threads[0].projectName, 'alpha');

    // 关掉。
    const removed = runCli(dbPath, dataDir, ['thread', 'remove', 'alpha', '大老板说不用盯了']);
    assert.equal(removed.removed, true);
    assert.equal(removed.threads.length, 0);
  } finally {
    cleanupDir(dir);
  }
});

test('轮次：待答的问卷要成为候选事件，主键是 requestId', async () => {
  const dir = tmpDir();
  try {
    const dbPath = makeRuntimeDb(dir);
    const dataDir = join(dir, 'data');
    const store = RuntimeStore.open(dbPath);
    try {
      const round = await planRound({
        store,
        patrol: new PatrolStore(dataDir),
        managed: new ManagedProjects(dataDir),
        subscriptions: new ThreadSubscriptions(dataDir),
        now: NOW,
      });

      const questionnaire = round.candidates.kept.find((t) => t.type === 'questionnaire-opened');
      assert.ok(questionnaire, '待答的问卷要成为候选事件');
      // 运行时存储层的主键字段是 `id`（`id: row.request_id`），CLI 那层才改名成 `requestId`。
      // 写错哪一层都会静默产出 `undefined` 的主体 —— 而这种错**不会报错**，只会投错。
      assert.equal(questionnaire.subject, 'ask-1', '问卷的主键要接对');
      assert.notEqual(questionnaire.subject, 'undefined');
    } finally {
      store.close();
    }
  } finally {
    cleanupDir(dir);
  }
});
