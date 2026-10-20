import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PatrolStore } from '../miniapps/mimic-tear/miniapp/node/patrol-store.mjs';
import { ProjectService, DomainError } from '../miniapps/mimic-tear/miniapp/node/project-service.mjs';
import {
  boardPatrolAction,
  isPatrolDue,
  stampBoardPatrol,
} from '../miniapps/mimic-tear/miniapp/node/patrol-scheduler.mjs';
import { buildPatrolBrief, parsePatrolReport } from '../miniapps/mimic-tear/miniapp/node/view-model.mjs';
import { RuntimeStore } from '../miniapps/mimic-tear/miniapp/node/runtime-store.mjs';
import { makeRuntimeDb, tmpDir, cleanupDir } from './helpers/fixture.mjs';

const CLI_PATH = fileURLToPath(new URL('../miniapps/mimic-tear/miniapp/node/patrol-cli.mjs', import.meta.url));

/**
 * Run the real CLI against an isolated database and data directory.
 *
 * The boss reaches this CLI from a cron, so a unit test on the store is not enough:
 * the facts sheet has to actually carry the duty state when the boss reads it.
 */
function runCli(dbPath, dataDir, args = ['facts']) {
  const stdout = execFileSync(
    process.execPath,
    [CLI_PATH, ...args, '--db', dbPath, '--data-dir', dataDir],
    { encoding: 'utf8' },
  );
  return JSON.parse(stdout);
}

function makeService(bossOverrides = {}) {
  const dir = tmpDir();
  const dbPath = makeRuntimeDb(dir);
  const store = RuntimeStore.open(dbPath);
  const patrol = new PatrolStore(join(dir, 'data'));

  const calls = { dispatch: [], patrol: [] };
  const boss = {
    async dispatch(input) {
      calls.dispatch.push(input);
      return { bossSessionId: 'b1', status: 'finished', text: '投递状态：已投递', error: null, delivered: true };
    },
    async patrol(input) {
      calls.patrol.push(input);
      return {
        bossSessionId: 'b1',
        status: 'finished',
        text: bossOverrides.text ?? [
          '巡检结论：有 1 项需要大老板处理',
          '- 项目: alpha | 级别: high | 摘要: alpha 的会话持续报错，建议先确认网络',
          '我已派工：',
          '- beta: 补一个冒烟测试',
          '巡检状态：已完成',
        ].join('\n'),
        error: null,
      };
    },
  };

  const service = new ProjectService({
    store,
    readPlan: async () => null,
    skills: { skills: [], failures: [] },
    domains: [],
    persistence: new PersistenceStub(join(dir, 'data')),
    boss,
    patrol,
  });

  return { service, store, patrol, calls, dir };
}

class PersistenceStub {
  constructor(dir) {
    this.dir = dir;
    this.acks = new Set();
  }
  async listAcks() {
    return [...this.acks];
  }
  async addAck(id) {
    this.acks.add(id);
  }
  async findDispatchByKey() {
    return null;
  }
  async saveDispatch() {}
  async listDispatches() {
    return [];
  }
  async getBossSession() {
    return null;
  }
  async setBossSession() {}
}

