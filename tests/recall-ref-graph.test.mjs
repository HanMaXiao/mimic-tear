import test from 'node:test';
import assert from 'node:assert/strict';

import { buildFactRefGraph, planRecall } from '../miniapps/mimic-tear/miniapp/node/recall.mjs';

/**
 * 引用图：基线规格 §7 Gate 1.7 要的是「给定任一内容 ID，能沿引用图取回它的项目、会话、
 * 同项目的其它结论」。
 *
 * 2026-11-01 上岗验收时查出来的两个缺口：
 *  ① `recall` 入口把项目节点的 `ownerSessionId` 写死成 `null` —— 事实表内联的那一跳说
 *     「结论 → 项目 → 会话」能走通，召回却只到项目为止。两边都不报错。
 *  ② 「同项目的其它结论」压根不在图里 —— 三跳的注释写着「三跳够从一条结论走到它所在的线
 *     再走到那条线上别的结论」，但图里没有那一跳。
 */

const PROJECT = 'Mimic Tear';
const OWNER = 'mvs-owner-session';
const FINDING_A = 'patrol-a';
const FINDING_B = 'patrol-b';

test('结论 → 项目 → 会话：负责会话这一跳必须走得到', () => {
  const graph = buildFactRefGraph({
    findings: [{ id: FINDING_A, projectName: PROJECT, title: '结论 A' }],
    projects: [{ name: PROJECT, ownerSessionId: OWNER }],
    sessions: [{ id: OWNER, projectName: PROJECT, title: '负责会话' }],
  });

  const chain = planRecall(FINDING_A, graph);
  const ids = chain.hops.map((hop) => hop.id);
  assert.ok(ids.includes(PROJECT), `应该走到项目（实际：${ids.join(' → ')}）`);
  assert.ok(
    ids.includes(OWNER),
    `应该走到负责会话（实际：${ids.join(' → ')}）——ownerSessionId 写死成 null 时这一跳就断了`,
  );
  assert.equal(chain.truncated, false, '三跳走完不算被截断');
});

test('结论 → 项目 → 同项目的其它结论：这一跳以前根本不在图里', () => {
  const graph = buildFactRefGraph({
    findings: [
      { id: FINDING_A, projectName: PROJECT, title: '结论 A' },
      { id: FINDING_B, projectName: PROJECT, title: '结论 B' },
    ],
    projects: [{ name: PROJECT, ownerSessionId: OWNER, conclusionIds: [FINDING_A, FINDING_B] }],
    sessions: [{ id: OWNER, projectName: PROJECT, title: '负责会话' }],
  });

  const chain = planRecall(FINDING_A, graph);
  const ids = chain.hops.map((hop) => hop.id);
  assert.ok(
    ids.includes(FINDING_B),
    `应该走到同项目的另一条结论（实际：${ids.join(' → ')}）`,
  );
});

test('事实表的图不带「同项目其它结论」——引用图住在系统里、不进负载', () => {
  // `facts` 入口**不传** `conclusionIds`：全部结论 id 内联进候选视图会让它从 59,265
  // 涨到 80,638 字节（基线规格 §4 G-05 的实测）。召回那边按需建完整的图。
  const graph = buildFactRefGraph({
    findings: [
      { id: FINDING_A, projectName: PROJECT, title: '结论 A' },
      { id: FINDING_B, projectName: PROJECT, title: '结论 B' },
    ],
    projects: [{ name: PROJECT, ownerSessionId: OWNER }],
  });

  const chain = planRecall(FINDING_A, graph);
  const ids = chain.hops.map((hop) => hop.id);
  assert.ok(
    !ids.includes(FINDING_B),
    '事实表这一侧不该内联同项目的其它结论 id',
  );
  // 但差集只出现在召回这一侧：事实表内联的下一跳永远是召回能走到的子集。
  const full = planRecall(FINDING_A, buildFactRefGraph({
    findings: [{ id: FINDING_A, projectName: PROJECT }],
    projects: [{ name: PROJECT, ownerSessionId: OWNER, conclusionIds: [FINDING_A, FINDING_B] }],
    sessions: [{ id: OWNER, projectName: PROJECT }],
  }));
  assert.deepEqual(
    ids,
    full.hops.map((hop) => hop.id).filter((id) => ids.includes(id)),
    '事实表内联的下一跳必须是召回能走到的子集',
  );
});

test('项目节点没有负责会话时，那一跳不存在——但不该把它算成截断', () => {
  const graph = buildFactRefGraph({
    findings: [{ id: FINDING_A, projectName: PROJECT, title: '结论 A' }],
    projects: [{ name: PROJECT, ownerSessionId: null }],
  });
  const chain = planRecall(FINDING_A, graph);
  assert.deepEqual(chain.hops.map((hop) => hop.id), [FINDING_A, PROJECT]);
  assert.equal(chain.truncated, false);
});
