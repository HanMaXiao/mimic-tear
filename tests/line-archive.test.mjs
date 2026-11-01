import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { ManagedProjects } from '../miniapps/mimic-tear/miniapp/node/managed-projects.mjs';
import { PatrolStore } from '../miniapps/mimic-tear/miniapp/node/patrol-store.mjs';
import { ProjectService } from '../miniapps/mimic-tear/miniapp/node/project-service.mjs';
import { RuntimeStore } from '../miniapps/mimic-tear/miniapp/node/runtime-store.mjs';
import { makeRuntimeDb, tmpDir, cleanupDir } from './helpers/fixture.mjs';

/**
 * 板面服务 + 一个归它管的 alpha 项目。
 *
 * @returns {Promise<any>}
 */
async function makeService() {
  const dir = tmpDir();
  const store = RuntimeStore.open(makeRuntimeDb(dir));
  const dataDir = join(dir, 'data');
  const patrol = new PatrolStore(dataDir);
  const managed = new ManagedProjects(dataDir);
  await managed.add('alpha', '大老板交代过这个项目');

  const service = new ProjectService({
    store,
    readPlan: async () => null,
    skills: { skills: [], failures: [] },
    domains: [],
    persistence: {
      async listAcks() { return []; },
      async listDismissed() { return []; },
      async listDispatches() { return []; },
      async getBossSession() { return null; },
    },
    boss: { dispatch: async () => ({}), patrol: async () => ({}) },
    patrol,
    managed,
  });

  return { service, store, patrol, dir };
}

test('线卡的「最近动作」要把归档账里的结论算进去', async () => {
  const { service, store, patrol, dir } = await makeService();
  try {
    // 先报一条，然后归档（收件箱清空），再报一条。
    await patrol.add({
      projectName: 'alpha',
      severity: 'low',
      title: '归档前报的一条',
      body: '归档前报的一条结论',
    });
    await patrol.archive({ reason: '收件箱清空', by: 'user' });
    await patrol.add({
      projectName: 'alpha',
      severity: 'low',
      title: '刚报的一条',
      body: '刚报的一条结论',
    });

    const overview = await service.getOverview();
    const line = overview.lines.find((item) => item.projectName === 'alpha');
    assert.ok(line, 'alpha 在管辖名单里，就该有一条线');

    const titles = line.actions.map((action) => action.title);
    assert.ok(
      titles.includes('刚报的一条'),
      '当前账本里的结论要算「最近动作」',
    );
    assert.ok(
      titles.includes('归档前报的一条'),
      '归档过的结论也是大哥报过的事，不能凭空消失——否则线会显得比实际更闲',
    );
    assert.equal(line.actions[0].title, '刚报的一条', '最近的还是最近的那条');
  } finally {
    store.close();
    cleanupDir(dir);
  }
});
