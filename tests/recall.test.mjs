import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applySpill,
  buildFactRefGraph,
  buildRefGraph,
  inlineText,
  planRecall,
  SPILL_LIMIT,
} from '../miniapps/mimic-tear/miniapp/node/recall.mjs';
import { makeRuntimeDb, tmpDir, cleanupDir } from './helpers/fixture.mjs';

const CLI_PATH = fileURLToPath(new URL('../miniapps/mimic-tear/miniapp/node/patrol-cli.mjs', import.meta.url));

function runCli(dbPath, dataDir, args) {
  const stdout = execFileSync(
    process.execPath,
    [CLI_PATH, ...args, '--db', dbPath, '--data-dir', dataDir],
    { encoding: 'utf8' },
  );
  return JSON.parse(stdout);
}

// ---------------------------------------------------------------------------
// Inline & Spill
// ---------------------------------------------------------------------------

test('Inline：短文本原样内联，长文本换成摘要', () => {
  const short = '短短一句话';
  assert.deepEqual(inlineText(short), { summary: short, length: short.length, spilled: false });

  const long = '啊'.repeat(500);
  const inlined = inlineText(long);
  assert.equal(inlined.spilled, true);
  assert.equal(inlined.length, 500, '原文长度必须记下来');
  assert.ok(inlined.summary.length < long.length, '摘要必须比原文短');
  assert.match(inlined.summary, /按 ID 取全文/, '摘要要告诉模型去哪取全文');
});

test('Spill：整个负载里的长字符串都被换成摘要，并记下位置', () => {
  const payload = { a: '啊'.repeat(400), nested: { b: ['短', '哇'.repeat(400)] } };
  const { value, spills } = applySpill(payload, { limit: 100 });

  assert.ok(value.a.length < 400, '长的要换摘要');
  assert.equal(value.nested.b[0], '短', '短的不能被动');
  assert.ok(value.nested.b[1].length < 400);
  assert.equal(spills.length, 2);
  assert.ok(spills.some((s) => s.path === 'a'));
  assert.ok(spills.some((s) => s.path === 'nested.b[1]'));
});

test('Spill：例外清单里的字段不许被截断（大老板的原话、判定口径、路径）', () => {
  const reason = '大老板 2026-11-01 原话：'.concat('让'.repeat(400));
  const payload = {
    managed: [{ name: 'x', reason }],
    scope: 'candidates',
    paths: { db: 'x'.repeat(400) },
    other: 'y'.repeat(400),
  };
  const { value, spills } = applySpill(payload, {
    exclude: ['managed[].reason', 'scope', 'paths'],
  });

  assert.equal(value.managed[0].reason, reason, '授权理由必须原样保留');
  assert.equal(value.scope, 'candidates');
  assert.equal(value.paths.db.length, 400);
  assert.ok(value.other.length < 400, '不在例外清单里的照常截断');
  assert.equal(spills.length, 1);
  assert.equal(spills[0].path, 'other');
});

// ---------------------------------------------------------------------------
// 链式召回
// ---------------------------------------------------------------------------

test('引用图：节点带下一跳的 ID', () => {
  const graph = buildFactRefGraph({
    findings: [{ id: 'c1', projectName: 'alpha', title: '一条结论' }],
    projects: [{ name: 'alpha', ownerSessionId: 'sess-1' }],
    sessions: [{ id: 'sess-1', projectName: 'alpha', title: '主会话' }],
  });

  assert.equal(graph.get('c1').kind, 'conclusion');
  assert.deepEqual(graph.get('c1').refs, ['alpha']);
  assert.deepEqual(graph.get('alpha').refs, ['sess-1']);
  assert.equal(graph.get('sess-1').kind, 'session');
});

test('链式召回：从一个 ID 出发，逐跳展开', () => {
  const graph = buildFactRefGraph({
    findings: [{ id: 'c1', projectName: 'alpha', title: '一条结论' }],
    projects: [{ name: 'alpha', ownerSessionId: 'sess-1' }],
    sessions: [{ id: 'sess-1', projectName: 'alpha', title: '主会话' }],
  });

  const chain = planRecall('c1', graph);
  const ids = chain.hops.map((hop) => hop.id);
  assert.deepEqual(ids, ['c1', 'alpha', 'sess-1'], '要按跳数顺序展开');
  assert.equal(chain.hops[0].depth, 0);
  assert.equal(chain.hops[1].depth, 1);
  assert.equal(chain.truncated, false);
});

