import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDutyStatus, withDutyCards } from '../miniapps/mimic-tear/miniapp/node/view-model.mjs';

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

test('值班状态要看得见', async (t) => {
  await t.test('值班块要说清在岗、上次交班和下一轮什么时候到', () => {
    const duty = buildDutyStatus({
      config: { lastRunAt: NOW - 5 * MINUTE, intervalMinutes: 15, dutyIntervalMinutes: 30 },
      findings: [],
      now: NOW,
    });

    assert.equal(duty.mode, 'on-duty');
    assert.equal(duty.resting, false);
    assert.equal(duty.lastRunAt, NOW - 5 * MINUTE);
    assert.equal(duty.ageMinutes, 5);
    assert.equal(duty.nextDueAt, NOW + 30 * MINUTE, '下一轮到期的时刻要算得出来');
    assert.equal(duty.overdueMinutes, 0, '刚交过班不算逾期');
    assert.equal(duty.stale, false);
    assert.equal(duty.alertable, false);
  });

  await t.test('歇着是显式状态：不能靠「没有交班」来表示', () => {
    const duty = buildDutyStatus({
      config: { lastRunAt: NOW - 60 * MINUTE, dutyIntervalMinutes: 30 },
      findings: [],
      intent: { mode: 'resting', since: NOW - 30 * MINUTE, requestedBy: '大老板', note: '先歇着' },
      now: NOW,
    });

    assert.equal(duty.mode, 'resting');
    assert.equal(duty.resting, true);
    assert.equal(duty.modeSince, NOW - 30 * MINUTE);
    assert.equal(duty.requestedBy, '大老板');
    assert.equal(duty.intentNote, '先歇着');
  });

  await t.test('值班灯跟事实走：歇着不能改写「多久没交班」', () => {
    const config = { lastRunAt: NOW - 60 * MINUTE, dutyIntervalMinutes: 30 };
    const onDuty = buildDutyStatus({ config, findings: [], now: NOW });
    const resting = buildDutyStatus({
      config,
      findings: [],
      intent: { mode: 'resting', since: NOW - 30 * MINUTE },
      now: NOW,
    });

    assert.equal(onDuty.stale, true);
    assert.equal(resting.stale, true, '事实不变：灯还是按交班事实走');
    assert.equal(resting.ageMinutes, onDuty.ageMinutes);
    assert.equal(resting.missedRounds, onDuty.missedRounds);
    assert.equal(resting.alertable, false, '但明确歇着就不该报掉线');
  });

  await t.test('项目卡要带上大哥的值班状态，以及它在不在管辖名单里', () => {
    const duty = buildDutyStatus({
      config: { lastRunAt: NOW - 5 * MINUTE, dutyIntervalMinutes: 30 },
      findings: [],
      intent: { mode: 'resting', since: NOW - MINUTE, requestedBy: '大老板' },
      now: NOW,
    });

    const cards = withDutyCards(
      [{ id: 1, name: 'alpha' }, { id: 2, name: 'beta' }],
      duty,
      new Set(['alpha']),
    );

    assert.equal(cards[0].duty.watching, true);
    assert.equal(cards[0].duty.resting, true);
    assert.equal(cards[0].duty.mode, 'resting');
    assert.equal(cards[0].duty.requestedBy, '大老板');
    assert.equal(cards[1].duty.watching, false, '名单外的项目没有被盯着');
  });
});
