import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { computeDutyEvidence } from '../miniapps/mimic-tear/miniapp/node/view-model.mjs';
import { evaluateDuty } from '../miniapps/mimic-tear/miniapp/node/watchdog-rules.mjs';
import { runWatchdog } from '../miniapps/mimic-tear/miniapp/node/watchdog.mjs';
import { tmpDir, cleanupDir, makeCronDb } from './helpers/fixture.mjs';

const MINUTE = 60_000;
const NOW = Date.parse('2026-10-20T12:00:00Z');
const PERIOD = 30 * MINUTE;
const CRON_ID = '672fde94-0c52-466d-831e-e2919f49b64a';

/**
 * A runtime database carrying the duty cron's run log.
 *
 * The tables and the factory live in the shared fixture: their shape is the runtime's own,
 * and there is exactly one source for it now. What is left here is the part that belongs to
 * this file — which cron it is, and what the duty chain is called.
 *
 * @param {string} dir
 * @param {Array<{id:string, status:string, createdAt:number, deliveredAt?:number|null}>} runs
 * @returns {string} the database path
 */
function makeDutyCronDb(dir, runs) {
  return makeCronDb(dir, {
    cronId: CRON_ID,
    sessionId: 'sess-duty',
    definition: {
      schedulerId: 'sched-duty',
      agentName: 'boss',
      name: '大哥值班巡检',
      targetSessionId: 'sess-duty',
    },
    runs,
  });
}

/** Two handovers 390 minutes apart — the shape of the 2026-10-21 evening gap. */
const gapRuns = [
  { id: 'run-old', status: 'delivered', createdAt: NOW - 400 * MINUTE, deliveredAt: NOW - 400 * MINUTE },
  { id: 'run-new', status: 'delivered', createdAt: NOW - 10 * MINUTE, deliveredAt: NOW - 10 * MINUTE },
];

