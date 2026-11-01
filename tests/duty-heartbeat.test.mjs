import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  evaluateDutyHeartbeat,
  getDutyHeartbeatStatus,
  HEARTBEAT_CHECK_INTERVAL_MS,
  readHeartbeatState,
  RUNTIME_IDLE_GRACE_MS,
  runDutyHeartbeat,
} from '../miniapps/mimic-tear/miniapp/node/duty-heartbeat.mjs';

test('心跳的周期必须短于运行时的空闲寿命，否则首跳永远等不到', () => {
  // 2026-10-22 实测：运行时 08:15:37 拉起、08:20:30 被宿主关停（存活 291.8 秒）。
  // 周期曾是 5 分钟（300 秒）——差 7 秒，首跳等不到，那份刚发布的代码一次都没跑过。
  assert.ok(
    HEARTBEAT_CHECK_INTERVAL_MS < RUNTIME_IDLE_GRACE_MS,
    '心跳周期必须小于运行时空闲寿命，否则运行时先死、首跳永不发生',
  );
  assert.ok(HEARTBEAT_CHECK_INTERVAL_MS <= 60_000, '一个空闲窗口里要能落下好几跳');
});
import { resolveDutyChain } from '../miniapps/mimic-tear/miniapp/node/duty-chain.mjs';
import { readAlerts } from '../miniapps/mimic-tear/miniapp/node/watchdog-alerts.mjs';
import { tmpDir, cleanupDir } from './helpers/fixture.mjs';

const MINUTE = 60_000;
const NOW = Date.parse('2026-10-20T12:00:00Z');
const PERIOD = 30 * MINUTE;

/** The two generations of the duty cron: the old one deleted, the new one alive. */
const DEFINITIONS = [
  { cronId: 'old-cron', name: '大哥值班巡检', deletedAt: NOW - 60 * MINUTE, targetSessionId: 'mvs_old', schedulerId: 'sched-old' },
  { cronId: 'live-cron', name: '大哥值班巡检', deletedAt: null, targetSessionId: 'mvs_live', schedulerId: 'sched-live' },
];

/**
 * A store that can only read — the definitions and the run log.
 *
 * Anything else (a write to the runtime database, a change to the cron's definition) would
 * throw, which is how the boundary in C6 is enforced rather than merely asserted.
 */
function readOnlyStore(runs, definitions = DEFINITIONS) {
  return {
    listCronDefinitions() {
      return definitions;
    },
    listCronRunsFor(ids) {
      return runs.filter((run) => ids.includes(run.cronId));
    },
  };
}

const DELIVERED_90 = {
  cronId: 'live-cron',
  id: 'r1',
  status: 'delivered',
  createdAt: NOW - 90 * MINUTE,
  deliveredAt: NOW - 90 * MINUTE,
};

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
      { cronId: 'live-cron', id: 'r1', status: 'delivered', createdAt: NOW - 30 * MINUTE, deliveredAt: NOW - 30 * MINUTE },
      { cronId: 'live-cron', id: 'r2', status: 'pending', createdAt: NOW - 5 * MINUTE, retryAttempt: 12 },
    ],
    periodMs: PERIOD,
    now: NOW,
  });

  assert.equal(inFlight.broken, true, '有未投递的轮次 → 断链');
  assert.equal(inFlight.trigger, false, '宿主正在投 → 不补，否则双倍值班轮次');
  assert.equal(inFlight.reason, 'host_in_flight');

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
        { cronId: 'live-cron', id: 'r1', status: 'delivered', createdAt: NOW - 30 * MINUTE, deliveredAt: NOW - 30 * MINUTE },
        { cronId: 'live-cron', id: 'r2', status: 'pending', createdAt: NOW - 5 * MINUTE, retryAttempt: 12 },
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
        { cronId: 'live-cron', id: 'r1', status: 'delivered', createdAt: NOW - 30 * MINUTE, deliveredAt: NOW - 30 * MINUTE },
        { cronId: 'live-cron', id: 'r2', status: 'pending', createdAt: NOW - 5 * MINUTE, retryAttempt: 42, error: 'boom' },
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

    // The seed lives in the shared chain module — one place, not two literals that drift.
    const chainSource = readFileSync(
      fileURLToPath(new URL('../miniapps/mimic-tear/miniapp/node/duty-chain.mjs', import.meta.url)),
      'utf8',
    );
    const match = chainSource.match(/DUTY_CRON_SEED = '([^']+)'/);
    assert.ok(match, 'duty-chain.mjs 里有 seed');
    assert.equal(match[1], '672fde94-0c52-466d-831e-e2919f49b64a');
  } finally {
    cleanupDir(dir);
  }
});

