import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildDutyHandoverSummary,
  computeDutyGap,
  describeDuration,
} from '../miniapps/mimic-tear/miniapp/node/duty-gap.mjs';
import { makeDutyBoardDb, tmpDir, cleanupDir } from './helpers/fixture.mjs';

const CLI_PATH = fileURLToPath(new URL('../miniapps/mimic-tear/miniapp/node/patrol-cli.mjs', import.meta.url));

const MINUTE = 60_000;
const PERIOD = 30 * MINUTE;

/** The moment the host last managed to deliver a duty round. */
const ANCHOR = Date.parse('2026-10-27T13:07:00Z');

/**
 * A blank tail as `computeDutyEvidence` would produce it: the slots between the last
 * delivery and now, with nobody having created a run for them.
 */
function blankTail(slots) {
  return {
    slots,
    since: slots > 0 ? ANCHOR + MINUTE * 30 : null,
    firstSlot: slots > 0 ? 1 : null,
    lastSlot: slots > 0 ? slots : null,
  };
}

/** The intent: on duty, with no switch on record. */
const ON_DUTY = { mode: 'on-duty', since: null, requestedBy: null, note: '' };

test('断链时：空档算成漏班，断多久、断几轮都要说得出', () => {
  const now = ANCHOR + 90 * MINUTE + MINUTE;
  const gap = computeDutyGap({
    blankTail: blankTail(3),
    anchor: ANCHOR,
    periodMs: PERIOD,
    now,
    intent: ON_DUTY,
    coveredThroughSlot: null,
  });

  assert.equal(gap.source, 'chain-break');
  assert.equal(gap.onDuty, true);
  // The whole hole: three rounds nobody triggered. It starts at the **first missing
  // round** (13:37), not at the last delivery (13:07) — between those two the boss was
  // on time.
  assert.equal(gap.hole.slots, 3);
  assert.equal(gap.hole.since, ANCHOR + 30 * MINUTE);
  assert.equal(gap.hole.minutes, 61, '从第一个空槽算起，到现在已经过了 61 分钟');
  // The gap: same three rounds, because the boss was never told to rest.
  assert.equal(gap.gap.slots, 3);
  assert.equal(gap.gap.rounds, 3);
  assert.equal(gap.gap.since, ANCHOR + 30 * MINUTE);
  assert.equal(gap.gap.minutes, 61);
  assert.equal(gap.uncovered.slots, 3);
  assert.equal(gap.uncovered.nextSlot, 1);
  assert.equal(gap.uncovered.coverThroughSlot, 3);
  assert.equal(gap.coverable, true);
});

test('休息期的空档不算漏班——从本次上岗时刻起算', () => {
  const now = ANCHOR + 91 * MINUTE;
  // 上岗时刻落在第 2 轮空档中间：第 1 轮是休息期间留下的，不算漏班。
  const gap = computeDutyGap({
    blankTail: blankTail(3),
    anchor: ANCHOR,
    periodMs: PERIOD,
    now,
    intent: { mode: 'on-duty', since: ANCHOR + 60 * MINUTE, requestedBy: '大老板', note: '' },
    coveredThroughSlot: null,
  });

  assert.equal(gap.source, 'chain-break');
  assert.equal(gap.dutyStart, ANCHOR + 60 * MINUTE);
  // The hole is still three rounds — that is what the scheduler never triggered.
  assert.equal(gap.hole.slots, 3);
  // But only the rounds after the boss came back on duty count as missed duty.
  assert.equal(gap.gap.slots, 2, '第 1 轮是休息期间留下的');
  assert.equal(gap.gap.since, ANCHOR + 60 * MINUTE);
  assert.equal(gap.gap.rounds, 2);
});

test('大哥正在休息：不算漏班，也不补位', () => {
  const now = ANCHOR + 300 * MINUTE;
  const gap = computeDutyGap({
    blankTail: blankTail(9),
    anchor: ANCHOR,
    periodMs: PERIOD,
    now,
    intent: { mode: 'resting', since: ANCHOR + 30 * MINUTE, requestedBy: '大老板', note: '' },
    coveredThroughSlot: null,
  });

  assert.equal(gap.source, 'resting');
  assert.equal(gap.onDuty, false);
  assert.equal(gap.coverable, false, '被交代去休息时不该补位');
  assert.equal(gap.gap.slots, 0, '休息期间不是漏班');
  assert.equal(gap.hole.slots, 9, '但洞还在——宿主照样没投递');
});

