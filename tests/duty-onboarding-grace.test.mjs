import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDutyStatus } from '../miniapps/mimic-tear/miniapp/node/duty-status.mjs';

/**
 * 上岗宽限期：意图刚切到 on-duty 时，交班戳还是上一次上岗前留下的旧戳。
 *
 * 2026-11-01 上岗实测：12:12:22 上岗 → 12:13:21 看门狗就报了「大哥掉线」——
 * 交班戳是 10-30 的旧戳，`stale` 立刻成立，而大哥的第一轮还没跑完。
 * **那不是掉线，是刚上岗。**
 *
 * 宽限期只压住**告警**（`alertable`），不碰 `stale`——板面的值班灯照亮事实，
 * 告警只报真故障。
 */

const NOW = Date.UTC(2026, 10, 1, 12, 0);
const MIN = 60_000;

test('刚上岗：灯照亮事实，但不报掉线', () => {
  const status = buildDutyStatus({
    // 上岗前留下的旧戳（10-30），早就 stale。
    config: { lastRunAt: NOW - 5 * 24 * 60 * MIN, intervalMinutes: 15, dutyIntervalMinutes: 30 },
    findings: [],
    intent: { mode: 'on-duty', since: NOW - 1 * MIN, requestedBy: '大老板' },
    now: NOW,
  });
  assert.equal(status.stale, true, '灯照亮事实——交班戳确实很旧');
  assert.equal(status.alertable, false, '但不上岗一分钟就报掉线是误报');
});

test('过了宽限期：真掉线就报', () => {
  const status = buildDutyStatus({
    config: { lastRunAt: NOW - 5 * 24 * 60 * MIN, intervalMinutes: 15, dutyIntervalMinutes: 30 },
    findings: [],
    intent: { mode: 'on-duty', since: NOW - 60 * MIN, requestedBy: '大老板' },
    now: NOW,
  });
  assert.equal(status.stale, true);
  assert.equal(status.alertable, true, '宽限期过了，报掉线才对');
});

test('休息期不报——这条不能被宽限期改动', () => {
  const status = buildDutyStatus({
    config: { lastRunAt: NOW - 5 * 24 * 60 * MIN, intervalMinutes: 15, dutyIntervalMinutes: 30 },
    findings: [],
    intent: { mode: 'resting', since: NOW - 1 * MIN, requestedBy: '大老板' },
    now: NOW,
  });
  assert.equal(status.stale, true);
  assert.equal(status.alertable, false, '休息不是故障');
});

test('在岗且健康：不报', () => {
  const status = buildDutyStatus({
    config: { lastRunAt: NOW - 2 * MIN, intervalMinutes: 15, dutyIntervalMinutes: 30 },
    findings: [],
    intent: { mode: 'on-duty', since: NOW - 60 * MIN, requestedBy: '大老板' },
    now: NOW,
  });
  assert.equal(status.stale, false);
  assert.equal(status.alertable, false);
});
