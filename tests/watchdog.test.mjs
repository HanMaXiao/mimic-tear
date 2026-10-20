import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildDutyStatus } from '../miniapps/mimic-tear/miniapp/node/view-model.mjs';
import {
  applyFailure,
  applySuccess,
  buildAlertMessage,
  decideAction,
  emptyWatchdogState,
  evaluateDuty,
} from '../miniapps/mimic-tear/miniapp/node/watchdog-rules.mjs';
import { buildToastXml } from '../miniapps/mimic-tear/miniapp/node/toast.mjs';
import { runWatchdog } from '../miniapps/mimic-tear/miniapp/node/watchdog.mjs';
import { tmpDir, cleanupDir } from './helpers/fixture.mjs';

const MINUTE = 60_000;
const NOW = Date.parse('2026-10-20T12:00:00Z');

/** A config whose duty handover happened `minutes` ago. */
function configWithLastRun(minutes) {
  return { enabled: true, intervalMinutes: 15, dutyIntervalMinutes: 30, lastRunAt: NOW - minutes * MINUTE };
}

test('判定必须复用 buildDutyStatus —— 不能自己写一份阈值', () => {
  const config = configWithLastRun(50);
  assert.deepEqual(evaluateDuty(config, NOW), buildDutyStatus({ config, findings: [], now: NOW }));
});

test('阈值来自值班周期，与看板完全一致', () => {
  // 45 分钟阈值（1.5 × 30 分钟周期），漏一轮就亮灯
  assert.equal(evaluateDuty(configWithLastRun(44), NOW).stale, false);
  assert.equal(evaluateDuty(configWithLastRun(46), NOW).stale, true);
  assert.equal(evaluateDuty(configWithLastRun(46), NOW).staleAfterMinutes, 45);
});

test('首次运行：健康则静默建立基线', () => {
  const state = emptyWatchdogState();
  assert.equal(decideAction(state, evaluateDuty(configWithLastRun(5), NOW)), 'none');
});

test('首次运行：从未交过班不算掉线（那是"还没启动"，不是故障）', () => {
  const state = emptyWatchdogState();
  const duty = evaluateDuty({ dutyIntervalMinutes: 30, lastRunAt: null }, NOW);
  assert.equal(duty.neverRan, true);
  assert.equal(decideAction(state, duty), 'none');
});

test('首次运行：已经断了很久则立刻告警（不是刚断，是长期无人接手）', () => {
  const state = emptyWatchdogState();
  assert.equal(decideAction(state, evaluateDuty(configWithLastRun(120), NOW)), 'stale');
});

test('健康 → 掉线：发一次掉线通知', () => {
  const state = applySuccess(emptyWatchdogState(), 'none', evaluateDuty(configWithLastRun(5), NOW), NOW);
  assert.equal(decideAction(state, evaluateDuty(configWithLastRun(60), NOW)), 'stale');
});

test('掉线期间：不重复通知', () => {
  const state = applySuccess(emptyWatchdogState(), 'none', evaluateDuty(configWithLastRun(5), NOW), NOW);
  const alerted = applySuccess(state, 'stale', evaluateDuty(configWithLastRun(60), NOW), NOW);
  assert.equal(decideAction(alerted, evaluateDuty(configWithLastRun(65), NOW)), 'none');
});

test('掉线 → 恢复：发一次恢复通知', () => {
  let state = applySuccess(emptyWatchdogState(), 'none', evaluateDuty(configWithLastRun(60), NOW), NOW);
  state = applySuccess(state, 'stale', evaluateDuty(configWithLastRun(60), NOW), NOW);
  assert.equal(decideAction(state, evaluateDuty(configWithLastRun(1), NOW)), 'recovered');
});

test('健康 → 健康：永不发通知', () => {
  const state = applySuccess(emptyWatchdogState(), 'none', evaluateDuty(configWithLastRun(5), NOW), NOW);
  assert.equal(decideAction(state, evaluateDuty(configWithLastRun(10), NOW)), 'none');
});

test('投递失败时状态不推进 —— 下一轮还会重试', () => {
  const state = applySuccess(emptyWatchdogState(), 'none', evaluateDuty(configWithLastRun(5), NOW), NOW);
  const failed = applyFailure(state, 'stale', evaluateDuty(configWithLastRun(60), NOW), NOW);
  assert.equal(failed.notifiedStale, false, '没送达就不算"已经告知"');
  assert.equal(failed.observedStale, true, '但事实要记住：大哥确实没交班');
  assert.equal(failed.failedDeliveries, 1);
  assert.equal(decideAction(failed, evaluateDuty(configWithLastRun(60), NOW)), 'stale', '下一轮要重试');
});

