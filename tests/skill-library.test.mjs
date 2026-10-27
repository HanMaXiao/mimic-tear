import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { SkillLibraryStore, normalizeEntry, scoreEntry } from '../miniapps/mimic-tear/miniapp/node/skill-library.mjs';
import { tmpDir, cleanupDir } from './helpers/fixture.mjs';

/** Write a real SKILL.md so validation has something on disk to look at. */
function makeSkill(root, dirName, name) {
  const dir = join(root, dirName);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'SKILL.md');
  writeFileSync(file, `---\nname: ${name}\ndescription: 测试用技能\n---\n\n# Body\n`, 'utf8');
  return file;
}

test('skill-library', async (t) => {
  await t.test('缺少 skillName 的条目在入口被拒绝', () => {
    assert.throws(() => normalizeEntry({ triggers: ['x'] }), /skillName/);
  });

  await t.test('空值不被伪装成 0：projectId 与 lastUsedAt 保持 null', () => {
    const entry = normalizeEntry({ skillName: 'demo' });
    assert.equal(entry.source.projectId, null);
    assert.equal(entry.lastUsedAt, null);
    assert.equal(entry.usageCount, 0);
  });

  await t.test('触发词归一化为小写去重', () => {
    const entry = normalizeEntry({ skillName: 'demo', triggers: ['Watchdog', 'watchdog', ' 心跳 ', ''] });
    assert.deepEqual(entry.triggers, ['watchdog', '心跳']);
  });

  await t.test('打分：更长更具体的触发词权重更高', () => {
    const entry = normalizeEntry({ skillName: 'demo', triggers: ['心跳', '看门狗心跳验收'] });
    const short = scoreEntry(entry, '心跳');
    const long = scoreEntry(entry, '看门狗心跳验收');
    assert.ok(long.score > short.score, `长触发词应得分更高：${long.score} vs ${short.score}`);
  });

  await t.test('注册后 id 在多次读取之间保持稳定', async () => {
    const root = tmpDir();
    try {
      const store = new SkillLibraryStore(root);
      await store.upsert({ skillName: 'demo', triggers: ['demo'] });
      const first = (await store.list())[0].id;
      const second = (await store.list())[0].id;
      assert.equal(first, second);
    } finally {
      cleanupDir(root);
    }
  });

  await t.test('同名技能再次上报是更新而不是新增，且不重置计数', async () => {
    const root = tmpDir();
    try {
      const store = new SkillLibraryStore(root);
      const created = await store.upsert({ skillName: 'demo', triggers: ['demo'] });
      assert.equal(created.created, true);

      const entry = await store.recordUse(created.entry.id, { success: true });
      assert.equal(entry.usageCount, 1);
      assert.equal(entry.successCount, 1);

      const updated = await store.upsert({ skillName: 'demo', triggers: ['demo', '演示'] });
      assert.equal(updated.created, false);
      assert.equal(updated.entry.id, created.entry.id);
      assert.equal(updated.entry.usageCount, 1, '重报不能清零派工计数');
      assert.equal(updated.entry.successCount, 1);
      assert.deepEqual(updated.entry.triggers, ['demo', '演示']);
      assert.equal((await store.list()).length, 1, '同一个技能只能占一行');
    } finally {
      cleanupDir(root);
    }
  });

  await t.test('退役是粘性的：重新上报不会把它放回派工池', async () => {
    const root = tmpDir();
    try {
      const store = new SkillLibraryStore(root);
      const { entry } = await store.upsert({ skillName: 'demo', triggers: ['demo'] });
      await store.retire(entry.id, '验证流程已废弃');

      const reported = await store.upsert({ skillName: 'demo', triggers: ['demo'] });
      assert.equal(reported.entry.status, 'retired');

      const revived = await store.upsert({ skillName: 'demo', status: 'active' });
      assert.equal(revived.entry.status, 'active', '显式声明 active 才能复活');
    } finally {
      cleanupDir(root);
    }
  });

  await t.test('匹配只给 active 条目，并按命中触发词排序', async () => {
    const root = tmpDir();
    try {
      const store = new SkillLibraryStore(root);
      await store.upsert({ skillName: 'watchdog-verify', triggers: ['看门狗', '心跳'] });
      await store.upsert({ skillName: 'perf-profile', triggers: ['性能', '火焰图'] });
      const stale = await store.upsert({ skillName: 'gone', triggers: ['看门狗'] });
      await store.update(stale.entry.id, { status: 'stale' });

      const matches = await store.match('看门狗心跳这次又不一样了');
      assert.equal(matches.length, 1);
      assert.equal(matches[0].skillName, 'watchdog-verify');
      assert.ok(matches[0].matchedTriggers.includes('看门狗'));
    } finally {
      cleanupDir(root);
    }
  });

  await t.test('空任务描述不返回任何匹配', async () => {
    const root = tmpDir();
    try {
      const store = new SkillLibraryStore(root);
      await store.upsert({ skillName: 'demo', triggers: ['demo'] });
      assert.deepEqual(await store.match('   '), []);
    } finally {
      cleanupDir(root);
    }
  });

  await t.test('校验发现技能文件丢失，条目转为失效', async () => {
    const root = tmpDir();
    try {
      const store = new SkillLibraryStore(root);
      const file = makeSkill(root, 'watchdog-verify', 'watchdog-verify');
      const { entry } = await store.upsert({ skillName: 'watchdog-verify', path: file, triggers: ['看门狗'] });

      const ok = await store.validate();
      assert.equal(ok.stale, 0);

      cleanupDir(join(root, 'watchdog-verify'));
      const report = await store.validate();
      assert.equal(report.stale, 1);
      assert.equal(report.problems[0].skillName, 'watchdog-verify');
      assert.match(report.problems[0].reason, /不存在/);

      const after = await store.get(entry.id);
      assert.equal(after.status, 'stale');
      assert.deepEqual(await store.match('看门狗'), [], '失效条目不再进派工池');
    } finally {
      cleanupDir(root);
    }
  });

  await t.test('校验发现技能被改名，条目转为失效并说明不一致', async () => {
    const root = tmpDir();
    try {
      const store = new SkillLibraryStore(root);
      const file = makeSkill(root, 'watchdog-verify', 'watchdog-verify');
      await store.upsert({ skillName: 'watchdog-verify', path: file, triggers: ['看门狗'] });

      writeFileSync(file, '---\nname: renamed-skill\ndescription: 改了名\n---\n', 'utf8');
      const report = await store.validate();
      assert.equal(report.stale, 1);
      assert.match(report.problems[0].reason, /renamed-skill/);
    } finally {
      cleanupDir(root);
    }
  });

  await t.test('技能文件回来后失效条目恢复为可派工', async () => {
    const root = tmpDir();
    try {
      const store = new SkillLibraryStore(root);
      const file = makeSkill(root, 'watchdog-verify', 'watchdog-verify');
      const { entry } = await store.upsert({ skillName: 'watchdog-verify', path: file, triggers: ['看门狗'] });

      cleanupDir(join(root, 'watchdog-verify'));
      await store.validate();
      assert.equal((await store.get(entry.id)).status, 'stale');

      makeSkill(root, 'watchdog-verify', 'watchdog-verify');
      await store.validate();
      assert.equal((await store.get(entry.id)).status, 'active');
    } finally {
      cleanupDir(root);
    }
  });

  await t.test('已退役的条目不会因为校验通过而被复活', async () => {
    const root = tmpDir();
    try {
      const store = new SkillLibraryStore(root);
      const file = makeSkill(root, 'watchdog-verify', 'watchdog-verify');
      const { entry } = await store.upsert({ skillName: 'watchdog-verify', path: file, triggers: ['看门狗'] });
      await store.retire(entry.id, '不再适用');

      await store.validate();
      assert.equal((await store.get(entry.id)).status, 'retired');
    } finally {
      cleanupDir(root);
    }
  });

  await t.test('统计区分可派工、失效与已退役', async () => {
    const root = tmpDir();
    try {
      const store = new SkillLibraryStore(root);
      const file = makeSkill(root, 'demo', 'demo');
      await store.upsert({ skillName: 'demo', path: file, domain: 'process', triggers: ['demo'] });
      const second = await store.upsert({ skillName: 'other', domain: 'perf', triggers: ['other'] });
      await store.retire(second.entry.id, '无用');

      const stats = await store.stats();
      assert.equal(stats.total, 2);
      assert.equal(stats.active, 1);
      assert.equal(stats.retired, 1);
      assert.deepEqual(stats.domains.sort(), ['perf', 'process']);
    } finally {
      cleanupDir(root);
    }
  });

  await t.test('服务端读的是同一份注册表，并按状态分组', async () => {
    const root = tmpDir();
    try {
      const { ProjectService } = await import('../miniapps/mimic-tear/miniapp/node/project-service.mjs');
      const store = new SkillLibraryStore(root);
      const file = makeSkill(root, 'demo', 'demo');
      await store.upsert({ skillName: 'demo', path: file, domain: 'process', triggers: ['demo'] });
      await store.upsert({ skillName: 'candidate-skill', status: 'candidate', triggers: ['候选'] });

      const service = new ProjectService({
        store: null,
        readPlan: null,
        skills: { skills: [], failures: [] },
        domains: [],
        persistence: null,
        boss: null,
        skillLibrary: store,
      });

      const payload = await service.getSkillLibrary();
      assert.equal(payload.entries.length, 2);
      assert.equal(payload.stats.active, 1);
      assert.equal(payload.stats.candidates, 1);
      assert.equal(payload.dispatchable.length, 1);
      assert.equal(payload.dispatchable[0].skillName, 'demo');
      assert.deepEqual(payload.domains, ['process']);
    } finally {
      cleanupDir(root);
    }
  });
});
