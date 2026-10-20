import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';

import { readPlan, parseStatusLog, parsePlanYaml, decodeText } from '../miniapps/mimic-tear/miniapp/node/plan-store.mjs';
import { tmpDir, cleanupDir } from './helpers/fixture.mjs';

const STATUS_LOG = `Plan     DEHD V1.4 – 跨重启 PID 持久化 + LogRule 增强 (plan_d803bbdf)
Status   running
Cycle    1 (producing)
Owner    mvs_5dd16b1fd34e4d5db3777be3589be2c9
Updated  2026-06-20 16:34:35 (Asia/Shanghai, UTC+8)

⚠ 1 task(s) with verify=auto-off (role=verify-as-task):
  - final-integration-check (V1.4 final gate:全标 build + test + CHANGELOG + 收口报告)

Tasks:
  ✦ V1.4-A:LogRule 引擎 longest-match + record→class + 仓储 [producing]  verify=on
  ○ V1.4-B:跨重启 PID 持久化 + 30s 探活守护 [ready]  verify=on
  ✖ V1.4-C:自定义规则 UI + Service + 持久化 + 通知 [blocked]  verify=on
  ✔ V1.4-D:已完成的收尾任务 [done]  verify=on
`;

const PLAN_YAML = `version: 1
plan:
  name: 'DEHD V1.4'
  max_concurrency: 3
tasks:
  - id: logrule-data-layer
    title: 'V1.4-A1:LogRule 数据层(新 record→class + IRepository + LiteDB 仓储)'
    assigned_to: coder
    verified_by: verifier
    max_retries: 2
    timeout_ms: 1800000
    prompt: |
      你负责 LogRule 数据层改造。
      关键设计:
      1. sealed record → class
      - id: alpha
        title: 这是提示词里的冒牌字段
    depends_on: []
  - id: pid-persistence
    title: 'V1.4-B:跨重启 PID 持久化 + 30s 探活守护'
    assigned_to: worker
  - id: custom-rule-ui
    title: 'V1.4-C:自定义规则 UI + Service + 持久化 + 通知'
    assigned_to: coder
`;

function makePlansDir(root, { log = STATUS_LOG, yaml = PLAN_YAML } = {}) {
  const dir = join(root, '.mavis', 'plans');
  mkdirSync(dir, { recursive: true });
  if (log !== null) writeFileSync(join(dir, 'status1.log'), log, 'utf8');
  if (yaml !== null) writeFileSync(join(dir, 'v1.4-plan-v2.yaml'), yaml, 'utf8');
  return dir;
}

