import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PatrolStore } from '../miniapps/mimic-tear/miniapp/node/patrol-store.mjs';
import { Persistence } from '../miniapps/mimic-tear/miniapp/node/persistence.mjs';
import { ProjectService } from '../miniapps/mimic-tear/miniapp/node/project-service.mjs';
import { RuntimeStore } from '../miniapps/mimic-tear/miniapp/node/runtime-store.mjs';
import {
  countWords,
  CONCLUSION_WORD_LIMIT,
  DEFAULT_DESK_LIMIT,
} from '../miniapps/mimic-tear/miniapp/node/patrol-rules.mjs';
import { makeRuntimeDb, tmpDir, cleanupDir } from './helpers/fixture.mjs';

const CLI_PATH = fileURLToPath(new URL('../miniapps/mimic-tear/miniapp/node/patrol-cli.mjs', import.meta.url));

/**
 * 跑真的 CLI（大哥从 cron 调的就是它）。
 *
 * @param {string} dbPath
 * @param {string} dataDir
 * @param {string[]} args
 * @returns {any}
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
 * 一个带值班结论账的看板。
 *
 * @param {any} [overrides]
 * @returns {{ service:any, store:any, patrol:any, dir:string, dbPath:string }}
 */
function makeService(overrides = {}) {
  const dir = tmpDir();
  const dbPath = makeRuntimeDb(dir);
  const store = RuntimeStore.open(dbPath);
  const patrol = new PatrolStore(join(dir, 'data'));
  const boss = {
    async dispatch() {
      return { bossSessionId: 'b1', status: 'finished', text: '已投递', error: null, delivered: true };
    },
    async patrol() {
      return {
        bossSessionId: 'b1',
        status: 'finished',
        text: '巡检结论：没有要处理的\n巡检状态：已完成',
        error: null,
      };
    },
  };
  const service = new ProjectService({
    store,
    readPlan: async () => null,
    skills: { skills: [], failures: [] },
    domains: [],
    persistence: new Persistence(join(dir, 'data')),
    boss,
    patrol,
    ...overrides,
  });
  return { service, store, patrol, dir, dbPath };
}

/**
 * 造一条结论的入参。
 *
 * @param {number} index
 * @param {{ severity?:string, projectName?:string }} [options]
 * @returns {any}
 */
function conclusion(index, options = {}) {
  return {
    projectId: 1,
    projectName: options.projectName ?? `项目${index}`,
    severity: options.severity ?? 'high',
    title: `结论 ${index}`,
    body: `第 ${index} 条结论的正文`,
  };
}

