import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  makeTrigger,
  selectTriggers,
  triggerId,
  TRIGGER_TYPES,
  describeTrigger,
} from '../miniapps/mimic-tear/miniapp/node/trigger.mjs';
import {
  detectTriggers,
  TRIGGER_WHITELIST,
} from '../miniapps/mimic-tear/miniapp/node/trigger-source.mjs';
import { makeRuntimeDb, tmpDir, cleanupDir } from './helpers/fixture.mjs';

const CLI_PATH = fileURLToPath(new URL('../miniapps/mimic-tear/miniapp/node/patrol-cli.mjs', import.meta.url));

const MINUTE = 60_000;
const NOW = Date.parse('2026-11-01T12:00:00Z');

// ---------------------------------------------------------------------------
// 契约
// ---------------------------------------------------------------------------

test('类型是封闭集合：未知类型要吵，不能降级', () => {
  assert.throws(
    () => makeTrigger({ type: 'something-new', subject: 'x', at: NOW }),
    /未知的触发类型/,
    '白名单漏了新类型会静默丢事件，所以这里必须抛',
  );
  assert.throws(() => makeTrigger({ type: 'session-broken' }), /主体/);
  for (const type of TRIGGER_TYPES) {
    assert.ok(makeTrigger({ type, subject: 's', at: NOW }).type === type);
  }
});

test('id 是稳定的：同一件事、同一时刻，永远是同一个 id', () => {
  const first = makeTrigger({ type: 'session-broken', subject: 'sess-1', at: NOW });
  const second = makeTrigger({ type: 'session-broken', subject: 'sess-1', at: NOW });
  const later = makeTrigger({ type: 'session-broken', subject: 'sess-1', at: NOW + 1 });
  assert.equal(first.id, second.id);
  assert.notEqual(first.id, later.id);
  assert.equal(first.id, triggerId('session-broken', 'sess-1', NOW));
});

test('描述是人话', () => {
  const trigger = makeTrigger({
    type: 'session-broken', subject: 'sess-1', projectName: 'Mimic Tear', summary: '干活干到一半死了', at: NOW,
  });
  assert.match(describeTrigger(trigger), /会话中断/);
  assert.match(describeTrigger(trigger), /Mimic Tear/);
});

// ---------------------------------------------------------------------------
// 第一道闸（程序层）
// ---------------------------------------------------------------------------

const SAMPLE = [
  makeTrigger({ type: 'duty-wake', subject: 'duty', at: NOW }),
  makeTrigger({ type: 'session-broken', subject: 'sess-1', projectName: 'Mimic Tear', at: NOW }),
  makeTrigger({ type: 'session-broken', subject: 'sess-2', projectName: '别的项目', at: NOW - MINUTE }),
  makeTrigger({ type: 'questionnaire-opened', subject: 'q-1', projectName: 'Mimic Tear', at: NOW - 2 * MINUTE }),
];

test('第一道闸：名单外的项目进不了候选', () => {
  const result = selectTriggers(SAMPLE, { managedNames: ['Mimic Tear'] });

  assert.equal(result.kept.length, 3);
  assert.equal(result.kept.some((t) => t.subject === 'sess-2'), false, '名单外的必须被挡掉');
  assert.equal(result.dropped.outOfJurisdiction, 1);
  assert.equal(result.dropped.total, 1);
});

test('第一道闸：类型不在白名单里的被丢掉', () => {
  const result = selectTriggers(SAMPLE, {
    managedNames: ['Mimic Tear', '别的项目'],
    allowTypes: ['duty-wake'],
  });

  assert.equal(result.kept.length, 1);
  assert.equal(result.kept[0].type, 'duty-wake');
  assert.equal(result.dropped.typeNotAllowed, 3);
  assert.equal(result.dropped.outOfJurisdiction, 0);
});

test('第一道闸：没有项目归属的事件不受管辖限制', () => {
  const result = selectTriggers(
    [makeTrigger({ type: 'duty-wake', subject: 'duty', at: NOW })],
    { managedNames: [] },
  );
  assert.equal(result.kept.length, 1, '值班唤醒不属于任何项目');
  assert.equal(result.dropped.total, 0);
});

test('第一道闸是确定性的：同样的输入永远给同样的输出', () => {
  const first = selectTriggers(SAMPLE, { managedNames: ['Mimic Tear'] });
  const second = selectTriggers(SAMPLE, { managedNames: ['Mimic Tear'] });
  assert.deepEqual(first.kept.map((t) => t.id), second.kept.map((t) => t.id));
  // 新的在前，同一时刻按 id 排 —— 顺序也是确定的。
  assert.deepEqual(first.kept.map((t) => t.at), [...first.kept.map((t) => t.at)].sort((a, b) => b - a));
});

// ---------------------------------------------------------------------------
// 检测器
// ---------------------------------------------------------------------------

const SNAPSHOT = {
  projects: [
    { id: 1, name: 'Mimic Tear', latestActivityAt: NOW - 5 * MINUTE },
    { id: 2, name: '别的项目', latestActivityAt: NOW - 4 * MINUTE },
    { id: 3, name: '安静的项目', latestActivityAt: NOW - 10 * MINUTE },
  ],
  sessions: [
    { id: 'sess-broken', status: 'error', title: '干活干到一半', updatedAt: NOW - 3 * MINUTE, projectName: 'Mimic Tear' },
    { id: 'sess-fine', status: 'idle', title: '好好的', updatedAt: NOW - 2 * MINUTE, projectName: 'Mimic Tear' },
    { id: 'sess-old', status: 'error', title: '三天前就坏了', updatedAt: NOW - 3 * 24 * 60 * MINUTE, projectName: 'Mimic Tear' },
  ],
  questionnaires: [
    { id: 'q-new', createdAt: NOW - MINUTE, question: '要不要继续？', sessionId: 'sess-fine', projectName: 'Mimic Tear' },
    { id: 'q-old', createdAt: NOW - 5 * 24 * 60 * MINUTE, question: '老问题', sessionId: 'sess-fine', projectName: 'Mimic Tear' },
  ],
};