test('PlanStore', async (t) => {
  await t.test('解析状态日志的任务状态', () => {
    const tasks = parseStatusLog(STATUS_LOG);

    assert.equal(tasks.length, 4);
    assert.deepEqual(tasks.map((task) => task.state), ['producing', 'ready', 'blocked', 'done']);
    assert.equal(tasks[0].title, 'V1.4-A:LogRule 引擎 longest-match + record→class + 仓储');
  });

  await t.test('状态日志缺少 Tasks 段时返回空', () => {
    assert.deepEqual(parseStatusLog('Plan foo\nStatus running\n'), []);
    assert.deepEqual(parseStatusLog(''), []);
  });

  await t.test('解析 plan yaml 的 id / title / assigned_to，忽略提示词里的冒牌字段', () => {
    const definitions = parsePlanYaml(PLAN_YAML);

    assert.equal(definitions.length, 3, '提示词块内的伪字段不应产生第四个任务');
    assert.equal(definitions[0].id, 'logrule-data-layer');
    assert.equal(definitions[0].assignedTo, 'coder');
    assert.equal(definitions[0].title, 'V1.4-A1:LogRule 数据层(新 record→class + IRepository + LiteDB 仓储)');
    assert.equal(definitions[1].assignedTo, 'worker');
  });

  await t.test('读取项目计划快照：标题取自干净的 yaml，状态取自日志', async () => {
    const root = tmpDir();
    try {
      makePlansDir(root);
      const plan = await readPlan(root);

      assert.ok(plan, '应读到计划快照');
      assert.equal(plan.tasks.length, 4, '3 个 yaml 任务 + 1 个日志独有任务');
      assert.equal(plan.source, join('.mavis', 'plans', 'status1.log'));

      const producing = plan.tasks.find((task) => task.id === 'logrule-data-layer');
      assert.equal(producing.title, 'V1.4-A1:LogRule 数据层(新 record→class + IRepository + LiteDB 仓储)',
        '标题应来自 yaml，保持干净');
      assert.equal(producing.assignedTo, 'coder');
      assert.equal(producing.state, 'producing', '状态应来自日志的 V1.4-A 轨道');

      const ready = plan.tasks.find((task) => task.id === 'pid-persistence');
      assert.equal(ready.state, 'ready');
      assert.equal(ready.assignedTo, 'worker');

      const blocked = plan.tasks.find((task) => task.id === 'custom-rule-ui');
      assert.equal(blocked.state, 'blocked');

      const logOnly = plan.tasks.find((task) => task.id === null);
      assert.ok(logOnly, 'yaml 里没有的任务应保留');
      assert.equal(logOnly.title, 'V1.4-D:已完成的收尾任务');
      assert.equal(logOnly.state, 'done');
    } finally {
      cleanupDir(root);
    }
  });

  await t.test('轨道级状态覆盖轨道下所有任务', async () => {
    const root = tmpDir();
    try {
      const dir = makePlansDir(root, { log: null });
      writeFileSync(join(dir, 'status1.log'),
        'Tasks:\n  ✦ V1.4-A:某轨道 [producing]  verify=on\n', 'utf8');
      writeFileSync(join(dir, 'plan.yaml'), `tasks:
  - id: a1
    title: 'V1.4-A1:第一个'
    assigned_to: coder
  - id: a2
    title: 'V1.4-A2:第二个'
    assigned_to: coder
`, 'utf8');

      const plan = await readPlan(root);
      assert.equal(plan.tasks.length, 2);
      assert.ok(plan.tasks.every((task) => task.state === 'producing'),
        'V1.4-A 轨道下的两个任务都应是 producing');
    } finally {
      cleanupDir(root);
    }
  });

  await t.test('V1.4 收口任务不会被 V1.4-A 轨道误伤', async () => {
    const root = tmpDir();
    try {
      const dir = makePlansDir(root, { log: null });
      writeFileSync(join(dir, 'status1.log'), `Tasks:
  ✦ V1.4-A:某轨道 [producing]  verify=on
  ✖ V1.4 final gate:全栈 build [blocked]  verify=auto-off
`, 'utf8');
      writeFileSync(join(dir, 'plan.yaml'), `tasks:
  - id: a1
    title: 'V1.4-A1:第一个'
  - id: gate
    title: 'V1.4 final gate:收口'
`, 'utf8');

      const plan = await readPlan(root);
      const a1 = plan.tasks.find((task) => task.id === 'a1');
      const gate = plan.tasks.find((task) => task.id === 'gate');
      assert.equal(a1.state, 'producing');
      assert.equal(gate.state, 'blocked', '收口任务应匹配自己的日志条目');
    } finally {
      cleanupDir(root);
    }
  });

  await t.test('多个状态日志时取最新修改的那个', async () => {
    const root = tmpDir();
    try {
      const dir = makePlansDir(root, { log: null, yaml: null });
      const older = join(dir, 'status1.log');
      const newer = join(dir, 'status2.log');
      writeFileSync(older, 'Tasks:\n  ✦ V1.4-A:旧日志任务 [producing]  verify=on\n', 'utf8');
      writeFileSync(newer, 'Tasks:\n  ✖ V1.4-A:新日志任务 [blocked]  verify=on\n', 'utf8');
      writeFileSync(join(dir, 'plan.yaml'), "tasks:\n  - id: a1\n    title: 'V1.4-A1:某个任务'\n", 'utf8');
      utimesSync(older, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
      utimesSync(newer, new Date(1_800_000_000_000), new Date(1_800_000_000_000));

      const plan = await readPlan(root);
      assert.equal(plan.source, join('.mavis', 'plans', 'status2.log'));
      assert.equal(plan.tasks.length, 1);
      assert.equal(plan.tasks[0].id, 'a1');
      assert.equal(plan.tasks[0].state, 'blocked', '状态应来自最新的状态日志');
    } finally {
      cleanupDir(root);
    }
  });

  await t.test('Review Focus 2：目录不存在返回 null，不抛错', async () => {
    const root = tmpDir();
    try {
      assert.equal(await readPlan(root), null);
      assert.equal(await readPlan(join(root, 'never-created')), null);
    } finally {
      cleanupDir(root);
    }
  });

  await t.test('Review Focus 2：目录为空或文件损坏时返回 null，不抛错', async () => {
    const root = tmpDir();
    try {
      const dir = makePlansDir(root, { log: 'not a plan at all', yaml: '::: broken' });
      assert.equal(await readPlan(root), null);

      const other = tmpDir();
      try {
        mkdirSync(join(other, '.mavis', 'plans'), { recursive: true });
        assert.equal(await readPlan(other), null);
      } finally {
        cleanupDir(other);
      }
      void dir;
    } finally {
      cleanupDir(root);
    }
  });

  await t.test('Review Focus 2：项目路径含空格与中文时正常工作', async () => {
    const root = tmpDir();
    try {
      const project = join(root, '我的 项目 space');
      makePlansDir(project);
      const plan = await readPlan(project);
      assert.ok(plan);
      assert.equal(plan.tasks.length, 4);
    } finally {
      cleanupDir(root);
    }
  });

  await t.test('UTF-16LE 编码的日志与 yaml 能被正确解析', async () => {
    const root = tmpDir();
    try {
      const dir = join(root, '.mavis', 'plans');
      mkdirSync(dir, { recursive: true });
      // The Goal-mode plan writer emits UTF-16LE with BOM on Windows.
      writeFileSync(join(dir, 'status1.log'), Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from(STATUS_LOG, 'utf16le'),
      ]));
      writeFileSync(join(dir, 'plan.yaml'), Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from(PLAN_YAML, 'utf16le'),
      ]));

      const plan = await readPlan(root);
      assert.ok(plan, 'UTF-16LE 日志应被解析');
      assert.equal(plan.tasks.length, 4);
      assert.deepEqual(plan.tasks.map((t) => t.state), ['producing', 'ready', 'blocked', 'done']);
      assert.equal(plan.tasks[0].id, 'logrule-data-layer', 'UTF-16LE yaml 也应被解析');
      assert.equal(plan.tasks[0].assignedTo, 'coder');
      assert.ok(!plan.tasks[0].title.includes('\u0000'), '标题不应含 NUL 字符');
    } finally {
      cleanupDir(root);
    }
  });

  await t.test('无 BOM 的 UTF-16 也能被识别', () => {
    const noBom = Buffer.from('Tasks:\n  ✦ 无 BOM 任务 [producing]  verify=on\n', 'utf16le');
    const tasks = parseStatusLog(decodeText(noBom));
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].title, '无 BOM 任务');
  });

  await t.test('GBK 乱码的日志标题能被修复', async () => {
    const root = tmpDir();
    try {
      const dir = join(root, '.mavis', 'plans');
      mkdirSync(dir, { recursive: true });
      // A log whose CJK text was UTF-8 bytes misread as GBK, then stored as UTF-16LE.
      const gbk = new TextDecoder('gbk', { fatal: false });
      const mojibakeLog = 'Tasks:\n  \u2726 V1.4-B:跨重启 PID 持久化 [ready]  verify=on\n';
      assert.notEqual(mojibakeLog, 'clean', 'fixture 自身就是乱码');
      writeFileSync(join(dir, 'status1.log'), Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from(mojibakeLog, 'utf16le'),
      ]));
      writeFileSync(join(dir, 'plan.yaml'), `tasks:
  - id: b1
    title: 'V1.4-B:跨重启 PID 持久化'
`, 'utf8');

      const plan = await readPlan(root);
      assert.equal(plan.tasks.length, 1);
      assert.equal(plan.tasks[0].title, 'V1.4-B:跨重启 PID 持久化',
        'yaml 标题应保持干净，不受日志乱码影响');
      assert.equal(plan.tasks[0].state, 'ready', '状态仍应从乱码日志中正确解析');
    } finally {
      cleanupDir(root);
    }
  });
});
