import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ManagedProjects } from '../miniapps/mimic-tear/miniapp/node/managed-projects.mjs';

/**
 * The jurisdiction list.
 *
 * The boss does not decide which projects it manages — the user does, by naming them.
 * Anything not on the list is off limits, however broken or long-idle it looks.
 */
test('managed projects (jurisdiction)', async (t) => {
  // Each case gets its own directory: the store is stateful, and a shared one would let
  // one case's writes decide another case's expectations.
  const makeStore = () => {
    const dir = mkdtempSync(join(tmpdir(), 'mimic-managed-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return new ManagedProjects(dir);
  };

  await t.test('初始为空：没有任何项目是默认被管的', async () => {
    const store = makeStore();
    assert.deepEqual(await store.list(), []);
  });

  await t.test('加入后能被列出', async () => {
    const store = makeStore();
    await store.add('Dungeon-Chesser', '大老板 2026-10-21 指示：让大哥盯 Dungeon-Chesser');
    const list = await store.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'Dungeon-Chesser');
    assert.match(list[0].reason, /大老板/);
  });

  await t.test('理由必填 —— 没有理由的授权不成立', async () => {
    const store = makeStore();
    await assert.rejects(() => store.add('X', ''), /理由/);
    await assert.rejects(() => store.add('X', '   '), /理由/);
  });

  await t.test('移除后不再被管', async () => {
    const store = makeStore();
    await store.add('A', '大老板指示');
    await store.remove('A', '大老板说不用管了');
    assert.deepEqual(await store.list(), []);
  });

  await t.test('移除不存在的项目不算错（幂等）', async () => {
    const store = makeStore();
    await store.remove('never-added', '大老板说不用管了');
    assert.deepEqual(await store.list(), []);
  });

  await t.test('isManaged 只认名单里的项目', async () => {
    const store = makeStore();
    await store.add('Dungeon-Chesser', '大老板指示');
    assert.equal(await store.isManaged('Dungeon-Chesser'), true);
    assert.equal(await store.isManaged('Contra-Survivor'), false);
    assert.equal(await store.isManaged(''), false);
  });

  await t.test('同名重复加入是更新而不是多一条', async () => {
    const store = makeStore();
    await store.add('A', '第一次');
    await store.add('A', '第二次');
    const list = await store.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].reason, '第二次');
  });

  await t.test('坏文件不炸：读不出就当空名单', async () => {
    const store = makeStore();
    await store.add('A', '大老板指示');
    // Corrupt the file the way a half-written JSON document would corrupt it.
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(store.dataDir, 'managed-projects.json'), '{ this is not json', 'utf8');
    assert.deepEqual(await store.list(), []);
  });

  await t.test('授权要记下落在哪个项目上：名字对上了，指向也得留着', async () => {
    const store = makeStore();
    await store.add('alpha', '大老板指示', { projectId: 1, path: 'D:/projects/alpha' });
    const list = await store.list();
    assert.equal(list[0].projectId, 1);
    assert.equal(list[0].path, 'D:/projects/alpha');
  });

  await t.test('重新授权要能改掉指错的指向——改对名字就是这么改的', async () => {
    const store = makeStore();
    await store.add('alpha', '第一次', { projectId: 1, path: 'D:/projects/alpha' });
    await store.add('alpha', '第二次', { projectId: 7, path: 'D:/projects/alpha-2' });
    const list = await store.list();
    assert.equal(list.length, 1, '同一条授权，不是两条');
    assert.equal(list[0].reason, '第二次');
    assert.equal(list[0].projectId, 7, '重新授权要刷新指向');
    assert.equal(list[0].path, 'D:/projects/alpha-2');
  });
});
