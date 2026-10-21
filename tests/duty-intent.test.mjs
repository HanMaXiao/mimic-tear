import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  DEFAULT_DUTY_INTENT,
  DutyIntent,
  normalizeDutyIntent,
} from '../miniapps/mimic-tear/miniapp/node/duty-intent.mjs';
import { tmpDir, cleanupDir } from './helpers/fixture.mjs';

test('值班意图', async (t) => {
  await t.test('写完要能原样读回来——歇着得带上是谁说的、从什么时候起', async () => {
    const dir = tmpDir();
    try {
      const intent = new DutyIntent(dir);
      await intent.setMode('resting', { requestedBy: '大老板', note: '今天先歇着' });

      const read = await intent.read();
      assert.equal(read.mode, 'resting');
      assert.equal(read.requestedBy, '大老板');
      assert.equal(read.note, '今天先歇着');
      assert.ok(read.since > 0, '歇着必须带时间戳，否则看板说不清从什么时候开始');
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('没人说过什么时，大哥是在岗的', async () => {
    const dir = tmpDir();
    try {
      const read = await new DutyIntent(dir).read();
      assert.deepEqual(read, DEFAULT_DUTY_INTENT);
      assert.equal(read.mode, 'on-duty');
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('意图文件坏了也不能把大哥关掉', async () => {
    const dir = tmpDir();
    try {
      const intent = new DutyIntent(dir);
      writeFileSync(intent.path, '{ 这不是 JSON', 'utf8');
      const read = await intent.read();
      assert.equal(read.mode, 'on-duty', '坏文件只能读成「没人决定」，不能读成「歇着」');
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('写完不能留下半截的临时文件', async () => {
    const dir = tmpDir();
    try {
      const intent = new DutyIntent(dir);
      await intent.setMode('resting', { requestedBy: '大老板' });
      assert.deepEqual(readdirSync(dir), ['duty-intent.json']);
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('归一化只认两种模式', () => {
    assert.equal(normalizeDutyIntent({ mode: 'sleeping' }).mode, 'on-duty');
    assert.equal(normalizeDutyIntent({ mode: 'resting' }).mode, 'resting');
    assert.equal(normalizeDutyIntent(null).mode, 'on-duty');
    assert.equal(normalizeDutyIntent({ mode: 'resting', since: 'soon' }).since, null);
  });
});