test('大哥在休息时：即使上岗前就断了链，也不该能补位', () => {
  const now = ANCHOR + 300 * MINUTE;
  // 休息从第 8 轮开始；第 1~6 轮的空槽在它之前 —— 那是它**上岗前**就断的链，
  // 那些槽位仍然算漏班。但它现在在休息，所以一条都不该补。
  const gap = computeDutyGap({
    blankTail: blankTail(9),
    anchor: ANCHOR,
    periodMs: PERIOD,
    now,
    intent: { mode: 'resting', since: ANCHOR + 210 * MINUTE, requestedBy: '大老板', note: '' },
    coveredThroughSlot: null,
  });

  assert.equal(gap.source, 'resting');
  assert.equal(gap.gap.slots, 6, '上岗前断的链，那些槽位仍然算漏班（第 7 轮正好落在休息起点上）');
  assert.equal(gap.uncovered.slots, 6);
  assert.equal(gap.coverable, false, '现在在休息，一条都不该补');
});

test('已补过的槽位不再重复补；新增的空槽还会再补', () => {
  const now = ANCHOR + 90 * MINUTE + MINUTE;
  const first = computeDutyGap({
    blankTail: blankTail(3),
    anchor: ANCHOR,
    periodMs: PERIOD,
    now,
    intent: ON_DUTY,
    coveredThroughSlot: null,
  });
  assert.equal(first.uncovered.slots, 3);

  // 补完一遍之后：覆盖到第 3 轮。
  const afterCover = computeDutyGap({
    blankTail: blankTail(3),
    anchor: ANCHOR,
    periodMs: PERIOD,
    now,
    intent: ON_DUTY,
    coveredThroughSlot: 3,
    coveredAt: now,
  });
  assert.equal(afterCover.uncovered.slots, 0, '同一段不重复补');
  assert.equal(afterCover.uncovered.nextSlot, null);
  assert.equal(afterCover.coverable, false);
  assert.equal(afterCover.covered.slots, 3);
  assert.equal(afterCover.covered.throughSlot, 3);

  // 又过了一个周期，第 4 轮空档出现 —— 这时候该再补一次。
  const later = computeDutyGap({
    blankTail: blankTail(4),
    anchor: ANCHOR,
    periodMs: PERIOD,
    now: now + 30 * MINUTE,
    intent: ON_DUTY,
    coveredThroughSlot: 3,
    coveredAt: now,
  });
  assert.equal(later.uncovered.slots, 1, '新增的那一轮还没补');
  assert.equal(later.uncovered.nextSlot, 4);
  assert.equal(later.coverable, true);
});

test('没有空档时：一切正常，没有洞也没有漏班', () => {
  const gap = computeDutyGap({
    blankTail: blankTail(0),
    anchor: ANCHOR,
    periodMs: PERIOD,
    now: ANCHOR + 10 * MINUTE,
    intent: ON_DUTY,
    coveredThroughSlot: null,
  });

  assert.equal(gap.source, 'none');
  assert.equal(gap.hole.slots, 0);
  assert.equal(gap.gap.slots, 0);
  assert.equal(gap.coverable, false);
});

test('时长要说得像人话', () => {
  assert.equal(describeDuration(0), '不到 1 分钟');
  assert.equal(describeDuration(45), '45 分钟');
  assert.equal(describeDuration(90), '1 小时 30 分');
  assert.equal(describeDuration(60 * 24 * 4 + 60 * 14 + 13), '4 天 14 小时 13 分');
  assert.equal(describeDuration(null), '未知');
});

test('上岗摘要：说清断多久、断几轮、还欠几轮', () => {
  const now = ANCHOR + 91 * MINUTE;
  const gap = computeDutyGap({
    blankTail: blankTail(3),
    anchor: ANCHOR,
    periodMs: PERIOD,
    now,
    intent: ON_DUTY,
    coveredThroughSlot: null,
  });

  const summary = buildDutyHandoverSummary(gap, {
    now,
    managedCount: 1,
    pendingDecisions: 93,
  });

  assert.match(summary, /上岗摘要/);
  assert.match(summary, /1 小时 1 分/, '断档时长要如实说');
  assert.match(summary, /3 轮/);
  assert.match(summary, /还欠 3 轮/, '欠几轮要说出来');
  assert.match(summary, /93 件等你拍板/);
  assert.match(summary, /板面关着时补不了/, '边界要写明，不能让人以为一直被看着');
  assert.match(summary, /不是重放/, '补的是状态不是重放，要写明');
});