test('D1：不传 now 时，写下的状态里 updatedAt 必须是真实时间戳', async () => {
  const dir = tmpDir();
  try {
    const before = Date.now();
    const result = await runDutyHeartbeat({
      dataDir: dir,
      store: readOnlyStore([DELIVERED_90]),
      sessionId: 'mvs_boss_session',
      agent: { async run() { return { status: 'finished', error: null }; } },
      // **no now** — this is the shape the production timer uses.
    });
    const after = Date.now();

    assert.equal(result.triggered, true);
    const state = await readHeartbeatState(dir);
    assert.equal(typeof state.updatedAt, 'number', 'updatedAt 不能是 null（那是 JSON.stringify(NaN)）');
    assert.ok(state.updatedAt >= before && state.updatedAt <= after, 'updatedAt 必须是这一次的时间戳');
    assert.ok(Number.isFinite(state.updatedAt));
  } finally {
    cleanupDir(dir);
  }
});

test('D2：cron id 指向已删定义时，明确报 misconfigured —— 不是 healthy', async () => {
  const dir = tmpDir();
  try {
    // The config pins a cron that has since been deleted.
    writeFileSync(
      join(dir, 'patrol-config.json'),
      JSON.stringify({ dutyIntervalMinutes: 30, dutyCronId: 'old-cron' }),
      'utf8',
    );

    const result = await runDutyHeartbeat({
      dataDir: dir,
      store: readOnlyStore([DELIVERED_90]),
      sessionId: 'mvs_boss_session',
      agent: { async run() { return { status: 'finished', error: null }; } },
      now: NOW,
    });

    assert.equal(result.reason, 'misconfigured', '不能静默 healthy');
    assert.equal(result.triggered, false, '配置不对时不补位');

    const alerts = await readAlerts(dir);
    assert.ok(alerts.some((alert) => alert.action === 'heartbeat_misconfigured'), '要显式写一条告警');
    const state = await readHeartbeatState(dir);
    assert.equal(state.lastResult, 'misconfigured');
    assert.equal(typeof state.updatedAt, 'number');
  } finally {
    cleanupDir(dir);
  }
});

test('D2：钉着活着的 cron 时，判定与按活 cron 手工算的一致', () => {
  const chain = resolveDutyChain(DEFINITIONS, { seedCronId: 'live-cron' });
  assert.equal(chain.active, true);
  assert.equal(chain.reason, 'ok');
  assert.equal(chain.targetCronId, 'live-cron');
  assert.equal(chain.targetSessionId, 'mvs_live');
  // The history lives under the deleted definition, and it is read too.
  assert.deepEqual(chain.cronIds.sort(), ['live-cron', 'old-cron']);
});

test('D2：内置种子已删、配置没钉时，不该报 misconfigured', () => {
  // The built-in seed points at a definition that has since been deleted. It is only a
  // hint for finding the family — treating it as a pin would make every install that has
  // not pinned anything yet report "misconfigured" and stop the heartbeat.
  const definitions = [
    { cronId: '672fde94-0c52-466d-831e-e2919f49b64a', name: '大哥值班巡检', deletedAt: NOW - 60 * MINUTE, targetSessionId: 'mvs_old', schedulerId: 'sched-old' },
    { cronId: 'live-cron', name: '大哥值班巡检', deletedAt: null, targetSessionId: 'mvs_live', schedulerId: 'sched-live' },
  ];
  const chain = resolveDutyChain(definitions, { seedCronId: '672fde94-0c52-466d-831e-e2919f49b64a' });

  assert.equal(chain.active, true, '种子不是钉子：没钉就该按名字找活的那个');
  assert.equal(chain.reason, 'ok');
  assert.equal(chain.targetCronId, 'live-cron');
  assert.equal(chain.pinnedCronId, null);
});