test('缺口一：补交班会抹掉漏班证据', async (t) => {
  await t.test('A1：旧判定看不见空档，证据看得见', () => {
    // The boss handed over five minutes ago — on time, as far as the stamp knows.
    const duty = evaluateDuty({ dutyIntervalMinutes: 30, lastRunAt: NOW - 5 * MINUTE }, NOW);
    assert.equal(duty.stale, false, '活性判定看不到空档：交班戳是新鲜的');

    const evidence = computeDutyEvidence({
      runs: gapRuns,
      periodMs: PERIOD,
      now: NOW,
      evidenceWindowMs: 45 * MINUTE,
    });

    assert.equal(evidence.missedRounds, 12, '应该触发而没触发的槽位：12');
    assert.equal(evidence.erasedOutage, true, '证据还在：这段空档被后来的交班盖住了');
    assert.equal(evidence.lastGap.gapMinutes, 390);
    assert.equal(evidence.lastGap.missedRounds, 12);
    assert.equal(evidence.lastGap.attempted, false, '这一段里调度器根本没触发');
  });

  await t.test('A2：watchdog 判 missed，漏轮数算得准', async () => {
    const dir = tmpDir();
    try {
      const dbPath = makeDutyCronDb(dir, gapRuns);
      writeFileSync(
        join(dir, 'patrol-config.json'),
        JSON.stringify({ enabled: true, intervalMinutes: 15, dutyIntervalMinutes: 30, lastRunAt: NOW - 5 * MINUTE }),
        'utf8',
      );

      const delivered = [];
      const result = await runWatchdog({
        dataDir: dir,
        dbPath,
        cronId: CRON_ID,
        now: NOW,
        deliver: async (message) => {
          delivered.push(message);
          return { ok: true };
        },
      });

      assert.equal(result.action, 'missed');
      assert.equal(result.evidence.missedRounds, 12);
      assert.equal(delivered.length, 1);
      assert.match(delivered[0].body, /漏了 12 轮/);
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('A4：同一段空档只报一次', async () => {
    const dir = tmpDir();
    try {
      const dbPath = makeDutyCronDb(dir, gapRuns);
      writeFileSync(
        join(dir, 'patrol-config.json'),
        JSON.stringify({ enabled: true, intervalMinutes: 15, dutyIntervalMinutes: 30, lastRunAt: NOW - 5 * MINUTE }),
        'utf8',
      );

      const deliver = async () => ({ ok: true });
      await runWatchdog({ dataDir: dir, dbPath, cronId: CRON_ID, now: NOW, deliver });
      const second = await runWatchdog({ dataDir: dir, dbPath, cronId: CRON_ID, now: NOW + MINUTE, deliver });

      assert.equal(second.action, 'none', '同一段空档不重复报');
      const log = readFileSync(join(dir, 'watchdog-alert.log'), 'utf8');
      const occurrences = log.split('\n').filter((line) => line.includes('漏了 12 轮')).length;
      assert.equal(occurrences, 1, '漏班证据在告警文件里只留一条');
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('口径：投递没成功的轮次不重复计数', () => {
    const runs = [
      { id: 'a', status: 'delivered', createdAt: NOW - 150 * MINUTE, deliveredAt: NOW - 150 * MINUTE },
      { id: 'b', status: 'pending', createdAt: NOW - 120 * MINUTE },
      { id: 'c', status: 'pending', createdAt: NOW - 90 * MINUTE },
      { id: 'd', status: 'pending', createdAt: NOW - 60 * MINUTE },
      { id: 'e', status: 'pending', createdAt: NOW - 30 * MINUTE },
      { id: 'f', status: 'delivered', createdAt: NOW, deliveredAt: NOW },
    ];

    const evidence = computeDutyEvidence({
      runs,
      periodMs: PERIOD,
      now: NOW,
      evidenceWindowMs: 45 * MINUTE,
    });

    assert.equal(evidence.missedRounds, 4, '四个槽位就是四轮，不是八轮');
    assert.equal(evidence.lastGap.missedRounds, 4);
    assert.equal(evidence.lastGap.attempted, true, '证据更强：调度器确实触发了，只是没投出去');
  });

  await t.test('口径：时间戳的毫秒抖动不能把 390 分钟算成 389 分钟', () => {
    // The runtime stamps handovers with a few milliseconds of jitter, so a gap that is
    // 390 minutes on the clock can measure 389m59.98s. The count has to stay on the
    // schedule's grid, or every gap silently loses a round.
    const runs = [
      { id: 'a', status: 'delivered', createdAt: NOW - 400 * MINUTE + 79, deliveredAt: NOW - 400 * MINUTE + 79 },
      { id: 'b', status: 'delivered', createdAt: NOW - 10 * MINUTE + 59, deliveredAt: NOW - 10 * MINUTE + 59 },
    ];
    const evidence = computeDutyEvidence({
      runs,
      periodMs: PERIOD,
      now: NOW,
      evidenceWindowMs: 45 * MINUTE,
    });
    assert.equal(evidence.missedRounds, 12, '390 分钟就是 12 轮，不因毫秒抖动少一轮');
    assert.equal(evidence.lastGap.gapMinutes, 390);
  });

  await t.test('口径：台账那四个窗口的数字必须对得上', () => {
    // 大哥 05:47 从投递记录直接算出的权威数字（槽位数 = floor(跨度 / 30min) - 1）：
    // 90m → 2、450m → 14、420m → 13、390m → 12。
    const cases = [
      { span: 90, missed: 2 },
      { span: 450, missed: 14 },
      { span: 420, missed: 13 },
      { span: 390, missed: 12 },
    ];
    for (const item of cases) {
      const from = NOW - item.span * MINUTE - 10 * MINUTE;
      const to = from + item.span * MINUTE;
      const evidence = computeDutyEvidence({
        runs: [
          { id: 'a', status: 'delivered', createdAt: from, deliveredAt: from },
          { id: 'b', status: 'delivered', createdAt: to, deliveredAt: to },
        ],
        periodMs: PERIOD,
        now: NOW,
        evidenceWindowMs: 45 * MINUTE,
      });
      assert.equal(evidence.lastGap.missedRounds, item.missed, `${item.span} 分钟跨度的漏轮数`);
    }
  });

  await t.test('没有运行记录时证据是零，不是报错', () => {
    const evidence = computeDutyEvidence({ runs: [], periodMs: PERIOD, now: NOW });
    assert.equal(evidence.missedRounds, 0);
    assert.equal(evidence.lastGap, null);
    assert.equal(evidence.erasedOutage, false);
  });

  await t.test('未来的记录不能解释过去的空档', () => {
    const runs = [
      { id: 'x', status: 'delivered', createdAt: NOW + 10 * MINUTE, deliveredAt: NOW + 10 * MINUTE },
    ];
    const evidence = computeDutyEvidence({ runs, periodMs: PERIOD, now: NOW });
    assert.equal(evidence.missedRounds, 0);
  });
});
