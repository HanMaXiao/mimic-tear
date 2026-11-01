import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { Persistence } from '../miniapps/mimic-tear/miniapp/node/persistence.mjs';
import { ProjectService } from '../miniapps/mimic-tear/miniapp/node/project-service.mjs';
import { RuntimeStore } from '../miniapps/mimic-tear/miniapp/node/runtime-store.mjs';
import { SkillLibraryStore } from '../miniapps/mimic-tear/miniapp/node/skill-library.mjs';
import { makeRuntimeDb, tmpDir, cleanupDir } from './helpers/fixture.mjs';

/**
 * 一个带技能登记表的服务。
 *
 * @param {{ bossThrows?: boolean }} [options]
 * @returns {{ service:any, store:any, skillLibrary:any, calls:any[], dir:string }}
 */
function makeService(options = {}) {
  const dir = tmpDir();
  const dbPath = makeRuntimeDb(dir);
  const store = RuntimeStore.open(dbPath);
  const skillLibrary = new SkillLibraryStore(join(dir, 'data'));
  const calls = [];
  const boss = {
    async dispatch(input) {
      calls.push(input);
      if (options.bossThrows) throw new Error('boss 不可用');
      return {
        bossSessionId: 'boss-session-1',
        status: 'finished',
        text: '已投递',
        error: null,
        delivered: true,
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
    skillLibrary,
  });

  return { service, store, skillLibrary, calls, dir };
}

test('skill-dispatch', async (t) => {
  await t.test('派工命中技能库：这次派工被记成一次使用', async () => {
    const { service, store, skillLibrary, dir } = makeService();
    try {
      const { entry } = await skillLibrary.upsert({
        skillName: 'watchdog-verify',
        triggers: ['看门狗', '心跳'],
      });
      assert.equal(entry.usageCount, 0, '刚登记的技能还没被用过');

      const result = await service.dispatch({
        projectId: 1,
        instruction: '去看门狗心跳是不是还在跳',
        idempotencyKey: 'k-skill-1',
      });
      assert.equal(result.delivered, true);

      const after = await skillLibrary.get(entry.id);
      assert.equal(after.usageCount, 1, '命中了就记一次使用');
      assert.equal(after.successCount, 1, '投递成功算成功');
      assert.ok(after.lastUsedAt > 0, '使用时刻要落下来');

      // 命中的技能也留在派工记录上：这块板面看得见「这次派工用到了什么」。
      const record = await service.getDispatch(result.dispatchId);
      assert.equal(record.skillMatch.skillName, 'watchdog-verify');
      store.close();
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('匹配是确定的：同样的派工内容永远命中同样的技能', async () => {
    const { service, store, skillLibrary, dir } = makeService();
    try {
      // 两个技能触发词一样、分数一样。谁被命中必须是**定死的**，不能靠「谁最近用过」。
      const first = await skillLibrary.upsert({ skillName: 'pack-one', triggers: ['心跳'] });
      const second = await skillLibrary.upsert({ skillName: 'pack-two', triggers: ['心跳'] });

      await service.dispatch({ projectId: 1, instruction: '查一下心跳', idempotencyKey: 'k-det-1' });
      await service.dispatch({ projectId: 1, instruction: '查一下心跳', idempotencyKey: 'k-det-2' });

      const one = await skillLibrary.get(first.entry.id);
      const two = await skillLibrary.get(second.entry.id);
      assert.equal(one.usageCount + two.usageCount, 2, '两次派工，两次使用');
      assert.equal(one.usageCount, 2, '同一个技能被命中两次');
      assert.equal(two.usageCount, 0, '另一个一次都没被命中');
      store.close();
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('没命中就不计数', async () => {
    const { service, store, skillLibrary, dir } = makeService();
    try {
      const { entry } = await skillLibrary.upsert({ skillName: 'unrelated', triggers: ['完全不相干'] });

      await service.dispatch({ projectId: 1, instruction: '把登录页做完备', idempotencyKey: 'k-none-1' });

      const after = await skillLibrary.get(entry.id);
      assert.equal(after.usageCount, 0, '没命中就不该动计数');
      assert.equal(after.lastUsedAt, null);
      store.close();
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('派工失败：算用过，但不算成功', async () => {
    const { service, store, skillLibrary, dir } = makeService({ bossThrows: true });
    try {
      const { entry } = await skillLibrary.upsert({ skillName: 'watchdog-verify', triggers: ['看门狗'] });

      const result = await service.dispatch({
        projectId: 1,
        instruction: '去看门狗',
        idempotencyKey: 'k-fail-1',
      });
      assert.equal(result.delivered, false);

      const after = await skillLibrary.get(entry.id);
      assert.equal(after.usageCount, 1, '派过就是用过');
      assert.equal(after.successCount, 0, '没投出去不算成功');
      store.close();
    } finally {
      cleanupDir(dir);
    }
  });

  await t.test('重复提交（同一个幂等键）不重复计数', async () => {
    const { service, store, skillLibrary, calls, dir } = makeService();
    try {
      const { entry } = await skillLibrary.upsert({ skillName: 'watchdog-verify', triggers: ['看门狗'] });
      const input = { projectId: 1, instruction: '去看门狗', idempotencyKey: 'k-idem-1' };

      await service.dispatch(input);
      await service.dispatch(input);

      const after = await skillLibrary.get(entry.id);
      assert.equal(calls.length, 1, '大哥只被叫了一次');
      assert.equal(after.usageCount, 1, '只投出去过一次，就只记一次');
      store.close();
    } finally {
      cleanupDir(dir);
    }
  });
});
