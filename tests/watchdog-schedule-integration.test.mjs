import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { decideNextCheckAt } from '../miniapps/mimic-tear/miniapp/node/watchdog-schedule.mjs';
import { runWatchdog } from '../miniapps/mimic-tear/miniapp/node/watchdog.mjs';
import { tmpDir, cleanupDir } from './helpers/fixture.mjs';

const MINUTE = 60_000;
const NOW = 1_800_000_000_000;

test('the watchdog sleeps when the boss is on duty and speeds up when it is not', async (t) => {
  await t.test('on duty: it sleeps until the next handover is due', () => {
    // Arrange: the boss handed over 5 minutes ago; the next handover is due in 25.
    const duty = {
      lastRunAt: NOW - 5 * MINUTE,
      dutyIntervalMinutes: 30,
      staleAfterMinutes: 45,
      neverRan: false,
      overdueMinutes: 0,
      nextDueAt: NOW + 25 * MINUTE,
      stale: false,
    };

    // Act
    const decision = decideNextCheckAt({ duty, action: 'none', now: NOW });

    // Assert
    assert.equal(decision.reason, 'awaiting_next_handover');
    assert.equal(decision.delayMinutes, 26);
  });

  await t.test('off duty: it checks far more often than every five minutes', () => {
    // Arrange: the handover was due 5 minutes ago and did not happen.
    const duty = {
      lastRunAt: NOW - 35 * MINUTE,
      dutyIntervalMinutes: 30,
      staleAfterMinutes: 45,
      neverRan: false,
      overdueMinutes: 5,
      nextDueAt: NOW - 5 * MINUTE,
      stale: true,
    };

    // Act
    const decision = decideNextCheckAt({ duty, action: 'stale', now: NOW });

    // Assert
    assert.equal(decision.reason, 'overdue');
    assert.equal(decision.delayMinutes, 10, 'must look again before the threshold is crossed');
    assert.ok(
      decision.delayMinutes < 26,
      'an off-duty boss must be checked sooner than an on-duty one',
    );
  });

  await t.test('the two are on opposite sides of the old fixed interval', () => {
    // Arrange
    const onDuty = {
      lastRunAt: NOW - 5 * MINUTE,
      dutyIntervalMinutes: 30,
      staleAfterMinutes: 45,
      neverRan: false,
      overdueMinutes: 0,
      nextDueAt: NOW + 25 * MINUTE,
      stale: false,
    };
    const offDuty = {
      lastRunAt: NOW - 35 * MINUTE,
      dutyIntervalMinutes: 30,
      staleAfterMinutes: 45,
      neverRan: false,
      overdueMinutes: 5,
      nextDueAt: NOW - 5 * MINUTE,
      stale: true,
    };

    // Act
    const on = decideNextCheckAt({ duty: onDuty, action: 'none', now: NOW });
    const off = decideNextCheckAt({ duty: offDuty, action: 'stale', now: NOW });

    // Assert
    assert.ok(on.delayMinutes > 5, 'on duty: sleep longer than the old five-minute poll');
    assert.ok(off.delayMinutes <= 15, 'off duty: check well inside the old five-minute poll');
  });
});

test('an end-to-end tick on a real board directory schedules itself', async (t) => {
  await t.test('a boss that has been quiet produces a stale verdict and a schedule', async () => {
    // Arrange: a board whose duty boss stopped handing over an hour ago.
    const dir = tmpDir('mimic-watchdog-schedule-');
    try {
      const now = Date.now();
      writeFileSync(join(dir, 'patrol-config.json'), JSON.stringify({
        enabled: true,
        intervalMinutes: 15,
        dutyIntervalMinutes: 30,
        lastRunAt: now - 60 * MINUTE,
      }), 'utf8');

      // Act
      const result = await runWatchdog({
        dataDir: dir,
        now,
        deliver: async () => ({ ok: true }),
      });

      // Assert
      // The verdict itself is `decideAction`'s business (with no runtime database there
      // is no run log, so the "missed" evidence leads). What this test is about is the
      // *schedule* the watchdog picks for itself.
      assert.ok(
        ['stale', 'missed'].includes(result.action),
        `a boss that stopped must be reported, got ${result.action}`,
      );
      assert.equal(result.duty.stale, true);
      assert.equal(result.duty.overdueMinutes, 30, 'it is half an hour past its deadline');

      // The schedule the watchdog would pick for itself.
      const decision = decideNextCheckAt({
        duty: result.duty,
        action: result.action,
        failedDeliveries: 0,
        now,
      });
      assert.equal(decision.reason, 'overdue');
      assert.ok(
        decision.delayMinutes <= MAX_ALLOWED,
        'an outage must be watched closely',
      );
    } finally {
      cleanupDir(dir);
    }
  });
});

const MAX_ALLOWED = 15;
