import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDutyRounds } from '../miniapps/mimic-tear/miniapp/node/duty-rounds.mjs';
import { dutyAnnouncementNeeded } from '../miniapps/mimic-tear/miniapp/node/duty-announce.mjs';

const MINUTE = 60_000;
const NOW = Date.parse('2026-10-20T12:00:00Z');

/** A finding as the boss writes it. */
function finding(overrides = {}) {
  return {
    id: 'patrol_x',
    createdAt: NOW,
    severity: 'medium',
    title: '一条结论',
    projectName: 'alpha',
    acknowledged: false,
    acknowledgedBy: null,
    ...overrides,
  };
}

test('duty rounds', async (t) => {
  await t.test('同一轮的多条结论归为一轮', () => {
    const rounds = buildDutyRounds([
      finding({ id: 'a', createdAt: NOW }),
      finding({ id: 'b', createdAt: NOW }),
      finding({ id: 'c', createdAt: NOW + 500 }),
    ]);
    assert.equal(rounds.length, 1, '同一秒写的结论属于同一轮');
    assert.equal(rounds[0].findings.length, 3);
  });

  await t.test('相隔半小时的是两轮', () => {
    const rounds = buildDutyRounds([
      finding({ id: 'a', createdAt: NOW }),
      finding({ id: 'b', createdAt: NOW - 30 * MINUTE }),
    ]);
    assert.equal(rounds.length, 2, '两轮之间要分开');
  });

  await t.test('最新的轮排在最前', () => {
    const rounds = buildDutyRounds([
      finding({ id: 'old', createdAt: NOW - 60 * MINUTE }),
      finding({ id: 'new', createdAt: NOW }),
    ]);
    assert.equal(rounds[0].findings[0].id, 'new');
  });

  await t.test('每轮统计各严重级别的条数', () => {
    const rounds = buildDutyRounds([
      finding({ id: 'a', severity: 'high', createdAt: NOW }),
      finding({ id: 'b', severity: 'medium', createdAt: NOW }),
      finding({ id: 'c', severity: 'low', createdAt: NOW }),
    ]);
    assert.deepEqual(rounds[0].counts, { high: 1, medium: 1, low: 1 });
  });

  await t.test('大哥撤回的结论仍然留在轮次里，并标出来', () => {
    // A withdrawn conclusion is not erased — it happened, and the user must see that the
    // boss took it back rather than finding it silently missing.
    const rounds = buildDutyRounds([
      finding({ id: 'a', createdAt: NOW, acknowledged: true, acknowledgedBy: 'boss' }),
    ]);
    assert.equal(rounds[0].findings.length, 1);
    assert.equal(rounds[0].findings[0].acknowledgedBy, 'boss');
  });

  await t.test('没有结论时不返回空轮次', () => {
    assert.deepEqual(buildDutyRounds([]), []);
    assert.deepEqual(buildDutyRounds(null), []);
  });

  await t.test('坏数据不炸：没有时间戳的条目被忽略', () => {
    const rounds = buildDutyRounds([finding({ createdAt: undefined }), finding({ id: 'ok' })]);
    assert.equal(rounds.length, 1);
    assert.equal(rounds[0].findings.length, 1);
  });

  await t.test('轮次数量有上限', () => {
    const many = Array.from({ length: 50 }, (_, i) => finding({ id: `f${i}`, createdAt: NOW - i * 30 * MINUTE }));
    assert.equal(buildDutyRounds(many, { limit: 5 }).length, 5);
  });
});

test('duty announcement', async (t) => {
  await t.test('交班时间变了就要通报', () => {
    assert.equal(dutyAnnouncementNeeded({ lastRunAt: NOW }, 1000).changed, true);
  });

  await t.test('同一班不重复通报', () => {
    assert.equal(dutyAnnouncementNeeded({ lastRunAt: NOW }, NOW).changed, false);
  });

  await t.test('从没交过班不通报（那是"还没开始"，不是一次交班）', () => {
    assert.equal(dutyAnnouncementNeeded({ lastRunAt: null }, null).changed, false);
    assert.equal(dutyAnnouncementNeeded({ lastRunAt: null }, 1000).changed, false);
  });
});
