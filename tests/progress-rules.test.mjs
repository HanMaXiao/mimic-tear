import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decideStuck,
  hasProgress,
  snapshotProgress,
  DEFAULT_STUCK_THRESHOLD_MS,
} from '../miniapps/mimic-tear/miniapp/node/progress-rules.mjs';
import {
  applySuccess,
  buildAlertMessage,
  decideAction,
  emptyWatchdogState,
} from '../miniapps/mimic-tear/miniapp/node/watchdog-rules.mjs';
import { buildBoardNotice } from '../miniapps/mimic-tear/miniapp/node/watchdog-alerts.mjs';

const NOW = Date.parse('2026-11-01T12:00:00Z');
const MINUTE = 60_000;

const DUTY = {
  stale: false,
  alertable: false,
  neverRan: false,
  lastRunAt: NOW - 5 * MINUTE,
  ageMinutes: 5,
  staleAfterMinutes: 45,
};

test('快照与「有进展」：消息变多、状态变了，都算进展', () => {
  const before = snapshotProgress({ sessionId: 's1', status: 'started', messages: 10, at: NOW });
  const after = snapshotProgress({ sessionId: 's1', status: 'started', messages: 12, at: NOW });

  assert.equal(hasProgress(before, after), true, '消息变多 = 有进展');
  assert.equal(
    hasProgress(before, snapshotProgress({ sessionId: 's1', status: 'idle', messages: 10, at: NOW })),
    true,
    '状态变了 = 有进展',
  );
  assert.equal(
    hasProgress(before, snapshotProgress({ sessionId: 's1', status: 'started', messages: 10, at: NOW })),
    false,
    '什么都没变 = 没进展',
  );
});

test('第一次看见一个会话：没有基线，不能凭「没进展」就报卡住', () => {
  const result = decideStuck({
    previous: null,
    current: snapshotProgress({ sessionId: 's1', status: 'started', messages: 3, at: NOW }),
    now: NOW,
  });
  assert.equal(result.stuck, false, '没有基线就不下结论');
  assert.equal(result.lastProgressAt, NOW);
});

test('不在跑就没有「卡住」可言', () => {
  const previous = { sessionId: 's1', status: 'started', messages: 3, lastProgressAt: NOW - 60 * MINUTE };
  const result = decideStuck({
    previous,
    current: snapshotProgress({ sessionId: 's1', status: 'idle', messages: 3, at: NOW }),
    now: NOW,
  });
  assert.equal(result.stuck, false);
});

test('在跑、且长时间没有实质进展 → stuck', () => {
  const previous = { sessionId: 's1', status: 'started', messages: 3, lastProgressAt: NOW - 60 * MINUTE };
  const result = decideStuck({
    previous,
    current: snapshotProgress({ sessionId: 's1', status: 'started', messages: 3, at: NOW }),
    now: NOW,
  });
  assert.equal(result.stuck, true);
  assert.equal(result.reason, 'no_progress');
  assert.equal(result.minutes, 60);
});

test('消息数长了就不算卡住（哪怕之前很久没动）', () => {
  const previous = { sessionId: 's1', status: 'started', messages: 3, lastProgressAt: NOW - 60 * MINUTE };
  const result = decideStuck({
    previous,
    current: snapshotProgress({ sessionId: 's1', status: 'started', messages: 9, at: NOW }),
    now: NOW,
  });
  assert.equal(result.stuck, false, '有产出就不算卡住');
  assert.equal(result.lastProgressAt, NOW, '进展时刻被推到此刻');
});

test('阈值必须长于一个值班轮次，否则正常的慢轮次会被误判', () => {
  assert.ok(DEFAULT_STUCK_THRESHOLD_MS >= 45 * MINUTE, '阈值至少 45 分钟');
});

test('看门狗判定：stuck 是独立于 stale 的一个结论', () => {
  const state = emptyWatchdogState();
  const evidence = { stuck: { stuck: true, minutes: 60, sessionId: 's1', lastProgressAt: NOW - 60 * MINUTE } };

  assert.equal(decideAction(state, DUTY, evidence), 'stuck');
  assert.equal(
    decideAction({ ...state, notifiedStuck: true }, DUTY, evidence),
    'none',
    '一段卡住只报一次，不刷屏',
  );
});

test('看门狗状态：报过就记上；卡住解除后重新武装', () => {
  const evidence = { stuck: { stuck: true, minutes: 60, sessionId: 's1', lastProgressAt: NOW - 60 * MINUTE } };
  const after = applySuccess(emptyWatchdogState(), 'stuck', DUTY, NOW, evidence);
  assert.equal(after.notifiedStuck, true);
  assert.equal(after.observedStuck, true);
  assert.equal(after.stuckSince, NOW - 60 * MINUTE, '卡住的起点是最后一次有进展的时刻');

  const cleared = applySuccess(after, 'none', DUTY, NOW, {
    stuck: { stuck: false, minutes: 0, sessionId: 's1', lastProgressAt: NOW },
  });
  assert.equal(cleared.notifiedStuck, null, '这一轮不卡了 → 重新武装');
});

test('进展快照随每一跳推进 —— 没有它就没有「没进展」的基线', () => {
  const snapshot = { sessionId: 's1', status: 'started', messages: 4, lastProgressAt: NOW };
  const next = applySuccess(emptyWatchdogState(), 'none', DUTY, NOW, { progress: snapshot });
  assert.deepEqual(next.progress, snapshot);
});

test('告警文案与板面通告都说到「在跑但没进展」', () => {
  const evidence = { stuck: { stuck: true, minutes: 60, sessionId: 's1', lastProgressAt: NOW - 60 * MINUTE } };

  const message = buildAlertMessage('stuck', { duty: DUTY, evidence, now: NOW, failedDeliveries: 0 });
  assert.match(message.title, /在跑但没进展/);
  assert.match(message.body, /60 分钟/);

  const notice = buildBoardNotice('stuck', DUTY, evidence);
  assert.ok(notice, '板面也要有一条');
  assert.match(notice.title, /在跑但没进展/);
  assert.match(notice.body, /60 分钟/);
});
