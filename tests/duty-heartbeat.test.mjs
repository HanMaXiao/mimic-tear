import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DUTY_CRON_ID,
  evaluateDutyHeartbeat,
  getDutyHeartbeatStatus,
  readHeartbeatState,
  runDutyHeartbeat,
} from '../miniapps/mimic-tear/miniapp/node/duty-heartbeat.mjs';
import { readAlerts } from '../miniapps/mimic-tear/miniapp/node/watchdog-alerts.mjs';
import { tmpDir, cleanupDir } from './helpers/fixture.mjs';

const MINUTE = 60_000;
const NOW = Date.parse('2026-10-20T12:00:00Z');
const PERIOD = 30 * MINUTE;

/** A store that can only read the run log — anything else would throw. */
function readOnlyStore(runs) {
  return {
    listCronRuns() {
      return runs;
    },
  };
}

const DELIVERED_90 = { id: 'r1', status: 'delivered', createdAt: NOW - 90 * MINUTE, deliveredAt: NOW - 90 * MINUTE };

test('C1：断链可判——宿主没创建 run 的空槽位被算出来', () => {
  const decision = evaluateDutyHeartbeat({
    runs: [DELIVERED_90],
    periodMs: PERIOD,
    now: NOW,
  });

  assert.equal(decision.broken, true, '有槽位该触发却没人触发 → 断链');
  assert.equal(decision.blankTail.slots, 2, '90 分钟里有两个已经过去的空槽位');
  assert.equal(decision.pendingTail.slots, 0);
  assert.equal(decision.trigger, true, '空槽位是心跳能补的');
});

test('C2：能补一轮——agent.run 被调用一次且参数正确', async () => {
  const dir = tmpDir();
  try {
    const calls = [];
    const agent = {
      async run(input) {
        calls.push(input);
        return { status: 'finished', text: '交班了', error: null, delivered: true };
      },
    };

    const result = await runDutyHeartbeat({
      dataDir: dir,
      store: readOnlyStore([DELIVERED_90]),
      sessionId: 'mvs_boss_session',
      agent,
      now: NOW,
    });

    assert.equal(calls.length, 1, '只补一次');
    assert.equal(calls[0].sessionId, 'mvs_boss_session');
    assert.match(calls[0].text, /值班/);
    assert.equal(result.triggered, true);
    assert.equal(result.result, 'ok');

    const state = await readHeartbeatState(dir);
    assert.equal(typeof state.lastTriggeredSlot, 'number');
    assert.equal(state.lastResult, 'ok');
  } finally {
    cleanupDir(dir);
  }
});

test('C3：与宿主 cron 去重——宿主在途就不补，同一槽位只补一次', async () => {
  const inFlight = evaluateDutyHeartbeat({
    runs: [
      { id: 'r1', status: 'delivered', createdAt: NOW - 30 * MINUTE, deliveredAt: NOW - 30 * MINUTE },
      { id: 'r2', status: 'pending', createdAt: NOW - 5 * MINUTE, retryAttempt: 12 },
    ],
    periodMs: PERIOD,
    now: NOW,
  });

  assert.equal(inFlight.broken, true, '有未投递的轮次 → 断链');
  assert.equal(inFlight.trigger, false, '宿主正在投 → 不补，否则双倍值班轮次');
  assert.equal(inFlight.reason, 'host_in_flight');

  // The same slot twice: the second time the heartbeat must not fire again.
  const dir = tmpDir();
  try {
    const calls = [];
    const agent = { async run(input) { calls.push(input); return { status: 'finished', error: null }; } };
    const first = await runDutyHeartbeat({
      dataDir: dir, store: readOnlyStore([DELIVERED_90]), sessionId: 'mvs_boss_session', agent, now: NOW,
    });
    const second = await runDutyHeartbeat({
      dataDir: dir, store: readOnlyStore([DELIVERED_90]), sessionId: 'mvs_boss_session', agent, now: NOW + MINUTE,
    });

    assert.equal(first.triggered, true);
    assert.equal(second.triggered, false, '同一槽位不重复补');
    assert.equal(second.reason, 'already_triggered');
    assert.equal(calls.length, 1, '只补过一次');
  } finally {
    cleanupDir(dir);
  }
});