test('D2：显式钉种子那个 id，也是钉子 —— 死了要报', () => {
  // Pinning the seed's own id is still a decision: the user pinned it, and if it has been
  // deleted the configuration is stale — that has to be loud, not silently downgraded to
  // "follow whatever is alive now".
  const definitions = [
    { cronId: '672fde94-0c52-466d-831e-e2919f49b64a', name: '大哥值班巡检', deletedAt: NOW - 60 * MINUTE, targetSessionId: 'mvs_old', schedulerId: 'sched-old' },
    { cronId: 'live-cron', name: '大哥值班巡检', deletedAt: null, targetSessionId: 'mvs_live', schedulerId: 'sched-live' },
  ];
  const chain = resolveDutyChain(definitions, {
    pinnedCronId: '672fde94-0c52-466d-831e-e2919f49b64a',
    seedCronId: '672fde94-0c52-466d-831e-e2919f49b64a',
  });

  assert.equal(chain.active, false, '显式钉的 id 死了 → 是过期配置，不是种子');
  assert.equal(chain.reason, 'target_deleted');
  assert.equal(chain.pinnedCronId, '672fde94-0c52-466d-831e-e2919f49b64a');
});

test('D2：不钉任何 id 时，按名字找活的那个，不报 misconfigured', () => {
  const definitions = [
    { cronId: '672fde94-0c52-466d-831e-e2919f49b64a', name: '大哥值班巡检', deletedAt: NOW - 60 * MINUTE, targetSessionId: 'mvs_old', schedulerId: 'sched-old' },
    { cronId: 'live-cron', name: '大哥值班巡检', deletedAt: null, targetSessionId: 'mvs_live', schedulerId: 'sched-live' },
  ];
  const chain = resolveDutyChain(definitions, { seedCronId: '672fde94-0c52-466d-831e-e2919f49b64a' });

  assert.equal(chain.active, true, '没钉 → 按名字找活的那个');
  assert.equal(chain.reason, 'ok');
  assert.equal(chain.targetCronId, 'live-cron');
  assert.equal(chain.pinnedCronId, null);
});