test('投递成功后失败计数清零', () => {
  let state = applySuccess(emptyWatchdogState(), 'none', evaluateDuty(configWithLastRun(5), NOW), NOW);
  state = applyFailure(state, 'stale', evaluateDuty(configWithLastRun(60), NOW), NOW);
  state = applySuccess(state, 'stale', evaluateDuty(configWithLastRun(60), NOW), NOW);
  assert.equal(state.failedDeliveries, 0);
  assert.equal(state.notifiedStale, true);
});

test('掉线通知要说清"多久没交班"和"多久算掉线"', () => {
  const message = buildAlertMessage('stale', {
    duty: evaluateDuty(configWithLastRun(52), NOW),
    staleSince: NOW - 52 * MINUTE,
    now: NOW,
    failedDeliveries: 0,
  });
  assert.match(message.title, /仿身泪滴/);
  assert.match(message.title, /掉线/);
  assert.match(message.body, /52 分钟/);
  assert.match(message.body, /45 分钟/);
});

test('恢复通知要说清掉了多久', () => {
  const message = buildAlertMessage('recovered', {
    duty: evaluateDuty(configWithLastRun(1), NOW),
    staleSince: NOW - 18 * MINUTE,
    now: NOW,
    failedDeliveries: 0,
  });
  assert.match(message.title, /归位|恢复/);
  assert.match(message.body, /18 分钟/);
});

test('投递失败过要在下一条通知里说明', () => {
  const message = buildAlertMessage('stale', {
    duty: evaluateDuty(configWithLastRun(52), NOW),
    staleSince: NOW - 52 * MINUTE,
    now: NOW,
    failedDeliveries: 3,
  });
  assert.match(message.body, /3 次/);
});

test('toast XML 要转义正文里的尖括号与 &', () => {
  const xml = buildToastXml({ title: '标题', body: 'a < b & c > d' });
  assert.match(xml, /&lt;/);
  assert.match(xml, /&amp;/);
  assert.doesNotMatch(xml, /a < b/);
});

test('端到端：健康 → 掉线 → 恢复，各发一条', async () => {
  const dir = tmpDir();
  try {
    const dataDir = join(dir, 'data');
    mkdirSync(dataDir, { recursive: true });
    const configPath = join(dataDir, 'patrol-config.json');
    const write = (minutes) => writeFileSync(
      configPath,
      JSON.stringify(configWithLastRun(minutes)),
      'utf8',
    );
    write(5);

    const sent = [];
    const deliver = async (message) => { sent.push(message); return { ok: true }; };

    await runWatchdog({ dataDir, now: NOW, deliver });
    assert.equal(sent.length, 0, '健康时不打扰');

    write(60);
    await runWatchdog({ dataDir, now: NOW + MINUTE, deliver });
    assert.equal(sent.length, 1, '掉线时发一条');
    assert.match(sent[0].title, /掉线/);

    await runWatchdog({ dataDir, now: NOW + 2 * MINUTE, deliver });
    assert.equal(sent.length, 1, '持续掉线不重复发');

    write(1);
    await runWatchdog({ dataDir, now: NOW + 3 * MINUTE, deliver });
    assert.equal(sent.length, 2, '恢复时发一条');
    assert.match(sent[1].title, /归位|恢复/);

    const state = JSON.parse(readFileSync(join(dataDir, 'watchdog-state.json'), 'utf8'));
    assert.equal(state.notifiedStale, false);
  } finally {
    cleanupDir(dir);
  }
});

test('端到端：投递失败要落日志，且状态不推进', async () => {
  const dir = tmpDir();
  try {
    const dataDir = join(dir, 'data');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      join(dataDir, 'patrol-config.json'),
      JSON.stringify(configWithLastRun(60)),
      'utf8',
    );

    const deliver = async () => ({ ok: false, error: '模拟失败' });
    const result = await runWatchdog({ dataDir, now: NOW, deliver });

    assert.equal(result.action, 'stale');
    assert.equal(result.delivered, false);
    const log = readFileSync(join(dataDir, 'watchdog-alert.log'), 'utf8');
    assert.match(log, /掉线/);

    const state = JSON.parse(readFileSync(join(dataDir, 'watchdog-state.json'), 'utf8'));
    // 首次运行就投递失败：用户从未被告知过任何状态，所以 "已告知" 仍是 null（不是 false）——
    // false 会谎称"已经报过平安"，那会让下一轮误判成"无需再报"。
    assert.equal(state.notifiedStale, null, '没送达就不能推进"已告知"');
    assert.equal(state.observedStale, true, '但事实要记住');
    assert.equal(state.failedDeliveries, 1);
  } finally {
    cleanupDir(dir);
  }
});
