import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { RuntimeStore } from '../miniapps/mimic-tear/miniapp/node/runtime-store.mjs';
import { makeRuntimeDb, tmpDir, cleanupDir } from './helpers/fixture.mjs';

test('RuntimeStore', async (t) => {
  const dir = tmpDir();
  const dbPath = makeRuntimeDb(dir);
  t.after(() => cleanupDir(dir));

  await t.test('列出项目：过滤掉无目录与隐藏项目，按最近活动排序', () => {
    const store = RuntimeStore.open(dbPath);
    const projects = store.listProjects();

    assert.equal(store.isAvailable(), true);
    assert.equal(store.lastError(), null);
    assert.equal(projects.length, 2, '隐藏项目与无目录的 default 项目应被过滤');
    assert.deepEqual(projects.map((p) => p.id), [2, 1], '按 latest_activity_at_ms 倒序');
    assert.equal(projects[0].workspaceDir, 'D:/projects/beta');
    assert.equal(projects[1].sessionCount, 3);
    store.close();
  });

  await t.test('列出会话：按 projectId 过滤，排除已归档', () => {
    const store = RuntimeStore.open(dbPath);
    const alpha = store.listSessions(1);

    assert.equal(alpha.length, 3, '已归档会话不应出现');
    assert.ok(alpha.every((s) => s.projectId === 1));
    assert.ok(alpha.some((s) => s.id === 'sess-alpha-w2' && s.status === 'error'));
    assert.equal(alpha.find((s) => s.id === 'sess-alpha-w2').errorCode, 50113);

    const all = store.listSessions();
    assert.equal(all.length, 6, '全量查询只排除已归档；项目可见性由领域服务负责过滤');
    store.close();
  });

  await t.test('会话保留父子关系字段，供组织树还原', () => {
    const store = RuntimeStore.open(dbPath);
    const alpha = store.listSessions(1);
    const member = alpha.find((s) => s.id === 'sess-alpha-w1');

    assert.equal(member.parentSessionId, 'sess-alpha-lead');
    assert.equal(member.purpose, 'local-background-task:bg_a');
    assert.equal(member.sessionType, 'child');
    store.close();
  });

  await t.test('Goal 列表保留完整 objective 与状态', () => {
    const store = RuntimeStore.open(dbPath);
    const goals = store.listGoals();

    assert.equal(goals.length, 3);
    const paused = goals.find((g) => g.id === 'goal-2');
    assert.equal(paused.objective, '把 beta 的存档系统做完');
    assert.equal(paused.status, 'paused');
    assert.equal(paused.tokensUsed, 22222);
    assert.equal(goals.find((g) => g.id === 'goal-3').dismissedAt, 8888);
    store.close();
  });

  await t.test('问卷：pendingOnly 只返回未答与未忽略', () => {
    const store = RuntimeStore.open(dbPath);

    // ask-1 is pending; ask-2 answered; ask-3 dismissed; ask-4 expired. An expired card
    // can no longer be answered, so it is not waiting for anyone.
    assert.equal(store.listQuestionnaires(true).length, 1);
    assert.equal(store.listQuestionnaires(true)[0].id, 'ask-1');
    assert.equal(store.listQuestionnaires(false).length, 4);
    store.close();
  });

  await t.test('活跃任务：排除 succeeded / failed / canceled', () => {
    const store = RuntimeStore.open(dbPath);
    const tasks = store.listActiveTasks();

    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].id, 'bg-run');
    assert.equal(tasks[0].status, 'running');
    store.close();
  });

  await t.test('revision：状态不变时保持稳定，写入后改变', () => {
    const store = RuntimeStore.open(dbPath);
    const first = store.revision();
    const second = store.revision();
    assert.equal(first, second, '未变更时 revision 应保持一致');
    assert.notEqual(first, 'unavailable');

    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE local_runtime_sessions SET status = 'started' WHERE session_id = ?")
      .run('sess-beta-lead');
    db.close();

    assert.notEqual(store.revision(), first, '状态变更后 revision 应改变');
    store.close();
  });

  await t.test('Review Focus 1：数据库缺失时不抛错，降级为不可用 + 错误原因', () => {
    const missing = join(dir, 'does-not-exist.sqlite');
    const store = RuntimeStore.open(missing);

    assert.equal(store.isAvailable(), false);
    assert.ok(store.lastError(), '应记录错误原因');
    assert.match(store.lastError(), /does-not-exist\.sqlite/, '错误信息应包含路径');
    assert.deepEqual(store.listProjects(), [], '读方法返回空数组而不是抛错');
    assert.deepEqual(store.listSessions(), []);
    assert.deepEqual(store.listGoals(), []);
    assert.deepEqual(store.listQuestionnaires(true), []);
    assert.deepEqual(store.listActiveTasks(), []);
    assert.equal(store.revision(), 'unavailable');
    store.close();
  });

  await t.test('Review Focus 1：文件存在但不是数据库时同样降级', () => {
    const bogus = join(dir, 'not-a-db.sqlite');
    writeFileSync(bogus, 'this is not a sqlite file');
    const store = RuntimeStore.open(bogus);

    assert.equal(store.isAvailable(), false);
    assert.ok(store.lastError());
    assert.deepEqual(store.listProjects(), []);
    store.close();
  });
});