test('D2：不钉任何 id 时，按名字找到活着的那个', () => {
  const chain = resolveDutyChain(DEFINITIONS, {});
  assert.equal(chain.active, true);
  assert.equal(chain.targetCronId, 'live-cron');
  assert.equal(chain.cronIds.length, 2, '两代都要读，历史不能丢');
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
    assert.equal(status.chain.active, true);
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------------
// G-10：恢复路径。断档要说得清、补位要能往前走、休息时不该补。
// ---------------------------------------------------------------------------

/** 写一份值班意图。 */
function writeIntent(dir, intent) {
  writeFileSync(join(dir, 'duty-intent.json'), JSON.stringify(intent), 'utf8');
}

test('G10：大哥在休息时，心跳不补位', async () => {
  const dir = tmpDir();
  try {
    writeIntent(dir, { mode: 'resting', since: NOW - 60 * MINUTE, requestedBy: '大老板', note: '' });
    const calls = [];
    const agent = { async run(input) { calls.push(input); return { status: 'finished', error: null }; } };

    const result = await runDutyHeartbeat({
      dataDir: dir, store: readOnlyStore([DELIVERED_90]), sessionId: 'mvs_boss', agent, now: NOW,
    });

    assert.equal(result.triggered, false, '被交代去休息时不该补位');
    assert.equal(result.reason, 'resting');
    assert.equal(calls.length, 0, '一次都不该调用');
    assert.equal(result.gap.source, 'resting');
    assert.equal(result.gap.gap.slots, 0, '休息期间不算漏班');
    assert.equal(result.gap.hole.slots, 2, '但洞还在——宿主照样没投递');
  } finally {
    cleanupDir(dir);
  }
});

test('G10：一趟补位覆盖整段空档，并把覆盖范围写进状态', async () => {
  const dir = tmpDir();
  try {
    const calls = [];
    const agent = { async run(input) { calls.push(input); return { status: 'finished', error: null }; } };

    const result = await runDutyHeartbeat({
      dataDir: dir, store: readOnlyStore([DELIVERED_90]), sessionId: 'mvs_boss', agent, now: NOW,
    });

    assert.equal(result.triggered, true);
    assert.equal(calls.length, 1, '一段空档只跑一趟，不逐槽重放');
    const state = await readHeartbeatState(dir);
    assert.equal(state.coveredThroughSlot, result.gap.uncovered.coverThroughSlot, '覆盖到最后一个未覆盖槽位');
    assert.equal(typeof state.coveredAt, 'number');
    assert.equal(state.gapRounds, result.gap.gap.rounds, '断了几轮要写下来');
  } finally {
    cleanupDir(dir);
  }
});

test('G10：空档继续往前推进时，会再补一次（覆盖标记不是死的）', async () => {
  const dir = tmpDir();
  try {
    const calls = [];
    const agent = { async run(input) { calls.push(input); return { status: 'finished', error: null }; } };

    const first = await runDutyHeartbeat({
      dataDir: dir, store: readOnlyStore([DELIVERED_90]), sessionId: 'mvs_boss', agent, now: NOW,
    });
    assert.equal(first.triggered, true);

    // 又过了一个值班周期，第 3 个空槽出现 —— 这时候该再补一次。
    const second = await runDutyHeartbeat({
      dataDir: dir, store: readOnlyStore([DELIVERED_90]), sessionId: 'mvs_boss', agent, now: NOW + 30 * MINUTE,
    });
    assert.equal(second.triggered, true, '新的空槽该再补一次');
    assert.equal(second.gap.uncovered.nextSlot, 3, '从还没补的那一槽开始');
    assert.equal(calls.length, 2);
  } finally {
    cleanupDir(dir);
  }
});

test('G10：补位失败后还能重试（失败的那轮不算补过）', async () => {
  const dir = tmpDir();
  try {
    const failed = await runDutyHeartbeat({
      dataDir: dir,
      store: readOnlyStore([DELIVERED_90]),
      sessionId: 'mvs_boss',
      agent: { async run() { throw new Error('模拟补位失败'); } },
      now: NOW,
    });
    assert.equal(failed.result, 'error');

    const state = await readHeartbeatState(dir);
    assert.equal(state.coveredThroughSlot ?? null, null, '失败的那轮不能算已覆盖');

    // 下一跳必须还能再试一次 —— 旧实现会把失败记成「这一槽补过了」，于是永不重试。
    const calls = [];
    const retry = await runDutyHeartbeat({
      dataDir: dir,
      store: readOnlyStore([DELIVERED_90]),
      sessionId: 'mvs_boss',
      agent: { async run(input) { calls.push(input); return { status: 'finished', error: null }; } },
      now: NOW + MINUTE,
    });
    assert.equal(retry.triggered, true, '失败后要能重试');
    assert.equal(calls.length, 1);
  } finally {
    cleanupDir(dir);
  }
});

test('G10：提示词里要带断档时长 —— 断四个小时不能汇报成普通迟到', async () => {
  const dir = tmpDir();
  try {
    const calls = [];
    const agent = { async run(input) { calls.push(input); return { status: 'finished', error: null }; } };

    await runDutyHeartbeat({
      dataDir: dir, store: readOnlyStore([DELIVERED_90]), sessionId: 'mvs_boss', agent, now: NOW,
    });

    assert.equal(calls.length, 1);
    assert.match(calls[0].text, /你断了 \d+ 分钟/, '断多久必须写进提示词');
    assert.match(calls[0].text, /轮值班/);
    assert.match(calls[0].text, /不要当成普通迟到/);
    assert.match(calls[0].text, /不要去重放/, '补的是当前状态，不是重放历史');
  } finally {
    cleanupDir(dir);
  }
});