test('链式召回：跳数有上限，不能把整个仓库读一遍', () => {
  const entries = [];
  for (let i = 0; i < 10; i += 1) entries.push({ id: `n${i}`, kind: 'x', refs: [`n${i + 1}`] });
  const chain = planRecall('n0', buildRefGraph(entries), { maxHops: 3 });
  assert.equal(chain.hops.length, 3);
  assert.equal(chain.truncated, true, '被截断了要说出来');
});

test('链式召回：找不到的节点要说出来，不能假装有', () => {
  const chain = planRecall('不存在', buildRefGraph([]));
  assert.deepEqual(chain.hops, []);
  assert.deepEqual(chain.missing, ['不存在']);
});

// ---------------------------------------------------------------------------
// CLI：续读入口
// ---------------------------------------------------------------------------

test('CLI recall：按 ID 取回完整内容，Spill 掉的原文一字不差', () => {
  const dir = tmpDir();
  try {
    const dbPath = makeRuntimeDb(dir);
    const dataDir = join(dir, 'data');
    const long = '哇'.repeat(400);

    // 直接写收件箱账本：标题在存储层就被截到 120 字了（那里已经有一次 Spill），
    // **真正长的是备注**——所以要验的是备注。
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'patrol.json'), JSON.stringify([{
      id: 'conclusion-1',
      projectId: 1,
      projectName: 'alpha',
      severity: 'high',
      title: '短标题',
      note: long,
      body: long,
      createdAt: 1_700_000_000_000,
      acknowledged: false,
      acknowledgedBy: null,
    }]), 'utf8');

    const after = runCli(dbPath, dataDir, ['facts']);
    assert.equal(after.alreadyReported.length, 1);
    const spilled = after.spills.find((s) => s.path.includes('note'));
    assert.ok(spilled, '长备注应该被 Spill 出去');
    assert.equal(spilled.length, long.length);

    const recalled = runCli(dbPath, dataDir, ['recall', 'conclusion-1']);
    assert.equal(recalled.found, true, 'Spill 出去的东西必须能按 ID 取回');
    assert.equal(recalled.record.value.note, long, '取回来的原文要和原文逐字一致');
    assert.equal(recalled.record.value.body, long);
  } finally {
    cleanupDir(dir);
  }
});

test('CLI recall：链式召回能从结论走到它所在的线', () => {
  const dir = tmpDir();
  try {
    const dbPath = makeRuntimeDb(dir);
    const dataDir = join(dir, 'data');
    // alpha 必须在管辖名单里 —— 管辖闸管的是**能不能看/动**，不在名单里的线不进引用图。
    runCli(dbPath, dataDir, ['manage', 'add', 'alpha', '大老板让大哥盯 alpha']);
    const result = runCli(dbPath, dataDir, ['recall', 'sess-alpha-w2']);

    assert.equal(result.found, true);
    const kinds = result.chain.hops.map((hop) => hop.kind);
    assert.ok(kinds.includes('session'));
    assert.ok(kinds.includes('project'), '要能走到它所在的线');
  } finally {
    cleanupDir(dir);
  }
});

test('CLI facts：引用图不在负载里 —— 它住在系统里，按需取', () => {
  const dir = tmpDir();
  try {
    const dbPath = makeRuntimeDb(dir);
    const dataDir = join(dir, 'data');
    const facts = runCli(dbPath, dataDir, ['facts']);

    assert.equal(facts.refs, undefined, '整张图塞进负载 = 把按需召回变成一次性全读');
    assert.equal(typeof facts.recallable, 'number');
    assert.ok(facts.recallable > 0);
  } finally {
    cleanupDir(dir);
  }
});

test('Spill 上限是硬边界：负载里最长的字符串不超过上限（例外清单除外）', () => {
  const dir = tmpDir();
  try {
    const dbPath = makeRuntimeDb(dir);
    const dataDir = join(dir, 'data');
    const facts = runCli(dbPath, dataDir, ['facts']);

    const walk = (node, path) => {
      if (typeof node === 'string') {
        if (path.includes('managed')) return;
        assert.ok(node.length <= SPILL_LIMIT + 40, `${path} 有 ${node.length} 字，超了上限`);
        return;
      }
      if (Array.isArray(node)) { node.forEach((item, i) => walk(item, `${path}[${i}]`)); return; }
      if (node && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) walk(value, path ? `${path}.${key}` : key);
      }
    };
    walk(facts, '');
  } finally {
    cleanupDir(dir);
  }
});