test('patrol-rules', async (t) => {
  await t.test('词数：中文按字、英文按空白分词，两者相加', () => {
    assert.equal(countWords(''), 0);
    assert.equal(countWords('你好'), 2, '中文按字');
    assert.equal(countWords('hello world'), 2, '英文按空白分词');
    assert.equal(countWords('会话 error 崩了'), 5, '中英相加：会话(2)+崩了(2)+error(1)');
    assert.equal(countWords('  \n '), 0, '空白不算词');
  });

  await t.test('桌面名额默认 20，且可配置', async () => {
    const { service, store, dir } = makeService();
    try {
      const config = await service.getPatrolConfig();
      assert.equal(config.deskLimit, DEFAULT_DESK_LIMIT);
      assert.equal(DEFAULT_DESK_LIMIT, 20, '默认上界是 20');
      store.close();
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('上界：连续产生的结论里，占桌面的不超过上界', async () => {
    const { service, patrol, store, dir } = makeService();
    try {
      for (let i = 0; i < 30; i += 1) {
        await patrol.add(conclusion(i));
      }

      const inbox = await service.getInbox();
      const onDesk = inbox.items.filter((item) => item.kind === 'patrol' && item.severity !== 'low' && !item.acknowledged);
      assert.equal(onDesk.length, DEFAULT_DESK_LIMIT, '桌面上的「需要你拍板」结论不超过上界');

      // 但它们一条都不能丢：账上仍然是 30 条。
      const ledger = await patrol.list();
      assert.equal(ledger.length, 30, '超界的结论仍然记在账上，不许丢');
      const overflow = ledger.filter((finding) => finding.onDesk === false);
      assert.equal(overflow.length, 10, '超界的那些被标成「不在桌面」');
      store.close();
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('上界可配置：改小之后按新的名额算', async () => {
    const { service, patrol, store, dir } = makeService();
    try {
      await patrol.setConfig({ deskLimit: 5 });
      for (let i = 0; i < 12; i += 1) {
        await patrol.add(conclusion(i));
      }
      const inbox = await service.getInbox();
      const onDesk = inbox.items.filter((item) => item.kind === 'patrol' && item.severity !== 'low' && !item.acknowledged);
      assert.equal(onDesk.length, 5, '配置写小了就按小的算');
      assert.equal((await patrol.list()).length, 12, '账上仍然一条不少');
      store.close();
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('运行时产生的收件箱项不受上界约束', async () => {
    const { service, patrol, store, dir } = makeService();
    try {
      await patrol.setConfig({ deskLimit: 1 });
      for (let i = 0; i < 5; i += 1) {
        await patrol.add(conclusion(i));
      }
      const inbox = await service.getInbox();
      const runtime = inbox.items.filter((item) => item.kind !== 'patrol');
      assert.ok(runtime.length > 0, '运行时原始项不受上界约束——那不是大哥能控制的');
      store.close();
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('同类合并：同键且未确认的结论并进已有那条，不新增', async () => {
    const { patrol, store, dir } = makeService();
    try {
      const first = await patrol.add({
        projectId: 1,
        projectName: 'alpha',
        severity: 'high',
        title: '第一版摘要',
        body: '第一版正文',
      });
      const second = await patrol.add({
        projectId: 1,
        projectName: 'alpha',
        severity: 'high',
        title: '第二版摘要',
        body: '第二版正文',
      });

      const ledger = await patrol.list();
      assert.equal(ledger.length, 1, '同键的结论只占一条');
      assert.equal(second.id, first.id, '并进已有那条——id 不变');
      assert.equal(ledger[0].title, '第二版摘要', '摘要更新成后一次说的');
      assert.equal(ledger[0].body, '第二版正文', '正文更新成后一次说的');
      assert.ok(ledger[0].updatedAt >= ledger[0].createdAt, '并进去的结论带 updatedAt');
      store.close();
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('幂等：同一份输入连报两次，账上仍是同一条、内容一致', async () => {
    const { patrol, store, dir } = makeService();
    try {
      const input = {
        projectId: 1,
        projectName: 'alpha',
        severity: 'medium',
        title: '同一份结论',
        body: '同一份正文',
      };
      await patrol.add(input);
      await patrol.add(input);

      const ledger = await patrol.list();
      assert.equal(ledger.length, 1, '连报两次还是一条');
      assert.equal(ledger[0].title, '同一份结论');
      assert.equal(ledger[0].body, '同一份正文');
      store.close();
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('已确认的结论不参与合并：新问题是一条新结论', async () => {
    const { patrol, store, dir } = makeService();
    try {
      const first = await patrol.add({
        projectId: 1,
        projectName: 'alpha',
        severity: 'high',
        title: '老问题',
        body: '老正文',
      });
      await patrol.ack(first.id, 'user', '已处理');

      await patrol.add({
        projectId: 1,
        projectName: 'alpha',
        severity: 'high',
        title: '又出现了',
        body: '新正文',
      });

      const ledger = await patrol.list();
      assert.equal(ledger.length, 2, '已确认的那条不吞掉新问题');
      store.close();
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('带宽纪律：超 100 词的结论在入账这一层就被拒绝', async () => {
    const { patrol, store, dir } = makeService();
    try {
      const ok = await patrol.add({
        projectId: 1,
        projectName: 'alpha',
        severity: 'high',
        title: '刚好一百词',
        body: '字'.repeat(CONCLUSION_WORD_LIMIT),
      });
      assert.ok(ok.id);

      let rejected = null;
      try {
        await patrol.add({
          projectId: 1,
          projectName: 'beta',
          severity: 'high',
          title: '一百零一词',
          body: '字'.repeat(CONCLUSION_WORD_LIMIT + 1),
        });
      } catch (error) {
        rejected = error;
      }
      assert.ok(rejected, '超限必须被拒绝，不能入账');
      assert.match(String(rejected.message), new RegExp(String(CONCLUSION_WORD_LIMIT)), '错误信息要说出上限');
      assert.match(String(rejected.message), /超/, '错误信息要说出超了多少');

      const ledger = await patrol.list();
      assert.equal(ledger.length, 1, '被拒绝的结论没有进账');
      store.close();
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('带宽纪律：CLI 也拦得住，并说清超了多少', () => {
    const dir = tmpDir();
    const dbPath = makeRuntimeDb(dir);
    const dataDir = join(dir, 'data');
    try {
      const reportFile = join(dir, 'report.json');
      writeFileSync(reportFile, JSON.stringify({
        findings: [{
          projectId: 1,
          projectName: 'alpha',
          severity: 'high',
          title: '太长',
          body: '字'.repeat(CONCLUSION_WORD_LIMIT + 20),
        }],
        answered: [],
      }), 'utf8');

      const result = runCli(dbPath, dataDir, ['report', '--file', reportFile]);
      assert.equal(result.findings, 0, '超限的结论没入账');
      assert.equal(result.rejected.length, 1, '被拒绝的那条要说清楚');
      assert.match(result.rejected[0].error, new RegExp(String(CONCLUSION_WORD_LIMIT)), '要说清上限');
      assert.match(result.rejected[0].error, /超/, '要说清超了多少');
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('归档：一条都不删，账本清空，元数据能查到', async () => {
    const { patrol, store, dir } = makeService();
    try {
      for (let i = 0; i < 5; i += 1) {
        await patrol.add(conclusion(i));
      }
      const before = await patrol.list();
      assert.equal(before.length, 5);

      const result = await patrol.archive({ reason: '历史结论退场', by: 'boss' });
      assert.equal(result.archived, 5, '归档了多少条要说清');

      const ledger = await patrol.list();
      assert.equal(ledger.length, 0, '归档之后账本空了——桌面清空');

      const archive = await patrol.listArchive();
      assert.equal(archive.batches.length, 1, '归档动作留痕');
      const batch = archive.batches[0];
      assert.equal(batch.count, 5, '元数据带条数');
      assert.equal(batch.reason, '历史结论退场', '元数据带为什么');
      assert.equal(batch.archivedBy, 'boss', '元数据带谁归档的');
      assert.ok(batch.archivedAt > 0, '元数据带归档时间');
      assert.equal(batch.findings.length, 5, '归档里的内容一条不少');
      assert.equal(
        ledger.length + archive.batches.reduce((sum, b) => sum + b.findings.length, 0),
        before.length,
        '归档后账本 + 归档条数 = 归档前的条数：一条都不许丢',
      );
      store.close();
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('归档：CLI 能读，facts 里能看到归档了多少条', () => {
    const dir = tmpDir();
    const dbPath = makeRuntimeDb(dir);
    const dataDir = join(dir, 'data');
    try {
      mkdirSync(dataDir, { recursive: true });
      const reportFile = join(dir, 'report.json');
      writeFileSync(reportFile, JSON.stringify({
        findings: [
          { projectId: 1, projectName: 'alpha', severity: 'high', title: '一', body: '一' },
          { projectId: 1, projectName: 'beta', severity: 'medium', title: '二', body: '二' },
        ],
        answered: [],
      }), 'utf8');
      runCli(dbPath, dataDir, ['report', '--file', reportFile]);

      const archived = runCli(dbPath, dataDir, ['archive', '历史结论退场']);
      assert.equal(archived.ok, true);
      assert.equal(archived.archived, 2, '归档了多少条');

      const facts = runCli(dbPath, dataDir, ['facts']);
      assert.equal(facts.archive.total, 2, 'facts 里能看到归档了多少条');
      assert.equal(facts.archive.reason, '历史结论退场', 'facts 里能看到为什么归档');
      assert.equal(facts.alreadyReported.length, 2, '归档之后结论仍在去重账里——大哥不会重复报同一个问题');
    } finally {
      cleanupDir(dir);
    }
  });
});
