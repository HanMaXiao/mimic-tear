import test from 'node:test';
import assert from 'node:assert/strict';

import { buildLines, deriveNextStep } from '../miniapps/mimic-tear/miniapp/node/line-view.mjs';

const NOW = Date.parse('2026-11-01T12:00:00Z');

const CARDS = [
  {
    id: 1,
    name: 'alpha',
    health: 'ok',
    erroredSessions: 0,
    lastActivityAt: NOW - 10 * 60_000,
    goals: [{ status: 'active' }, { status: 'paused' }],
    planTasks: [{ id: 't1', state: 'done' }, { id: 't2', state: 'blocked' }],
  },
  { id: 2, name: 'beta', health: 'ok', erroredSessions: 0, goals: [], planTasks: [] },
];

const ATTENTION = [
  { id: 'a1', projectName: 'alpha', title: '要你拍板的事', severity: 'high' },
  { id: 'a2', projectName: 'beta', title: 'beta 的事', severity: 'medium' },
];

const FINDINGS = [
  { id: 'f1', projectName: 'alpha', title: '刚报了一条结论', severity: 'low', createdAt: NOW - 5 * 60_000 },
];

const THREADS = [
  { projectName: 'alpha', ownerSessionId: 'mvs_alpha', active: true },
];

test('线 = 管辖名单里的项目：名单外的不算线', () => {
  const lines = buildLines({
    cards: CARDS,
    attention: ATTENTION,
    findings: FINDINGS,
    threads: THREADS,
    managedNames: ['alpha'],
  });

  assert.equal(lines.length, 1, 'beta 不在管辖名单里，就不是一条线');
  assert.equal(lines[0].projectName, 'alpha');
});

test('线带齐：作为、待决策、进度、在不在等你、下一步', () => {
  const [line] = buildLines({
    cards: CARDS,
    attention: ATTENTION,
    findings: FINDINGS,
    threads: THREADS,
    managedNames: ['alpha'],
  });

  assert.equal(line.actions.length, 1);
  assert.equal(line.actions[0].title, '刚报了一条结论');
  assert.equal(line.pending.length, 1);
  assert.equal(line.waitingOnYou, true);
  assert.deepEqual(line.progress, { goalsActive: 1, goalsTotal: 2, tasksDone: 1, tasksTotal: 2 });
  assert.equal(line.nextStep, '等你拍板');
  assert.deepEqual(line.thread, { ownerSessionId: 'mvs_alpha', active: true });
});

test('没有投递口时 thread 是 null —— 线不依赖投递口存在', () => {
  const [line] = buildLines({
    cards: CARDS,
    attention: ATTENTION,
    findings: FINDINGS,
    threads: [],
    managedNames: ['alpha'],
  });
  assert.equal(line.thread, null);
});

test('下一步：固定优先级，不是模型现编的', () => {
  assert.equal(deriveNextStep({ pending: [{ id: 'x' }], erroredSessions: 3, goals: [{ status: 'active' }] }), '等你拍板');
  assert.equal(deriveNextStep({ pending: [], erroredSessions: 3, goals: [{ status: 'active' }] }), '恢复这条线');
  assert.equal(deriveNextStep({ pending: [], erroredSessions: 0, goals: [{ status: 'active' }] }), '等它跑完');
  assert.equal(deriveNextStep({ pending: [], erroredSessions: 0, goals: [] }), '暂无待办');
});

test('在等你的线排前面 —— 那是用户最该先看的一行', () => {
  const lines = buildLines({
    cards: [
      { id: 1, name: 'alpha', goals: [], planTasks: [] },
      { id: 2, name: 'beta', goals: [], planTasks: [] },
    ],
    attention: [
      { id: 'a1', projectName: 'beta', title: 'beta 在等你', severity: 'high' },
    ],
    findings: [],
    threads: [],
    managedNames: ['alpha', 'beta'],
  });

  assert.equal(lines[0].projectName, 'beta', '在等你的排前面');
  assert.equal(lines[0].waitingOnYou, true);
  assert.equal(lines[1].waitingOnYou, false);
});

test('最近动作取的是最新的一条；没有就是这一轮没变化', () => {
  const [line] = buildLines({
    cards: CARDS,
    attention: [],
    findings: [
      { id: 'old', projectName: 'alpha', title: '旧的', severity: 'low', createdAt: NOW - 60 * 60_000 },
      { id: 'new', projectName: 'alpha', title: '新的', severity: 'low', createdAt: NOW - 60_000 },
    ],
    threads: [],
    managedNames: ['alpha'],
  });
  assert.equal(line.actions[0].title, '新的');
  assert.equal(line.lastActivityAt, NOW - 60_000);
});

test('没给管辖名单时一条线都没有 —— 名单空 = 大哥什么都不管', () => {
  const lines = buildLines({ cards: CARDS, attention: ATTENTION, findings: FINDINGS, threads: THREADS });
  assert.equal(lines.length, 0);
});