test('检测器：四类事件源都能产出', () => {
  const triggers = detectTriggers({ ...SNAPSHOT, watermark: NOW - 10 * MINUTE, now: NOW });
  const types = new Set(triggers.map((t) => t.type));

  assert.ok(types.has('duty-wake'), '值班唤醒');
  assert.ok(types.has('project-activity'), '项目有活动');
  assert.ok(types.has('questionnaire-opened'), '新问卷卡');
  assert.ok(types.has('session-broken'), '会话中断');
});

test('检测器：水位线之前的事不再报 —— 否则每轮都把旧事重报一遍', () => {
  const triggers = detectTriggers({ ...SNAPSHOT, watermark: NOW - 10 * MINUTE, now: NOW });
  const subjects = triggers.map((t) => t.subject);

  assert.equal(subjects.includes('sess-old'), false, '三天前就坏的那条不该再报');
  assert.equal(subjects.includes('q-old'), false, '五天前的老问卷不该再报');
  assert.equal(subjects.includes('安静的项目'), false, '水位线之后没活动的项目不算事件');
  assert.ok(subjects.includes('sess-broken'));
  assert.ok(subjects.includes('q-new'));
});

test('检测器：会话状态不是「停了」就不算中断', () => {
  const triggers = detectTriggers({ ...SNAPSHOT, watermark: NOW - 10 * MINUTE, now: NOW });
  assert.equal(triggers.some((t) => t.subject === 'sess-fine'), false, 'idle 的会话不是中断');
});

test('白名单里每一项都得真能产出事件 —— 漏加一类会静默丢事件', () => {
  const triggers = detectTriggers({ ...SNAPSHOT, watermark: NOW - 10 * MINUTE, now: NOW });
  for (const type of TRIGGER_WHITELIST) {
    assert.ok(
      triggers.some((t) => t.type === type),
      `白名单里的「${type}」在快照里产不出事件 —— 白名单和检测器对不上`,
    );
  }
});

// ---------------------------------------------------------------------------
// CLI：事实表的两种视图
// ---------------------------------------------------------------------------

function runCli(dbPath, dataDir, args = ['facts']) {
  const stdout = execFileSync(
    process.execPath,
    [CLI_PATH, ...args, '--db', dbPath, '--data-dir', dataDir],
    { encoding: 'utf8' },
  );
  return JSON.parse(stdout);
}

/** A board directory with one granted project and a duty stamp from an hour ago. */
function makeBoard(dir) {
  const dbPath = makeRuntimeDb(dir);
  writeFileSync(
    join(dir, 'patrol-config.json'),
    JSON.stringify({ enabled: true, intervalMinutes: 15, dutyIntervalMinutes: 30, lastRunAt: Date.now() - 60 * MINUTE }),
    'utf8',
  );
  // 只授权 alpha —— 名单外的东西不进候选视图。
  runCli(dbPath, dir, ['manage', 'add', 'alpha', '大老板授权盯 alpha']);
  return dbPath;
}

test('CLI facts：默认给的是候选视图，并说清筛掉了多少', () => {
  const dir = tmpDir();
  try {
    const dbPath = makeBoard(dir);
    const result = runCli(dbPath, dir);

    assert.equal(result.scope, 'candidates');
    assert.equal(result.fullScopeRequested, false);
    assert.equal(result.projects.length, 1, '只留名单内的项目');
    assert.equal(result.projects[0].name, 'alpha');
    assert.ok(result.excluded.projects >= 1, '筛掉的数量要报出来');
    assert.ok(Array.isArray(result.triggers.candidates));
    assert.ok(result.triggers.dropped.total >= 0);
  } finally {
    cleanupDir(dir);
  }
});

test('CLI facts --scope=raw：全量视图，而且要写明「这次要了全量」', () => {
  const dir = tmpDir();
  try {
    const dbPath = makeBoard(dir);
    const result = runCli(dbPath, dir, ['facts', '--scope', 'raw']);

    assert.equal(result.scope, 'raw');
    assert.equal(result.fullScopeRequested, true);
    assert.ok(result.projects.length > 1, 'raw 看得见名单外的项目');
  } finally {
    cleanupDir(dir);
  }
});

test('CLI facts：候选视图的体积可测量地小于全量', () => {
  const dir = tmpDir();
  try {
    const dbPath = makeBoard(dir);
    const candidates = JSON.stringify(runCli(dbPath, dir)).length;
    const raw = JSON.stringify(runCli(dbPath, dir, ['facts', '--scope', 'raw'])).length;

    assert.ok(candidates < raw, `候选 ${candidates} 应该小于全量 ${raw}`);
    // 至少要小一截 —— 小一点点没有意义，说明过滤基本没生效。
    assert.ok(raw - candidates > raw * 0.1, `候选视图只小了 ${raw - candidates} 字节，过滤基本没生效`);
  } finally {
    cleanupDir(dir);
  }
});

test('CLI facts：未知的 scope 要拒绝，而不是当成默认', () => {
  const dir = tmpDir();
  try {
    const dbPath = makeBoard(dir);
    assert.throws(
      () => runCli(dbPath, dir, ['facts', '--scope', 'everything']),
      (error) => {
        assert.equal(error.status, 2);
        assert.match(String(error.stderr), /未知的 scope/);
        return true;
      },
    );
  } finally {
    cleanupDir(dir);
  }
});
