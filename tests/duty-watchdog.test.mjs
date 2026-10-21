import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  applySuccess,
  decideAction,
  emptyWatchdogState,
  evaluateDuty,
} from '../miniapps/mimic-tear/miniapp/node/watchdog-rules.mjs';
import { runWatchdog } from '../miniapps/mimic-tear/miniapp/node/watchdog.mjs';
import { tmpDir, cleanupDir } from './helpers/fixture.mjs';

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

test('watchdog 认歇着', async (t) => {
  await t.test('明确歇着时不报掉线', () => {
    const duty = evaluateDuty(
      { dutyIntervalMinutes: 30, lastRunAt: NOW - 60 * MINUTE },
      NOW,
      { mode: 'resting', since: NOW - 30 * MINUTE },
    );

    assert.equal(duty.stale, true, '事实仍然是「很久没交班」');
    assert.equal(duty.alertable, false, '但明确歇着就不算掉线');
    assert.equal(decideAction(emptyWatchdogState(), duty), 'none', '不弹通知');
  });

  await t.test('恢复上岗后仍然没交班，要报一次', () => {
    const resting = evaluateDuty(
      { dutyIntervalMinutes: 30, lastRunAt: NOW - 60 * MINUTE },
      NOW,
      { mode: 'resting', since: NOW - 30 * MINUTE },
    );
    const state = applySuccess(emptyWatchdogState(), 'none', resting, NOW);

    const awake = evaluateDuty(
      { dutyIntervalMinutes: 30, lastRunAt: NOW - 60 * MINUTE },
      NOW,
      { mode: 'on-duty', since: NOW },
    );
    assert.equal(decideAction(state, awake), 'stale', '上岗了还交不上班，这才是问题');
  });

  await t.test('跑真实的一轮：歇着不通知，上岗后通知', async () => {
    const dir = tmpDir();
    try {
      writeFileSync(
        join(dir, 'patrol-config.json'),
        JSON.stringify({ dutyIntervalMinutes: 30, lastRunAt: NOW - 60 * MINUTE }),
        'utf8',
      );
      writeFileSync(
        join(dir, 'duty-intent.json'),
        JSON.stringify({ mode: 'resting', since: NOW - 30 * MINUTE, requestedBy: '大老板', note: '' }),
        'utf8',
      );

      const delivered = [];
      const deliver = async (message) => {
        delivered.push(message);
        return { ok: true };
      };

      const resting = await runWatchdog({ dataDir: dir, now: NOW, deliver });
      assert.equal(resting.action, 'none', '明确歇着不报掉线');
      assert.equal(delivered.length, 0);

      // 同一份事实，只把意图改成在岗。
      writeFileSync(
        join(dir, 'duty-intent.json'),
        JSON.stringify({ mode: 'on-duty', since: NOW, requestedBy: '大老板', note: '' }),
        'utf8',
      );
      const awake = await runWatchdog({ dataDir: dir, now: NOW + MINUTE, deliver });
      assert.equal(awake.action, 'stale', '恢复上岗后仍然没交班，要报一次');
      assert.equal(delivered.length, 1);
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('没有意图文件时，老实按事实报警', async () => {
    const dir = tmpDir();
    try {
      writeFileSync(
        join(dir, 'patrol-config.json'),
        JSON.stringify({ dutyIntervalMinutes: 30, lastRunAt: NOW - 60 * MINUTE }),
        'utf8',
      );

      const delivered = [];
      const result = await runWatchdog({
        dataDir: dir,
        now: NOW,
        deliver: async (message) => {
          delivered.push(message);
          return { ok: true };
        },
      });
      assert.equal(result.action, 'stale', '没人说歇着，就按事实报');
      assert.equal(delivered.length, 1);
    } finally {
      cleanupDir(dir);
    }
  });
});
