import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { appendAlert, buildDutyTruthLine } from '../miniapps/mimic-tear/miniapp/node/watchdog-alerts.mjs';
import { runWatchdog } from '../miniapps/mimic-tear/miniapp/node/watchdog.mjs';
import { PatrolStore } from '../miniapps/mimic-tear/miniapp/node/patrol-store.mjs';
import { readBoardSection, tmpDir, cleanupDir } from './helpers/fixture.mjs';

const MINUTE = 60_000;
const NOW = Date.parse('2026-10-20T12:00:00Z');

/** An alert record, with only the fields the caller cares about. */
function record(overrides = {}) {
  return {
    at: NOW,
    action: 'stale',
    title: '仿身泪滴 · 大哥掉线',
    body: '已 573 分钟没有交班',
    delivered: true,
    error: null,
    note: null,
    gapTo: null,
    ...overrides,
  };
}

test('告警要能进板面收件箱', async () => {
  const dir = tmpDir();
  try {
    const finding = await appendAlert(dir, record({ identity: 'stale:12345' }));
    assert.ok(finding, '异常类要发布到板面');

    const patrol = new PatrolStore(dir);
    const findings = await patrol.list();
    assert.equal(findings.length, 1);
    assert.equal(findings[0].title, '仿身泪滴 · 大哥掉线');
    assert.equal(findings[0].severity, 'high');
    assert.equal(findings[0].projectName, null, '它是全局事实，不挂在某个项目上');
  } finally {
    cleanupDir(dir);
  }
});

test('只有异常类进板面——正常与恢复不许刷屏', async () => {
  const dir = tmpDir();
  try {
    for (const action of ['heartbeat_run', 'recovered', 'none']) {
      const published = await appendAlert(dir, record({ action, title: `机器话：${action}` }));
      assert.equal(published, null, `${action} 不该进收件箱`);
    }
    const patrol = new PatrolStore(dir);
    assert.equal((await patrol.list()).length, 0, '收件箱要空');
  } finally {
    cleanupDir(dir);
  }
});

test('同一状态只转一次，状态变了才再转', async () => {
  const dir = tmpDir();
  try {
    await appendAlert(dir, record({ identity: 'stale:111' }));
    await appendAlert(dir, record({ identity: 'stale:111', at: NOW + MINUTE }));
    await appendAlert(dir, record({ identity: 'stale:111', at: NOW + 2 * MINUTE }));

    let patrol = new PatrolStore(dir);
    assert.equal((await patrol.list()).length, 1, '同一次掉线不刷屏');

    // A new outage (a new handover stamp) is a new state → published again.
    //
    // 它**并进**板面上那一条（4.2 的同类合并：全局结论同键就是同一格），所以条数还是 1，
    // 但板面看到的是**新状态**的内容——这才是「状态变了才再转」的可观察结果。
    await appendAlert(dir, record({
      identity: 'stale:222',
      at: NOW + 3 * MINUTE,
      body: '已 576 分钟没有交班',
    }));
    patrol = new PatrolStore(dir);
    const findings = await patrol.list();
    assert.equal(findings.length, 1, '同一条全局结论只占一格');
    assert.match(findings[0].body, /576/, '板面看到的是新状态');
  } finally {
    cleanupDir(dir);
  }
});

test('app 关着也能落盘——写的是板面自己的数据目录', async () => {
  const dir = tmpDir();
  try {
    // Nothing here needs a Mini App runtime: the watchdog is a separate process and the
    // board's data directory is all it writes to. That is the whole point of this path.
    await appendAlert(dir, record({ identity: 'stale:999' }));
    // 结论账住在板面状态的单一 store 里（`board-state.json`）——app 关着也一样落盘。
    const findings = readBoardSection(dir, 'findings');
    assert.equal(findings.length, 1, '结论必须写进板面自己的数据目录');
    assert.ok(existsSync(join(dir, 'watchdog-alert.log')), '告警日志也要写');
  } finally {
    cleanupDir(dir);
  }
});

test('toast 已经报过、但板面从没被告知时，板面仍然要收到', async () => {
  const dir = tmpDir();
  try {
    // The watchdog's state says "I told them" — the toast fired on 2026-10-22 18:22 — but
    // that alert only reached the log. The board's own ledger is empty, so the board still
    // has to be told. This is the hole that left the inbox empty for four days.
    writeFileSync(
      join(dir, 'patrol-config.json'),
      JSON.stringify({ enabled: true, intervalMinutes: 15, dutyIntervalMinutes: 30, lastRunAt: NOW - 6000 * MINUTE }),
      'utf8',
    );
    writeFileSync(
      join(dir, 'watchdog-state.json'),
      JSON.stringify({
        observedStale: true,
        notifiedStale: true,
        observedMissed: null,
        notifiedMissed: null,
        reportedGaps: [],
        staleSince: NOW - 6000 * MINUTE,
        lastNotifiedAt: NOW - 5000 * MINUTE,
        failedDeliveries: 0,
        checkedAt: NOW - 5000 * MINUTE,
      }),
      'utf8',
    );

    const result = await runWatchdog({
      dataDir: dir,
      dbPath: join(dir, 'no-such-db.sqlite'),
      now: NOW,
      deliver: async () => ({ ok: true }),
    });

    // The toast's own state machine says "nothing new" — and that is right: no spam.
    assert.equal(result.action, 'none', '已经报过就不该再弹一次 toast');
    // But the board was never told, so it must be told now.
    const patrol = new PatrolStore(dir);
    const findings = await patrol.list();
    assert.equal(findings.length, 1, '板面从没被告知 → 现在要收到');
    assert.match(findings[0].body, /分钟没有交班/);
    assert.match(findings[0].body, /上次交班/);
  } finally {
    cleanupDir(dir);
  }
});

test('板面 finding 里的时间与轮数是真的', () => {
  const duty = {
    lastRunAt: NOW - 573 * MINUTE,
    ageMinutes: 573,
    staleAfterMinutes: 45,
    missedRounds: 12,
  };
  const evidence = {
    missedRounds: 45,
    lastGap: {
      from: NOW - 660 * MINUTE,
      to: NOW - 270 * MINUTE,
      gapMinutes: 390,
      missedRounds: 12,
      attempted: false,
    },
    pendingTail: {
      slots: 1,
      since: NOW - 300 * MINUTE,
      runs: [{ runId: 'r2', status: 'pending', retryAttempt: 87, createdAt: NOW - 300 * MINUTE }],
    },
  };

  const truth = buildDutyTruthLine(duty, evidence);

  assert.match(truth, /上次交班/);
  assert.match(truth, /573 分钟前/);
  assert.match(truth, /漏 12 轮/);
  assert.match(truth, /调度记录累计漏 45 轮/);
  assert.match(truth, /最近一段空档/);
  assert.match(truth, /run_id=r2 status=pending retry_attempt=87/);
});