test('patrol', async (t) => {
  await t.test('默认关闭，间隔 15 分钟，值班周期 30 分钟', async () => {
    const { service, patrol, store, dir } = makeService();
    try {
      const config = await service.getPatrolConfig();
      assert.equal(config.enabled, false);
      assert.equal(config.intervalMinutes, 15);
      assert.equal(config.autoDispatch, false);
      // The duty cron runs every 30 minutes; the "boss went quiet" warning is derived
      // from this, so it is a first-class setting and not a hidden constant.
      assert.equal(config.dutyIntervalMinutes, 30);
      void patrol;
      store.close();
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('开启设置可持久化，间隔被夹在 5~240 分钟', async () => {
    const { service, store, dir } = makeService();
    try {
      await service.setPatrolConfig({ enabled: true, intervalMinutes: 1 });
      assert.equal((await service.getPatrolConfig()).intervalMinutes, 5);

      await service.setPatrolConfig({ intervalMinutes: 9999 });
      assert.equal((await service.getPatrolConfig()).intervalMinutes, 240);

      await service.setPatrolConfig({ enabled: true });
      const reloaded = await service.getPatrolConfig();
      assert.equal(reloaded.enabled, true);
      store.close();
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('巡检跑完，结论落成收件箱条目', async () => {
    const { service, calls, store, dir } = makeService();
    try {
      const outcome = await service.runPatrol();

      assert.equal(calls.patrol.length, 1, '应调用一次大哥巡检');
      assert.equal(outcome.conclusion, '有 1 项需要大老板处理');
      assert.equal(outcome.dispatches.length, 1);
      assert.equal(outcome.dispatches[0].projectName, 'beta');
      assert.equal(outcome.findings.length, 1);
      assert.equal(outcome.findings[0].severity, 'high');

      const inbox = await service.getInbox();
      const patrolItem = inbox.items.find((item) => item.kind === 'patrol');
      assert.ok(patrolItem, '收件箱应包含巡检条目');
      assert.equal(patrolItem.projectName, 'alpha');
      assert.match(patrolItem.body, /持续报错/);
      store.close();
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('巡检条目可被确认', async () => {
    const { service, store, dir } = makeService();
    try {
      const outcome = await service.runPatrol();
      const inbox = await service.getInbox();
      const item = inbox.items.find((i) => i.kind === 'patrol');
      assert.equal(item.acknowledged, false);

      await service.ack(item.id);
      const after = await service.getInbox();
      const acked = after.items.find((i) => i.kind === 'patrol');
      assert.equal(acked.acknowledged, true);
      void outcome;
      store.close();
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('巡检的事实简报包含项目、待决策项与计划任务', async () => {
    const { service, store, dir } = makeService();
    try {
      const snapshot = await service.snapshot();
      const brief = buildPatrolBrief(snapshot);

      assert.match(brief, /## 项目总览/);
      assert.match(brief, /alpha/);
      assert.match(brief, /## 待决策项/);
      store.close();
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('看板自己巡检不会刷新值班交班时间（否则会掩盖值班大哥掉线）', async () => {
    const { service, store, dir } = makeService();
    try {
      // The duty boss has never handed over.
      const before = await service.getPatrolConfig();
      assert.equal(before.lastRunAt, null);

      await service.runPatrol();

      const after = await service.getPatrolConfig();
      assert.equal(
        after.lastRunAt,
        null,
        '看板触发的巡检绝不能刷新 lastRunAt——那会让一个已经掉线的值班大哥继续显示「值班中」',
      );
      assert.ok(
        after.lastBoardPatrolAt > 0,
        '看板自己的巡检要写自己的时间戳，否则看板的下一次巡检会被无限触发',
      );
      store.close();
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('看板定时器挪时钟时也只挪自己的钟（这条路径没有别的护栏）', async () => {
    const dir = tmpDir();
    const store = new PatrolStore(join(dir, 'data'));
    try {
      // A duty handover is already on record; the board must not touch it.
      await store.setConfig({ lastRunAt: 1234 });
      const stamped = await stampBoardPatrol(store, 9999);

      const config = await store.getConfig();
      assert.equal(stamped, 9999);
      assert.equal(config.lastBoardPatrolAt, 9999, '看板的时钟要前进');
      assert.equal(config.lastRunAt, 1234, '值班交班时间戳一个字都不能动');
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('看板定时器的到期判断：旧配置首启即到期，之后按间隔节流', () => {
    const old = { enabled: true, intervalMinutes: 15 };
    assert.equal(isPatrolDue(old, 1_000_000), true, '没有 lastBoardPatrolAt = 从没跑过 = 立即到期');

    const justRan = { enabled: true, intervalMinutes: 15, lastBoardPatrolAt: 1_000_000 };
    assert.equal(isPatrolDue(justRan, 1_000_000 + 60_000), false, '刚跑过不该立刻再跑');
    assert.equal(isPatrolDue(justRan, 1_000_000 + 15 * 60_000), true, '一个间隔之后到期');
  });

  await t.test('看板定时器的动作：跳过 / 只挪时钟 / 真跑一轮', () => {
    const due = { enabled: true, intervalMinutes: 15, lastBoardPatrolAt: 0 };
    assert.equal(boardPatrolAction({ ...due, enabled: false }, false), 'skip', '没开就跳过');
    assert.equal(boardPatrolAction(due, true), 'stamp', '到期但收件箱没变化 → 只挪时钟');
    assert.equal(boardPatrolAction(due, false), 'run', '到期且有变化 → 跑一轮');
    assert.equal(
      boardPatrolAction({ ...due, lastBoardPatrolAt: Date.now() }, false),
      'skip',
      '没到期就跳过',
    );
  });

  await t.test('并发写不会失败，也不会互相覆盖字段', async () => {
    const dir = tmpDir();
    const dataDir = join(dir, 'data');
    // Two writers on one directory, the way the duty process and the board actually meet.
    const duty = new PatrolStore(dataDir);
    const board = new PatrolStore(dataDir);
    try {
      for (let round = 0; round < 20; round += 1) {
        await Promise.all([
          duty.setConfig({ lastRunAt: 1000 + round }),
          board.setConfig({ lastBoardPatrolAt: 2000 + round }),
        ]);
      }

      const config = await duty.getConfig();
      assert.equal(typeof config.lastRunAt, 'number', '值班交班时间戳不能被覆盖掉');
      assert.equal(typeof config.lastBoardPatrolAt, 'number', '看板自己的时间戳也不能被覆盖掉');
      // The file itself must still be readable JSON — a half-written file would break the board.
      const raw = JSON.parse(readFileSync(join(dataDir, 'patrol-config.json'), 'utf8'));
      assert.equal(typeof raw.lastRunAt, 'number');
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('大哥回复无法解析时也不静默', async () => {
    const { service, store, dir } = makeService({ text: '完全不符合格式的一段话' });
    try {
      const outcome = await service.runPatrol();
      assert.equal(outcome.findings.length, 1);
      assert.match(outcome.findings[0].body, /完全不符合格式/);
      store.close();
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('CLI 的 facts 带出值班状态：大哥能看出上一轮有没有交班', () => {
    const dir = tmpDir();
    const dbPath = makeRuntimeDb(dir);
    const dataDir = join(dir, 'data');
    try {
      // A board nobody has ever handed over on.
      const fresh = runCli(dbPath, dataDir);
      assert.equal(fresh.duty.neverRan, true, '没交过班要看得出来');
      assert.equal(fresh.duty.missedRounds, null);
      assert.equal(fresh.duty.stale, true);
      assert.equal(fresh.duty.dutyIntervalMinutes, 30, '事实表要带上值班周期');

      // The boss hands over: the duty state goes green.
      const reportFile = join(dir, 'report.json');
      writeFileSync(reportFile, JSON.stringify({ findings: [], answered: [] }), 'utf8');
      runCli(dbPath, dataDir, ['report', '--file', reportFile]);

      const handed = runCli(dbPath, dataDir);
      assert.equal(handed.duty.neverRan, false);
      assert.equal(handed.duty.missedRounds, 0, '刚交过班就不算漏');
      assert.equal(handed.duty.stale, false);
      assert.ok(handed.duty.lastRunAt > 0, '交班时间戳必须落盘');

      // Now age the clock: a round was interrupted and never handed over.
      const configPath = join(dataDir, 'patrol-config.json');
      const aged = JSON.parse(readFileSync(configPath, 'utf8'));
      aged.lastRunAt = Date.now() - 70 * 60_000;
      writeFileSync(configPath, JSON.stringify(aged), 'utf8');

      const gapped = runCli(dbPath, dataDir);
      assert.ok(gapped.duty.missedRounds >= 1, '漏了一轮以上，大哥必须能从事实表里看出来');
      assert.equal(gapped.duty.stale, true, '超过阈值就该被判掉线');
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('报告解析：容忍格式偏差', () => {
    const parsed = parsePatrolReport([
      '巡检结论：两件事',
      '- 项目: alpha | 级别: medium | 摘要: 需要你决定用哪个方案',
      '我已派工：',
      '- gamma: 修好了空指针',
    ].join('\n'));

    assert.equal(parsed.conclusion, '两件事');
    assert.equal(parsed.items.length, 1);
    assert.equal(parsed.items[0].projectName, 'alpha');
    assert.equal(parsed.items[0].severity, 'medium');
    assert.equal(parsed.dispatches.length, 1);
    assert.equal(parsed.dispatches[0].projectName, 'gamma');
  });

  await t.test('没有开启巡检时，巡检条目不出现', async () => {
    const { service, store, dir } = makeService();
    try {
      const inbox = await service.getInbox();
      assert.equal(inbox.items.filter((i) => i.kind === 'patrol').length, 0);
      store.close();
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('没有 patrol 存储时给出明确错误', async () => {
    const dir = tmpDir();
    try {
      const service = new ProjectService({
        store: RuntimeStore.open(makeRuntimeDb(dir)),
        readPlan: async () => null,
        skills: { skills: [], failures: [] },
        domains: [],
        persistence: new PersistenceStub(dir),
        boss: { dispatch: async () => ({}), patrol: async () => ({}) },
      });
      await assert.rejects(
        () => service.runPatrol(),
        (error) => error instanceof DomainError && error.code === 'patrol_unavailable',
      );
    } finally {
      cleanupDir(dir);
    }
  });
});