test('C4：不静默——断链、补轮、补轮失败都写进 plugin-data', async () => {
  const brokenDir = tmpDir();
  try {
    const result = await runDutyHeartbeat({
      dataDir: brokenDir,
      store: readOnlyStore([
        { id: 'r1', status: 'delivered', createdAt: NOW - 30 * MINUTE, deliveredAt: NOW - 30 * MINUTE },
        { id: 'r2', status: 'pending', createdAt: NOW - 5 * MINUTE, retryAttempt: 12 },
      ]),
      sessionId: 'mvs_boss_session',
      agent: { async run() { return { status: 'finished', error: null }; } },
      now: NOW,
    });

    assert.equal(result.triggered, false);
    const alerts = await readAlerts(brokenDir);
    assert.equal(alerts.length, 1, '断链要写下来，哪怕没有补');
    assert.equal(alerts[0].action, 'heartbeat_break');
    const state = await readHeartbeatState(brokenDir);
    assert.equal(typeof state.brokenSince, 'number');
  } finally {
    cleanupDir(brokenDir);
  }

  const failedDir = tmpDir();
  try {
    const result = await runDutyHeartbeat({
      dataDir: failedDir,
      store: readOnlyStore([DELIVERED_90]),
      sessionId: 'mvs_boss_session',
      agent: { async run() { throw new Error('模拟补位失败'); } },
      now: NOW,
    });

    assert.equal(result.result, 'error');
    const alerts = await readAlerts(failedDir);
    // Two entries: the chain broke, and the fill failed. Both are facts worth keeping.
    // `readAlerts` returns newest first.
    assert.equal(alerts.length, 2);
    assert.equal(alerts[0].action, 'heartbeat_failed');
    assert.equal(alerts[0].delivered, false);
    assert.match(alerts[0].error, /模拟补位失败/);
    assert.equal(alerts[1].action, 'heartbeat_break');
  } finally {
    cleanupDir(failedDir);
  }
});

test('C5：证据齐全——结论里带 run_id / status / retry_attempt', async () => {
  const dir = tmpDir();
  try {
    await runDutyHeartbeat({
      dataDir: dir,
      store: readOnlyStore([
        { id: 'r1', status: 'delivered', createdAt: NOW - 30 * MINUTE, deliveredAt: NOW - 30 * MINUTE },
        { id: 'r2', status: 'pending', createdAt: NOW - 5 * MINUTE, retryAttempt: 42, error: 'boom' },
      ]),
      sessionId: 'mvs_boss_session',
      agent: { async run() { return { status: 'finished', error: null }; } },
      now: NOW,
    });

    const alerts = await readAlerts(dir);
    assert.match(alerts[0].body, /run_id=r2/);
    assert.match(alerts[0].body, /status=pending/);
    assert.match(alerts[0].body, /retry_attempt=42/);
    // And the scope must be stated, so nobody reads this as "the duty is covered".
    assert.match(alerts[0].body, /板面关着/);
  } finally {
    cleanupDir(dir);
  }
});

test('C6：边界不越——只读运行时库，不改 cron', async () => {
  // The store handed to the heartbeat only has a read method: if the heartbeat tried to
  // write the runtime database or the cron's definition, this would throw.
  const dir = tmpDir();
  try {
    const result = await runDutyHeartbeat({
      dataDir: dir,
      store: readOnlyStore([DELIVERED_90]),
      sessionId: 'mvs_boss_session',
      agent: { async run() { return { status: 'finished', error: null }; } },
      now: NOW,
    });
    assert.equal(result.triggered, true);

    // The cron id is the duty cron's, and it agrees with the one the watchdog watches.
    const watchdogSource = readFileSync(
      fileURLToPath(new URL('../miniapps/mimic-tear/miniapp/node/watchdog.mjs', import.meta.url)),
      'utf8',
    );
    const match = watchdogSource.match(/const DUTY_CRON_ID = '([^']+)'/);
    assert.ok(match, 'watchdog.mjs 里有同样的 cron id');
    assert.equal(match[1], DUTY_CRON_ID, '两个模块的 cron id 必须一致');
  } finally {
    cleanupDir(dir);
  }
});

test('状态接口给总览页用：字段齐、边界写在负载里', async () => {
  const dir = tmpDir();
  try {
    const status = await getDutyHeartbeatStatus({
      dataDir: dir,
      store: readOnlyStore([DELIVERED_90]),
      now: NOW,
    });

    assert.equal(status.broken, true);
    assert.equal(typeof status.scope, 'string');
    assert.match(status.scope, /板面关着/);
    assert.equal(typeof status.pendingTail, 'object');
    assert.equal(typeof status.blankTail, 'object');
  } finally {
    cleanupDir(dir);
  }
});
