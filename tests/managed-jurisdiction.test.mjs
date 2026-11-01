import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { ManagedProjects, resolveManagedEntries, matchManagedProject } from '../miniapps/mimic-tear/miniapp/node/managed-projects.mjs';
import { PatrolStore } from '../miniapps/mimic-tear/miniapp/node/patrol-store.mjs';
import { RuntimeStore } from '../miniapps/mimic-tear/miniapp/node/runtime-store.mjs';
import { ThreadSubscriptions } from '../miniapps/mimic-tear/miniapp/node/thread-subscriptions.mjs';
import { planRound } from '../miniapps/mimic-tear/miniapp/node/direct-delivery-runner.mjs';
import { makeRuntimeDb, tmpDir, cleanupDir } from './helpers/fixture.mjs';

test('名单条目必须对着项目集解析过，才算数', async () => {
  const dir = tmpDir();
  try {
    const managed = new ManagedProjects(dir);
    await managed.add('alpha', '大老板点名要盯这个');
    await managed.add('不存在的项目', '大老板点名了一个没有的项目');

    const projects = [{ id: 1, workspaceDir: 'D:/projects/alpha' }];
    const raw = await managed.list();

    // `list()` 给的是**名单本身**：它不知道运行时有没有这个项目，所以没有 `matched`。
    assert.equal(raw[0].matched, undefined, '原始条目不该带 matched——那是解析出来的');

    const resolved = resolveManagedEntries(raw, projects);
    assert.equal(resolved[0].matched, true, '指得到项目的授权是生效的');
    assert.equal(resolved[0].projectName, 'alpha');
    assert.equal(resolved[1].matched, false, '指不到项目的授权不生效——它管不到任何东西');
  } finally {
    cleanupDir(dir);
  }
});

test('项目名解析：精确优先，差一点的名字只算候选', () => {
  const projects = [
    { id: 1, workspaceDir: 'D:/projects/alpha' },
    { id: 2, workspaceDir: 'D:/projects/alphabet' },
  ];
  assert.equal(matchManagedProject('alpha', projects).project?.id, 1, '精确命中');
  assert.equal(matchManagedProject('alpha', projects).candidates.length, 0, '精确命中时没有候选');
  assert.equal(matchManagedProject('不存在', projects).project, null, '不乱猜');
  assert.ok(
    matchManagedProject('alph', projects).candidates.includes('alpha'),
    '差一点的名字只当候选，不当匹配',
  );
});

test('直通开关要活过「配置读回来」这一关', async () => {
  // 配置读出来**只认 DEFAULT_CONFIG 里真有的字段**（§24.7「废键不能靠状态文件长回来」）。
  // 开关不在那张表里的话，写进文件也会被读成 undefined——直通路一次都不会跑，
  // 而症状是「板面安静，什么都没投出去」（2026-11-01 上岗验收时真机抓到的）。
  const dir = tmpDir();
  try {
    const patrol = new PatrolStore(dir);
    const before = await patrol.getConfig();
    assert.equal(before.directDelivery, false, '默认关');

    await patrol.setConfig({ directDelivery: true });
    const after = await patrol.getConfig();
    assert.equal(after.directDelivery, true, '开关必须活过读回来这一关');
  } finally {
    cleanupDir(dir);
  }
});

test('真机路径：真实名单 + 真实项目集 → 管辖项目事件**要**被计划投递', async () => {
  // 这条测试用**真实模块**（真的 ManagedProjects、真的 RuntimeStore、真的
  // ThreadSubscriptions），不注入假的名单对象。
  //
  // 为什么必须这样：曾经这里的 `managed.list()` 返回的是**没有 matched 的原始条目**，
  // 而代码按 `entry.matched` 过滤——于是管辖名单算成空的，每一条项目事件都被判成
  // 「不在管辖范围」，**直通从来没有真的投出去过**。单测没抓到，是因为它注入的是一个
  // **带 matched 的假名单**：替身的形状和真实模块不一样。
  const dir = tmpDir();
  let store = null;
  try {
    const dataDir = join(dir, 'data');
    const managed = new ManagedProjects(dataDir);
    const subscriptions = new ThreadSubscriptions(dataDir);
    const patrol = new PatrolStore(dataDir);

    await managed.add('alpha', '大老板点名要盯这个');
    await subscriptions.add('alpha', 'mvs-alpha-owner', '大老板点名这条线有负责会话', { projectId: 1 });

    store = RuntimeStore.open(makeRuntimeDb(dir));
    const probe = await planRound({
      store,
      patrol,
      managed,
      subscriptions,
      agent: null,
    });

    const names = probe.candidates.kept.map((t) => t.projectName);
    assert.ok(
      names.includes('alpha'),
      `alpha 的事件应该在候选里（实际候选：${JSON.stringify(names)}）——名单解析错了的话这里就是空的`,
    );
    assert.equal(
      probe.plan.deliveries.length > 0,
      true,
      'alpha 的事件应该被计划投给负责会话（这是「不经大哥直接进负责会话」的前一步）',
    );
    assert.equal(probe.plan.deliveries[0].thread.ownerSessionId, 'mvs-alpha-owner');
    assert.equal(
      probe.plan.skipped.byReason.out_of_jurisdiction ?? 0,
      0,
      '管辖名单里的项目不该被判成「不在管辖范围」',
    );
  } finally {
    store?.close();
    cleanupDir(dir);
  }
});
