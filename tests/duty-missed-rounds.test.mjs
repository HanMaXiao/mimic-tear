import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDutyStatus, computeDutyEvidence } from '../miniapps/mimic-tear/miniapp/node/duty-status.mjs';

/**
 * 漏班有四个数：238（洞的规模）/ 97（纯算术）/ 526（历史累计）/ 0（权威口径）。
 *
 * 2026-11-01 上岗轮大哥查出来的：事实表给模型的是 97（纯算术 `ceil(ageMinutes/period)-1`），
 * 而权威口径是 0 —— 上岗之前的洞是「还没上岗」，休息期也不该算漏班。模型每轮读表都被那个
 * 97 误导，以为自己漏了 97 班。
 *
 * 这里的修法：**同一个词只留一个意思**。
 *  - `missedRounds` = 权威口径（在岗时该交班却没交上的班次）。
 *  - `missedRoundsByAge` = 纯算术，单独一个名字，只给「按交班戳折算」这类文案用。
 *  - `missedRoundsSource` = 说清这次用的是哪个口径。
 */

const PERIOD = 30 * 60_000;
const AT = (minutes) => Date.UTC(2026, 10, 1, 0, 0) + minutes * 60_000;

/** 两次成功交班，中间空了 `gapMinutes` 分钟。 */
function runsWithGap(gapMinutes) {
  return [
    { status: 'delivered', createdAt: AT(0), deliveredAt: AT(0) },
    { status: 'delivered', createdAt: AT(gapMinutes), deliveredAt: AT(gapMinutes) },
  ];
}

test('不传上岗分界线时，证据口径仍然是历史累计', () => {
  // 看门狗与心跳要的是「历史一共漏了多少」——那是另一个量，不受分界线影响。
  const evidence = computeDutyEvidence({
    runs: runsWithGap(240),
    periodMs: PERIOD,
    now: AT(240),
  });
  assert.equal(evidence.missedRounds, 7, '240 分钟的洞 = 8 个班次 - 1');
});

test('传了上岗分界线，只数在岗时漏的班次', () => {
  // 洞横跨「还没上岗」和「在岗」两段：前 240 分钟是休息期留下的，后 60 分钟是在岗。
  const evidence = computeDutyEvidence({
    runs: runsWithGap(300),
    periodMs: PERIOD,
    now: AT(300),
    boundary: AT(240),
  });
  assert.equal(evidence.missedRounds, 1, '在岗那 60 分钟只欠 1 轮；上岗之前的洞不算漏班');
});

test('休息期没有班次可漏', () => {
  const evidence = computeDutyEvidence({
    runs: runsWithGap(300),
    periodMs: PERIOD,
    now: AT(300),
    boundary: AT(240),
    onDuty: false,
  });
  assert.equal(evidence.missedRounds, 0, '休息不是故障');
});

test('事实表用权威口径，纯算术单独留一个名字', () => {
  const evidence = computeDutyEvidence({
    runs: runsWithGap(300),
    periodMs: PERIOD,
    now: AT(300),
    boundary: AT(240),
  });
  const status = buildDutyStatus({
    config: { lastRunAt: AT(0), intervalMinutes: 15, dutyIntervalMinutes: 30 },
    findings: [],
    evidence,
    now: AT(300),
  });
  assert.equal(status.missedRounds, 1, '权威口径');
  assert.equal(status.missedRoundsSource, 'evidence');
  assert.equal(status.missedRoundsByAge, 9, '纯算术的口径另存一个名字');
});

test('没有证据可算时退回纯算术，并说清用的是哪个口径', () => {
  const status = buildDutyStatus({
    config: { lastRunAt: AT(0), intervalMinutes: 15, dutyIntervalMinutes: 30 },
    findings: [],
    now: AT(300),
  });
  assert.equal(status.missedRoundsSource, 'age-arithmetic');
  assert.equal(status.missedRounds, 9);
});

test('「没有证据」不能被当成「证据说漏了 0 轮」', () => {
  // `Number.isFinite(Number(null))` 是 true（`Number(null)` 是 0）——所以判「能不能转成数」
  // 会把「没有证据」误当成「证据说 0 轮」，那就把两个口径又混回去了。
  const status = buildDutyStatus({
    config: { lastRunAt: AT(0), intervalMinutes: 15, dutyIntervalMinutes: 30 },
    findings: [],
    evidence: { missedRounds: null },
    now: AT(300),
  });
  assert.equal(status.missedRoundsSource, 'age-arithmetic', 'null 不是证据');
  assert.equal(status.missedRounds, 9, '退回纯算术，而不是 0');
});

test('从没交过班：漏班是「不知道」，不是 0', () => {
  const status = buildDutyStatus({
    config: { lastRunAt: null, intervalMinutes: 15, dutyIntervalMinutes: 30 },
    findings: [],
    now: AT(300),
  });
  assert.equal(status.missedRounds, null);
  assert.equal(status.neverRan, true);
});
