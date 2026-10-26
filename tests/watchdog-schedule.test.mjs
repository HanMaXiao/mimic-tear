import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decideNextCheckAt,
  MAX_CHECK_INTERVAL_MINUTES,
  MIN_CHECK_INTERVAL_MINUTES,
} from '../miniapps/mimic-tear/miniapp/node/watchdog-schedule.mjs';

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

/** A duty status for a boss that is on schedule: handed over 5 minutes ago. */
function healthyDuty(overrides = {}) {
  return {
    lastRunAt: NOW - 5 * MINUTE,
    dutyIntervalMinutes: 30,
    staleAfterMinutes: 45,
    neverRan: false,
    overdueMinutes: 0,
    nextDueAt: NOW + 25 * MINUTE,
    stale: false,
    ...overrides,
  };
}

test('watchdog sleeps until the next handover is due', async (t) => {
  await t.test('a boss on schedule: sleep until just after the next handover is due', () => {
    // Arrange
    const duty = healthyDuty();

    // Act
    const decision = decideNextCheckAt({ duty, action: 'none', now: NOW });

    // Assert
    assert.equal(decision.reason, 'awaiting_next_handover');
    // The next handover is due in 25 minutes; check a minute after that, not 5 minutes from now.
    assert.equal(decision.delayMinutes, 26, 'must wait for the due moment, plus a grace minute');
    assert.equal(decision.nextCheckAt, NOW + 26 * MINUTE);
  });

  await t.test('the wait is far longer than the old fixed five minutes', () => {
    // Arrange
    const duty = healthyDuty();

    // Act
    const decision = decideNextCheckAt({ duty, action: 'none', now: NOW });

    // Assert
    assert.ok(
      decision.delayMinutes > 5,
      `a healthy boss must not be checked every five minutes (got ${decision.delayMinutes})`,
    );
  });

  await t.test('a handover that is already late is still noticed promptly', () => {
    // Arrange: nextDueAt already passed, but overdueMinutes says it is not overdue yet.
    const duty = healthyDuty({ nextDueAt: NOW - 2 * MINUTE });

    // Act
    const decision = decideNextCheckAt({ duty, action: 'none', now: NOW });

    // Assert
    assert.equal(decision.reason, 'fallback_period');
    assert.ok(
      decision.delayMinutes >= MIN_CHECK_INTERVAL_MINUTES,
      'must never schedule less than the floor',
    );
  });
});

test('watchdog checks more often when the boss is overdue', async (t) => {
  await t.test('an overdue boss: check before the stale threshold is crossed', () => {
    // Arrange: the handover was due 5 minutes ago and did not happen.
    const duty = healthyDuty({
      nextDueAt: NOW - 5 * MINUTE,
      overdueMinutes: 5,
      stale: true,
    });

    // Act
    const decision = decideNextCheckAt({ duty, action: 'stale', now: NOW });

    // Assert
    assert.equal(decision.reason, 'overdue');
    // until stale = 45 - (30 + 5) = 10 minutes
    assert.equal(decision.delayMinutes, 10, 'must look again before the threshold is crossed');
  });

  await t.test('a long-overdue boss is checked within the cap', () => {
    // Arrange: overdue by a lot.
    const duty = healthyDuty({
      nextDueAt: NOW - 600 * MINUTE,
      overdueMinutes: 600,
      stale: true,
    });

    // Act
    const decision = decideNextCheckAt({ duty, action: 'stale', now: NOW });

    // Assert
    assert.equal(decision.reason, 'overdue');
    assert.ok(
      decision.delayMinutes <= MAX_CHECK_INTERVAL_MINUTES,
      'must never sleep longer than the cap, or the outage goes unnoticed',
    );
  });
});

test('watchdog retries briskly when a delivery failed', async (t) => {
  await t.test('a failed delivery is retried within five minutes', () => {
    // Arrange
    const duty = healthyDuty();

    // Act
    const decision = decideNextCheckAt({ duty, action: 'stale', failedDeliveries: 1, now: NOW });

    // Assert
    assert.equal(decision.reason, 'delivery_failed');
    assert.equal(decision.delayMinutes, 5, 'a failed delivery is the one thing that must not wait');
  });

  await t.test('a failed delivery outranks a healthy boss', () => {
    // Arrange
    const duty = healthyDuty();

    // Act
    const decision = decideNextCheckAt({ duty, action: 'none', failedDeliveries: 3, now: NOW });

    // Assert
    assert.equal(decision.reason, 'delivery_failed');
  });
});

test('watchdog has a sane schedule for a boss that never ran', async (t) => {
  await t.test('never ran: fall back to the duty period', () => {
    // Arrange
    const duty = {
      lastRunAt: null,
      dutyIntervalMinutes: 30,
      staleAfterMinutes: 45,
      neverRan: true,
      overdueMinutes: null,
      nextDueAt: NOW + 30 * MINUTE,
    };

    // Act
    const decision = decideNextCheckAt({ duty, action: 'none', now: NOW });

    // Assert
    assert.equal(decision.reason, 'never_ran');
    assert.equal(decision.delayMinutes, 30);
  });
});

test('the schedule is always bounded', async (t) => {
  const cases = [
    { label: 'healthy', duty: healthyDuty(), action: 'none' },
    { label: 'overdue', duty: healthyDuty({ nextDueAt: NOW - MINUTE, overdueMinutes: 1 }), action: 'stale' },
    { label: 'never ran', duty: { ...healthyDuty(), neverRan: true, lastRunAt: null }, action: 'none' },
    { label: 'delivery failed', duty: healthyDuty(), action: 'stale', failedDeliveries: 1 },
    { label: 'absurd period', duty: healthyDuty({ dutyIntervalMinutes: 9999, nextDueAt: NOW + 9999 * MINUTE }), action: 'none' },
    { label: 'missing nextDueAt', duty: { ...healthyDuty(), nextDueAt: null }, action: 'none' },
    { label: 'now is not finite', duty: healthyDuty(), action: 'none', now: Number.NaN },
  ];

  for (const testCase of cases) {
    await t.test(`${testCase.label}: between the floor and the cap`, () => {
      // Arrange / Act
      const decision = decideNextCheckAt({
        duty: testCase.duty,
        action: testCase.action,
        failedDeliveries: testCase.failedDeliveries,
        now: testCase.now,
      });

      // Assert
      assert.ok(
        decision.delayMinutes >= MIN_CHECK_INTERVAL_MINUTES,
        `${testCase.label}: delay ${decision.delayMinutes} is below the floor`,
      );
      assert.ok(
        decision.delayMinutes <= MAX_CHECK_INTERVAL_MINUTES,
        `${testCase.label}: delay ${decision.delayMinutes} is above the cap`,
      );
      assert.ok(Number.isFinite(decision.nextCheckAt), `${testCase.label}: nextCheckAt must be finite`);
      assert.ok(typeof decision.reason === 'string' && decision.reason.length > 0);
    });
  }
});

test('the watchdog schedule and the watchdog verdict are separate questions', async (t) => {
  await t.test('the action does not change the schedule', () => {
    // Arrange: the same duty facts, two different verdicts.
    const duty = healthyDuty();

    // Act
    const quiet = decideNextCheckAt({ duty, action: 'none', now: NOW });
    const loud = decideNextCheckAt({ duty, action: 'stale', now: NOW });

    // Assert
    assert.equal(
      quiet.delayMinutes,
      loud.delayMinutes,
      'alerting is not a reason to wake up sooner — the alarm is decided elsewhere',
    );
  });
});
