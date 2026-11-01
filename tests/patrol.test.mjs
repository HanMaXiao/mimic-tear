import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PatrolStore } from '../miniapps/mimic-tear/miniapp/node/patrol-store.mjs';
import { Persistence } from '../miniapps/mimic-tear/miniapp/node/persistence.mjs';
import { ProjectService, DomainError } from '../miniapps/mimic-tear/miniapp/node/project-service.mjs';
import {
  boardPatrolAction,
  isPatrolDue,
  stampBoardPatrol,
} from '../miniapps/mimic-tear/miniapp/node/patrol-scheduler.mjs';
import { buildPatrolBrief, parsePatrolReport } from '../miniapps/mimic-tear/miniapp/node/view-model.mjs';
import { RuntimeStore } from '../miniapps/mimic-tear/miniapp/node/runtime-store.mjs';
import { makeRuntimeDb, readBoardSection, tmpDir, cleanupDir } from './helpers/fixture.mjs';

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

/**
 * Run the CLI expecting it to fail, and hand back what it said.
 *
 * A refused grant is a real outcome the boss has to be able to read, so the refusal
 * carries as much meaning as the grant.
 */
function runCliExpectFailure(dbPath, dataDir, args) {
  try {
    runCli(dbPath, dataDir, args);
  } catch (error) {
    return { status: error.status ?? 1, stderr: String(error.stderr ?? ''), stdout: String(error.stdout ?? '') };
  }
  throw new Error('命令本该失败，却成功了');
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
    this.dismissed = new Map();
  }
  async listAcks() {
    return [...this.acks];
  }
  async addAck(id) {
    this.acks.add(id);
  }
  async listDismissed() {
    return [...this.dismissed].map(([id, reason]) => ({ id, reason, at: Date.now() }));
  }
  async addDismissed(id, reason) {
    this.dismissed.set(id, reason);
    return this.listDismissed();
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
      // The duty cron runs every 30 minutes; the "boss went quiet" warning is derived
      // from this, so it is a first-class setting and not a hidden constant.
      assert.equal(config.dutyIntervalMinutes, 30);
      // There is no autoDispatch switch any more: the boss decides for itself.
      assert.equal('autoDispatch' in config, false, 'autoDispatch 这个开关已经被移除');
      void patrol;
      store.close();
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('配置里残留的废键不能复活——删掉的功能不能靠状态文件长回来', async () => {
    const { patrol, store, dir } = makeService();
    try {
      // The live config file on this machine still carries `autoDispatch` from before the
      // switch was removed. Reading it back must not resurrect the switch.
      const configPath = join(dir, 'data', 'patrol-config.json');
      mkdirSync(join(dir, 'data'), { recursive: true });
      writeFileSync(configPath, JSON.stringify({ enabled: true, autoDispatch: false, legacyThing: 1 }), 'utf8');

      const config = await patrol.getConfig();
      assert.equal('autoDispatch' in config, false, '废键不能进配置');
      assert.equal('legacyThing' in config, false, '来路不明的键也不能进配置');
      assert.equal(config.enabled, true, '真字段照常读');

      // And the next write cleans the file instead of carrying the residue forward.
      await patrol.setConfig({ lastRunAt: 1234 });
      const raw = readBoardSection(join(dir, 'data'), 'config');
      assert.equal('autoDispatch' in raw, false, '写回去的时候要把废键清掉');
      assert.equal(raw.lastRunAt, 1234, '真字段不能被清掉');
    } finally {
      store.close();
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
      const raw = readBoardSection(dataDir, 'config');
      assert.equal(typeof raw.lastRunAt, 'number');
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('CLI 的 withdraw 能撤回大哥自己那条已不适用的结论', () => {
    const dir = tmpDir();
    const dbPath = makeRuntimeDb(dir);
    const dataDir = join(dir, 'data');
    try {
      // The boss files a conclusion...
      const reportFile = join(dir, 'report.json');
      writeFileSync(reportFile, JSON.stringify({
        findings: [{
          projectId: 10,
          projectName: 'Contra-Survivor',
          severity: 'high',
          title: '需要你加额度',
          body: '4 个会话以 2056 额度上限中断',
        }],
        answered: [],
      }), 'utf8');
      runCli(dbPath, dataDir, ['report', '--file', reportFile]);

      const filed = runCli(dbPath, dataDir).alreadyReported[0];
      assert.equal(filed.acknowledged, false);

      // ...and later finds out it no longer applies, so it withdraws it with a reason.
      const result = runCli(dbPath, dataDir, ['withdraw', filed.id, '账号并未被额度卡住，这条结论已过期']);
      assert.equal(result.ok, true);
      assert.equal(result.acknowledgedBy, 'boss');

      const after = runCli(dbPath, dataDir).alreadyReported[0];
      assert.equal(after.acknowledged, true, '撤回后这条不该再占用大老板的收件箱');
      assert.equal(after.acknowledgedBy, 'boss');
      assert.match(after.note, /过期/);

      // No reason means no withdrawal: a retraction without a reason is just quieter noise.
      let rejected = false;
      try {
        runCli(dbPath, dataDir, ['withdraw', filed.id]);
      } catch (error) {
        rejected = error.status === 2;
      }
      assert.equal(rejected, true, '没有撤回理由必须被拒绝');
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('CLI 的 dismiss 能排除一条运行时原始项，并留下理由', () => {
    const dir = tmpDir();
    const dbPath = makeRuntimeDb(dir);
    const dataDir = join(dir, 'data');
    try {
      // The fact sheet carries the raw runtime items the boss can rule out.
      //
      // `--scope raw` = the complete sheet. The default view is the **candidates** view —
      // only what the boss is granted to act on — so a runtime item from an ungranted
      // project is not in it. This test is about the complete sheet, so it asks for it.
      const facts = runCli(dbPath, dataDir, ['facts', '--scope', 'raw']);
      const item = facts.decisions.find((entry) => entry.id.startsWith('session-error:'));
      assert.ok(item, '事实表里应该有待排除的运行时原始项');

      const result = runCli(dbPath, dataDir, ['dismiss', item.id, '这条会话早就停了，是残骸不是故障']);
      assert.equal(result.ok, true);
      assert.equal(result.id, item.id);

      const dismissed = readBoardSection(dataDir, 'dismissed');
      assert.equal(dismissed.length, 1);
      assert.equal(dismissed[0].id, item.id);
      assert.match(dismissed[0].reason, /残骸/, '排除必须留下理由');

      // No reason, no exclusion — same rule as withdrawing a conclusion.
      let rejected = false;
      try {
        runCli(dbPath, dataDir, ['dismiss', 'plan-blocked:5:custom-rule-ui']);
      } catch (error) {
        rejected = error.status === 2;
      }
      assert.equal(rejected, true, '没有排除理由必须被拒绝');
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('CLI 的 answer 能代答一张卡：只记答案，不打交班戳', () => {
    const dir = tmpDir();
    const dbPath = makeRuntimeDb(dir);
    const dataDir = join(dir, 'data');
    try {
      // **requestId 必须是运行时库里真实存在的卡**：`ask-1` 是 fixture 里 status='pending'
      // 的那张。给一张查无此卡的记一笔 = 造一笔谁也查不到底的假账，CLI 现在会拒绝入账
      // （2026-11-01 上岗验收轮查出来的）。
      const result = runCli(dbPath, dataDir, [
        'answer', 'ask-1', '--answer', '同意，先做 A', '--rationale', '风险可逆', '--session-id', 'sess-alpha-lead',
      ]);
      assert.equal(result.ok, true);
      assert.equal(result.requestId, 'ask-1');

      const answered = readBoardSection(dataDir, 'answered');
      assert.equal(answered.length, 1, '答案要记进账');
      assert.equal(answered[0].answer, '同意，先做 A');
      assert.equal(answered[0].sessionId, 'sess-alpha-lead');
      assert.match(answered[0].rationale, /风险可逆/);

      // **不打交班戳**：代答一张卡不是交班。戳是值班大哥的。
      const config = readBoardSection(dataDir, 'config');
      assert.equal(config.lastRunAt ?? null, null, '代答不许刷新交班戳');
      assert.equal(readBoardSection(dataDir, 'findings').length, 0, '代答不写结论');

      // 幂等：同一张卡记两次，账上还是一条。
      runCli(dbPath, dataDir, ['answer', 'ask-1', '--answer', '同意，先做 A']);
      assert.equal(readBoardSection(dataDir, 'answered').length, 1, '同一张卡不能记成两次');

      // 少给答案要被拒绝（exit 2）。**这里必须用一张真实存在的卡**——
      // 否则「查无此卡」也会回 exit 2，这条断言就成了恒真的，抓不到真问题。
      let rejected = false;
      try {
        runCli(dbPath, dataDir, ['answer', 'ask-1']);
      } catch (error) {
        rejected = error.status === 2;
      }
      assert.equal(rejected, true, '没有答案内容必须被拒绝');
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('CLI 的 export-legacy：回退是显式动作，老文件能补齐', () => {
    const dir = tmpDir();
    const dbPath = makeRuntimeDb(dir);
    const dataDir = join(dir, 'data');
    try {
      const reportFile = join(dir, 'report.json');
      writeFileSync(reportFile, JSON.stringify({
        findings: [{ projectName: 'alpha', severity: 'high', title: '一条结论', body: '需要你处理' }],
        answered: [],
      }), 'utf8');
      runCli(dbPath, dataDir, ['report', '--file', reportFile]);

      // 有人把老文件改了——回退前要能补齐。
      writeFileSync(join(dataDir, 'patrol.json'), '[]', 'utf8');

      const result = runCli(dbPath, dataDir, ['export-legacy']);
      assert.equal(result.ok, true, '导出不该有段失败');
      assert.ok(result.written.includes('findings'));

      const findings = JSON.parse(readFileSync(join(dataDir, 'patrol.json'), 'utf8'));
      assert.equal(findings.length, 1, '老文件补齐后结论还在');
      assert.equal(findings[0].title, '一条结论');
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

  await t.test('CLI 的 facts 带出值班状态：大哥能看出上一轮有没有交班', async () => {
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
      runCli(dbPath, dataDir, ['report', '--file', reportFile, '--duty-stamp']);

      const handed = runCli(dbPath, dataDir);
      assert.equal(handed.duty.neverRan, false);
      assert.equal(handed.duty.missedRounds, 0, '刚交过班就不算漏');
      assert.equal(handed.duty.stale, false);
      assert.ok(handed.duty.lastRunAt > 0, '交班时间戳必须落盘');

      // Now age the clock: a round was interrupted and never handed over.
      // 交班戳住在板面状态的 store 里（`config` 段），所以「把时间拨老」得走 store。
      await new PatrolStore(dataDir).setConfig({ lastRunAt: Date.now() - 70 * 60_000 });

      const gapped = runCli(dbPath, dataDir);
      assert.ok(gapped.duty.missedRounds >= 1, '漏了一轮以上，大哥必须能从事实表里看出来');
      assert.equal(gapped.duty.stale, true, '超过阈值就该被判掉线');
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('CLI 的 facts 带出管辖名单：大哥每轮都要知道自己管哪些项目', () => {
    const dir = tmpDir();
    const dbPath = makeRuntimeDb(dir);
    const dataDir = join(dir, 'data');
    try {
      // Nobody has granted jurisdiction yet, so the list is empty — the boss must not
      // assume it manages anything.
      const empty = runCli(dbPath, dataDir);
      assert.deepEqual(empty.managed, [], '没有授权就没有管辖');

      // The user names a project; the boss may now manage it.
      runCli(dbPath, dataDir, ['manage', 'add', 'alpha', '大老板 2026-10-21 指示：让大哥盯 alpha']);

      const granted = runCli(dbPath, dataDir);
      assert.equal(granted.managed.length, 1);
      assert.equal(granted.managed[0].name, 'alpha');
      assert.match(granted.managed[0].reason, /大老板/, '名单必须带上大老板的原话');

      // And the user takes it back.
      runCli(dbPath, dataDir, ['manage', 'remove', 'alpha', '大老板说这个项目先不用管']);
      assert.deepEqual(runCli(dbPath, dataDir).managed, [], '撤销后名单要空');
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('授权给了一个不存在的项目名：必须当场拒绝，不能静默落空', () => {
    const dir = tmpDir();
    const dbPath = makeRuntimeDb(dir);
    const dataDir = join(dir, 'data');
    try {
      // A grant that names nothing governs nothing, and the boss would only ever report
      // "当前无管辖项目" without ever learning the name was the problem. Refuse it.
      const failure = runCliExpectFailure(dbPath, dataDir, [
        'manage', 'add', 'Dungeon-Chesser', '大老板 2026-10-21 指示：让大哥盯 Dungeon-Chesser',
      ]);
      assert.equal(failure.status, 2, '名字对不上要报错退出');
      assert.match(failure.stderr, /落空|没有叫/, '错误信息要说清授权没落地');
      assert.deepEqual(runCli(dbPath, dataDir).managed, [], '失败的授权不能留在名单上');

      // The correct name still works.
      runCli(dbPath, dataDir, ['manage', 'add', 'alpha', '大老板指示']);
      assert.equal(runCli(dbPath, dataDir).managed.length, 1);
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('授权要能对上项目：名单带出匹配结果，落在哪个项目上一目了然', () => {
    const dir = tmpDir();
    const dbPath = makeRuntimeDb(dir);
    const dataDir = join(dir, 'data');
    try {
      runCli(dbPath, dataDir, ['manage', 'add', 'alpha', '大老板指示']);

      const granted = runCli(dbPath, dataDir);
      assert.equal(granted.managed[0].matched, true, '这份授权要落在真实项目上');
      assert.equal(granted.managed[0].projectName, 'alpha');
      assert.equal(granted.managed[0].projectId, 1);
      assert.equal(granted.managed[0].path, 'D:/projects/alpha');
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('撤销一个不存在的名字：什么都不变，但要说出"没变"', () => {
    const dir = tmpDir();
    const dbPath = makeRuntimeDb(dir);
    const dataDir = join(dir, 'data');
    try {
      runCli(dbPath, dataDir, ['manage', 'add', 'alpha', '大老板指示']);
      // A typo in a revocation leaves the jurisdiction in place — the boss keeps managing
      // a project the user thought they had released. The command must say so.
      const result = runCli(dbPath, dataDir, ['manage', 'remove', 'Alpah', '大老板说不用管了']);
      assert.equal(result.removed, false, '名字不在名单上就是没撤销');
      assert.match(result.warning ?? '', /什么都没变/, '要说清撤销没有生效');
      assert.equal(runCli(dbPath, dataDir).managed.length, 1, '原授权必须还在');
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('管辖范围内的项目要能查出该跟谁说话：ownerSessions 带着会话 id', () => {
    const dir = tmpDir();
    const dbPath = makeRuntimeDb(dir);
    const dataDir = join(dir, 'data');
    try {
      runCli(dbPath, dataDir, ['manage', 'add', 'alpha', '大老板指示']);

      // The complete sheet shows both projects and marks which one is in the jurisdiction.
      // The default (candidates) view only carries the granted project — that is the point
      // of the first filter — so this assertion reads the complete sheet.
      const facts = runCli(dbPath, dataDir, ['facts', '--scope', 'raw']);
      const alpha = facts.projects.find((project) => project.name === 'alpha');
      const beta = facts.projects.find((project) => project.name === 'beta');

      assert.equal(alpha.managed, true, '在名单里的项目要标出来');
      assert.equal(beta.managed, false, '不在名单里的项目不算管辖范围');
      assert.equal(beta.ownerSessions, undefined, '名单外的项目不带会话入口——那是越权的入口');

      // And the default view is the other half of the same contract: the granted project
      // only, with the ungranted one counted rather than carried.
      const candidates = runCli(dbPath, dataDir);
      assert.equal(candidates.scope, 'candidates');
      assert.equal(candidates.projects.length, 1, '候选视图只带管辖区内的项目');
      assert.equal(candidates.projects[0].name, 'alpha');
      assert.ok(candidates.excluded.projects >= 1, '滤掉的数量要报出来');

      // The boss needs the session id to send a message to; a name on a list is not a door.
      const ids = alpha.ownerSessions.map((session) => session.id);
      assert.ok(ids.includes('sess-alpha-lead'), '要带出主会话的 id');
      assert.equal(alpha.ownerSessionId, 'sess-alpha-lead', '默认对接对象是主会话');

      const lead = alpha.ownerSessions.find((session) => session.id === 'sess-alpha-lead');
      assert.equal(lead.isRoot, true, '要能分出主会话和子任务');
      assert.equal(lead.status, 'started');
      assert.equal(lead.goalId, 'goal-1', '要带着 goal，才能判断这条线在跑什么');
      assert.equal(lead.goalStatus, 'active');
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

  await t.test('结论要带来源：值班路径写的算 duty，看板自己巡检的算 board', async () => {
    const dir = tmpDir();
    const dataDir = join(dir, 'data');
    const patrol = new PatrolStore(dataDir);
    try {
      // The duty path (the CLI the boss calls from its cron round) writes through the
      // store without saying where the conclusion came from.
      const duty = await patrol.add({
        projectId: 1,
        projectName: 'alpha',
        severity: 'high',
        title: '值班结论',
        body: '这一轮发现的问题',
      });
      assert.equal(duty.source, 'duty', '值班路径写的结论来源是 duty');

      // The board's own patrol loop says so explicitly.
      const board = await patrol.add({
        projectId: 1,
        projectName: 'alpha',
        severity: 'medium',
        title: '看板结论',
        body: '这一轮发现的问题',
        source: 'board',
      });
      assert.equal(board.source, 'board');

      const stored = await patrol.list();
      assert.equal(stored.length, 2);
      assert.equal(stored.find((f) => f.title === '值班结论').source, 'duty');
      assert.equal(stored.find((f) => f.title === '看板结论').source, 'board');
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('旧结论没有来源字段：默认 board，一条都不能少', async () => {
    const dir = tmpDir();
    const dataDir = join(dir, 'data');
    try {
      // A conclusion written before the field existed.
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(join(dataDir, 'patrol.json'), JSON.stringify([
        {
          id: 'patrol_legacy',
          createdAt: 1,
          projectId: 1,
          projectName: 'alpha',
          severity: 'high',
          title: '旧结论',
          body: '还没有来源字段时写的',
          acknowledged: false,
          acknowledgedBy: null,
          note: '',
        },
      ]), 'utf8');

      const patrol = new PatrolStore(dataDir);
      const findings = await patrol.list();
      assert.equal(findings.length, 1, '旧结论不能被丢掉');
      assert.equal(findings[0].source, 'board', '旧结论按 board 兜底');
      assert.equal(findings[0].title, '旧结论', '旧结论的内容一个字都不能少');
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('值班路径的投递要进派工账，标成 duty', async () => {
    const dir = tmpDir();
    const dataDir = join(dir, 'data');
    const patrol = new PatrolStore(dataDir);
    try {
      await patrol.recordDutyDispatch({
        targetSessionId: 'sess-alpha-lead',
        instruction: '把 P1 排到明天',
        text: '按你的要求排的',
      });

      const dispatches = readBoardSection(dataDir, 'dispatches');
      assert.equal(dispatches.length, 1, '值班路径的投递要落在看板那本账里');
      assert.equal(dispatches[0].source, 'duty');
      assert.equal(dispatches[0].targetSessionId, 'sess-alpha-lead');
      assert.equal(dispatches[0].instruction, '把 P1 排到明天');
      assert.equal(dispatches[0].status, 'done');
      // The board's idempotency key space stays untouched: a duty record can never be
      // found by a board key lookup, so a fresh instruction is never a false duplicate.
      assert.equal(dispatches[0].idempotencyKey, null);
      assert.notEqual(dispatches[0].id.startsWith('dsp_duty_'), false, '值班记录的 id 要有自己的前缀');
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('大哥代答时的那次投递也要记账——不然两条线索各说各话', async () => {
    const dir = tmpDir();
    const dataDir = join(dir, 'data');
    const patrol = new PatrolStore(dataDir);
    try {
      await patrol.markAnswered({
        requestId: 'req-1',
        sessionId: 'sess-alpha-lead',
        answer: '选方案 A',
        rationale: '风险可逆',
        optionIds: ['a'],
      });

      const dispatches = readBoardSection(dataDir, 'dispatches');
      assert.equal(dispatches.length, 1, '代答也是一次真实投递');
      assert.equal(dispatches[0].source, 'duty');
      assert.equal(dispatches[0].targetSessionId, 'sess-alpha-lead');
      assert.equal(dispatches[0].instruction, '选方案 A');

      // The same card answered twice is still one delivery — no double counting.
      await patrol.markAnswered({
        requestId: 'req-1',
        sessionId: 'sess-alpha-lead',
        answer: '选方案 A',
        rationale: '风险可逆',
        optionIds: ['a'],
      });
      const again = readBoardSection(dataDir, 'dispatches');
      assert.equal(again.length, 1, '同一张卡不能被记成两次投递');
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('值班路径写账不能把看板已有的派工记录挤掉', async () => {    const dir = tmpDir();
    const dataDir = join(dir, 'data');
    const patrol = new PatrolStore(dataDir);
    try {
      // The board writes its own record first, the way the dispatch button does.
      const persistence = new Persistence(dataDir);
      await persistence.saveDispatch({
        id: 'dsp_board_1',
        idempotencyKey: 'key-1',
        source: 'board',
        projectId: 1,
        projectName: 'alpha',
        targetSessionId: 'sess-alpha-lead',
        instruction: '看板下达的指令',
        status: 'done',
        bossSessionId: 'boss-session-1',
        text: '',
        error: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      await patrol.recordDutyDispatch({
        targetSessionId: 'sess-beta-lead',
        instruction: '值班投递的指令',
      });

      const dispatches = readBoardSection(dataDir, 'dispatches');
      assert.equal(dispatches.length, 2, '两条记录都要在');
      assert.ok(
        dispatches.some((d) => d.id === 'dsp_board_1' && d.idempotencyKey === 'key-1'),
        '看板那条记录不能被值班写入挤掉——它一丢，同一个幂等键就会被投递两次',
      );
      assert.ok(dispatches.some((d) => d.source === 'duty'));

      // And the board's key lookup still finds its own record only.
      const found = await persistence.findDispatchByKey('key-1');
      assert.equal(found?.id, 'dsp_board_1');
      assert.equal(await persistence.findDispatchByKey('duty'), null, '值班记录不能被看板的键查到');
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('值班路径（CLI report）写出来的结论，来源是 duty', () => {
    const dir = tmpDir();
    const dbPath = makeRuntimeDb(dir);
    const dataDir = join(dir, 'data');
    try {
      // The real duty path: the boss runs `report --duty-stamp` from its cron round.
      const reportFile = join(dir, 'report.json');
      writeFileSync(reportFile, JSON.stringify({
        findings: [{
          projectId: 1,
          projectName: 'alpha',
          severity: 'high',
          title: '值班结论',
          body: '需要你处理',
        }],
        answered: [],
      }), 'utf8');
      runCli(dbPath, dataDir, ['report', '--file', reportFile, '--duty-stamp']);

      const findings = readBoardSection(dataDir, 'findings');
      assert.equal(findings.length, 1);
      assert.equal(findings[0].source, 'duty', '值班路径写出来的结论必须带 duty 来源');

      // And the boss's own fact sheet can tell the two origins apart.
      const facts = runCli(dbPath, dataDir);
      assert.equal(facts.duty.dutyOpenFindings, 1);
      assert.equal(facts.duty.boardOpenFindings, 0);
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('派工账坏了：不能被清空重来，交班也不能因此丢掉', async () => {
    const dir = tmpDir();
    const dataDir = join(dir, 'data');
    const patrol = new PatrolStore(dataDir);
    try {
      mkdirSync(dataDir, { recursive: true });
      // A ledger that cannot be parsed. Overwriting it would throw away records that
      // are still the only trace of what was delivered.
      writeFileSync(join(dataDir, 'dispatches.json'), '{ 这不是 JSON', 'utf8');

      await assert.rejects(
        () => patrol.recordDutyDispatch({ targetSessionId: 'sess-alpha-lead', instruction: 'x' }),
        (error) => /JSON|数组/.test(String(error?.message ?? '')),
        '写坏了的账要报错，不能默默重来',
      );
      assert.equal(
        readFileSync(join(dataDir, 'dispatches.json'), 'utf8'),
        '{ 这不是 JSON',
        '坏掉的内容不能被覆盖掉',
      );

      // And the duty path's handover must not die because of it: the answer is still
      // recorded, and the round still hands over.
      await patrol.markAnswered({
        requestId: 'req-1',
        sessionId: 'sess-alpha-lead',
        answer: '选方案 A',
      });
      const answered = await patrol.listAnswered();
      assert.equal(answered.length, 1, '代答记录必须落盘');
    } finally {
      cleanupDir(dir);
    }
  });
});