test('大哥在休息时，摘要不把它说成漏班', () => {
  const now = ANCHOR + 300 * MINUTE;
  const gap = computeDutyGap({
    blankTail: blankTail(9),
    anchor: ANCHOR,
    periodMs: PERIOD,
    now,
    intent: { mode: 'resting', since: ANCHOR + 30 * MINUTE, requestedBy: '大老板', note: '' },
    coveredThroughSlot: null,
  });

  const summary = buildDutyHandoverSummary(gap, { now, managedCount: 1, pendingDecisions: 93 });

  assert.match(summary, /休息/);
  assert.doesNotMatch(summary, /漏班 9 轮/);
  assert.doesNotMatch(summary, /还欠 9 轮/);
});

// ---------------------------------------------------------------------------
// CLI：大哥上线后拿到的那张单子。
// ---------------------------------------------------------------------------

/** Run the real CLI against an isolated database and data directory. */
function runCli(dbPath, dataDir, args) {
  const stdout = execFileSync(
    process.execPath,
    [CLI_PATH, ...args, '--db', dbPath, '--data-dir', dataDir],
    { encoding: 'utf8' },
  );
  return JSON.parse(stdout);
}

/** A duty chain that delivered once and then went quiet. */
function makeBrokenChainDb(dir) {
  const deliveredAt = Date.now() - 95 * MINUTE;
  return makeDutyBoardDb(dir, {
    cronId: 'live-cron',
    sessionId: 'sess-duty',
    definition: { name: '大哥值班巡检', targetSessionId: 'sess-duty' },
    runs: [{ id: 'r1', status: 'delivered', createdAt: deliveredAt, deliveredAt }],
  });
}

test('CLI gap：打印上岗摘要，说清断了多久、还欠几轮', () => {
  const dir = tmpDir();
  try {
    const dbPath = makeBrokenChainDb(dir);
    const result = runCli(dbPath, dir, ['gap']);

    assert.equal(result.reason, 'blank_slot', '链断了，应该能补');
    assert.ok(result.gap.hole.slots >= 2, '空洞被算出来了');
    assert.match(result.summary, /上岗摘要/);
    assert.match(result.summary, /断档：/);
    assert.match(result.summary, /还欠 \d+ 轮/);
    assert.match(result.summary, /板面关着时补不了/);
  } finally {
    cleanupDir(dir);
  }
});

test('CLI gap reset：没有理由就拒绝——解除覆盖是一次决定', () => {
  const dir = tmpDir();
  try {
    const dbPath = makeBrokenChainDb(dir);
    assert.throws(
      () => runCli(dbPath, dir, ['gap', 'reset']),
      (error) => {
        assert.equal(error.status, 2, '用法错误要退出码 2');
        assert.match(String(error.stderr), /必须有理由/);
        return true;
      },
    );
  } finally {
    cleanupDir(dir);
  }
});

test('CLI gap reset：清掉覆盖标记，并把理由记下来', () => {
  const dir = tmpDir();
  try {
    const dbPath = makeBrokenChainDb(dir);
    writeFileSync(
      join(dir, 'duty-heartbeat.json'),
      JSON.stringify({ coveredThroughSlot: 5, coveredAt: Date.now() - 1000, lastTriggeredSlot: 3 }),
      'utf8',
    );

    const result = runCli(dbPath, dir, ['gap', 'reset', '大老板 2026-11-01 原话：重新补一遍']);
    assert.equal(result.ok, true);
    assert.equal(result.clearedThroughSlot, 5);

    const state = JSON.parse(readFileSync(join(dir, 'duty-heartbeat.json'), 'utf8'));
    assert.equal(state.coveredThroughSlot, null, '覆盖标记要真的被清掉');
    assert.equal(state.coveredAt, null);
    assert.match(state.resetReason, /重新补一遍/, '理由要留着');
    assert.equal(typeof state.resetAt, 'number');
  } finally {
    cleanupDir(dir);
  }
});
