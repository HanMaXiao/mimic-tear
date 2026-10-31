import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RuntimeStore } from '../miniapps/mimic-tear/miniapp/node/runtime-store.mjs';
import {
  buildSessionLedger,
  isListedSession,
  lastAssistantReply,
  normalizeStatus,
  readSessionLedger,
} from '../miniapps/mimic-tear/miniapp/node/session-ledger.mjs';
import { ProjectService } from '../miniapps/mimic-tear/miniapp/node/project-service.mjs';
import { makeRuntimeDb, tmpDir, cleanupDir } from './helpers/fixture.mjs';

const NODE_DIR = fileURLToPath(new URL('../miniapps/mimic-tear/miniapp/node', import.meta.url));
const CLI = join(NODE_DIR, 'session-cli.mjs');

test('session-ledger: 口径', async (t) => {
  await t.test('运行时的 started 对外是 running', () => {
    assert.equal(normalizeStatus('started'), 'running');
    assert.equal(normalizeStatus('idle'), 'idle');
    assert.equal(normalizeStatus('error'), 'error');
    assert.equal(normalizeStatus('aborted'), 'aborted');
    assert.equal(normalizeStatus('interrupted'), 'aborted');
    assert.equal(normalizeStatus('没这回事'), 'idle');
  });

  await t.test('根对话、可见、非 cron、非 peek、非 Mini App 自己的会话才算数', () => {
    const base = { visibility: 'visible', parentSessionId: null, sessionKind: null, originCronId: null, purpose: null };
    assert.equal(isListedSession(base), true);
    assert.equal(isListedSession({ ...base, visibility: 'hidden' }), false, '隐藏会话不算');
    assert.equal(isListedSession({ ...base, parentSessionId: 'parent-1' }), false, '子会话不算');
    assert.equal(isListedSession({ ...base, sessionKind: 'cron' }), false, '定时任务不算');
    assert.equal(isListedSession({ ...base, sessionKind: 'peek' }), false, '偷看一眼不算');
    assert.equal(isListedSession({ ...base, originCronId: 'cron-1' }), false, '定时任务的产物不算');
    assert.equal(isListedSession({ ...base, purpose: 'miniapp:mimic-tear' }), false, 'Mini App 自己的会话不算');
    assert.equal(isListedSession(null), false);
  });

  await t.test('最后一条助手回复就是「最终回复」', () => {
    const messages = [
      { role: 'user', text: '开始' },
      { role: 'assistant', text: '第一版' },
      { role: 'user', text: '再来' },
      { role: 'assistant', text: '  最终结论  ' },
    ];
    assert.equal(lastAssistantReply(messages), '最终结论');
    assert.equal(lastAssistantReply([{ role: 'user', text: '只有用户' }]), null);
    assert.equal(lastAssistantReply([]), null);
  });
});

test('session-ledger: 拼装', async (t) => {
  await t.test('计数、排序与等回答标记', () => {
    const ledger = buildSessionLedger({
      sessions: [
        { id: 's1', title: '甲', agentName: 'mavis', status: 'started', updatedAt: 100, visibility: 'visible', parentSessionId: null },
        { id: 's2', title: '乙', agentName: 'mavis', status: 'idle', updatedAt: 200, visibility: 'visible', parentSessionId: null },
        { id: 's3', title: '丙', agentName: 'worker', status: 'error', updatedAt: 300, visibility: 'visible', parentSessionId: null },
        { id: 's4', title: '子会话', status: 'idle', updatedAt: 400, visibility: 'visible', parentSessionId: 's1' },
      ],
      questionnaires: [{ id: 'ask-1', sessionId: 's2' }],
      now: 999,
    });

    assert.equal(ledger.sessions.length, 3, '子会话不在用户对话列表里');
    assert.equal(ledger.sessions[0].id, 's3', '按更新时间倒序');
    assert.deepEqual(ledger.counts, { total: 3, running: 1, idle: 1, error: 1, waiting: 1 });
    assert.deepEqual(ledger.waiting, ['s2']);
    assert.equal(ledger.sessions.find((row) => row.id === 's2').needsAnswer, true);
    assert.equal(ledger.sessions.find((row) => row.id === 's2').waitingRequestIds[0], 'ask-1');
    assert.equal(ledger.generatedAt, 999);
  });

  await t.test('项目名挂得上，会话归属就查得到', () => {
    const ledger = buildSessionLedger({
      sessions: [{ id: 's1', title: '甲', status: 'idle', updatedAt: 1, visibility: 'visible', parentSessionId: null, projectId: 7 }],
      projectNames: new Map([[7, 'Mimic Tear']]),
    });
    assert.equal(ledger.sessions[0].projectName, 'Mimic Tear');
  });
});

test('session-ledger: 读真实的运行时库', async (t) => {
  const dir = tmpDir();
  const dbPath = makeRuntimeDb(dir);
  t.after(() => cleanupDir(dir));

  await t.test('账本里的会话就是用户的根对话', () => {
    const store = RuntimeStore.open(dbPath);
    const ledger = readSessionLedger(store);

    // 三条：alpha 主会话、beta 主会话，以及**隐藏项目里**的那条可见根对话。
    // 项目隐不隐藏不是「会话在不在用户对话列表里」的条件——宿主按会话自身的可见性过滤，
    // 不按项目；这里必须跟它一致，否则板面和 CLI 会看到不同的会话集合。
    assert.deepEqual(ledger.sessions.map((row) => row.id), ['sess-hidden', 'sess-beta-lead', 'sess-alpha-lead']);
    assert.equal(ledger.counts.total, 3);
    assert.equal(ledger.counts.running, 1, 'alpha 主会话是 started');
    assert.equal(ledger.counts.waiting, 1, 'ask-1 还挂着');
    assert.deepEqual(ledger.waiting, ['sess-alpha-lead']);
    assert.equal(ledger.sessions.find((row) => row.id === 'sess-alpha-lead').status, 'running');
    store.close();
  });

  await t.test('最后回复读得出来', () => {
    const store = RuntimeStore.open(dbPath);
    const ledger = readSessionLedger(store, { includeReplies: true });
    assert.equal(ledger.sessions.find((row) => row.id === 'sess-alpha-lead').lastReply, '大哥的回复');
    assert.equal(ledger.sessions.find((row) => row.id === 'sess-beta-lead').lastReply, null, '没有回复就是 null');
    store.close();
  });

  await t.test('板面标的「等回答」和账本的 waiting 是同一批', () => {
    const store = RuntimeStore.open(dbPath);
    const service = new ProjectService({
      store,
      readPlan: null,
      skills: { skills: [], failures: [] },
      domains: [],
      persistence: null,
      boss: null,
      skillLibrary: null,
    });

    const ledger = readSessionLedger(store);
    const asks = service.getPendingAsks().asks;
    const askedSessions = new Set(asks.map((ask) => ask.sessionId));
    const listedSessions = new Set(ledger.sessions.map((row) => row.id));

    // 板面只标「清单里有的会话」，账本只列「清单里的会话」——两边取交集必须等于账本的 waiting。
    const boardMarked = [...askedSessions].filter((id) => listedSessions.has(id)).sort();
    assert.deepEqual(boardMarked, [...ledger.waiting].sort(), '板面与 CLI 必须标同一批会话');
    assert.equal(asks.length, 1, '只有 ask-1 是待答的');
    store.close();
  });
});

test('session-cli: 大哥在派工前跑的那条命令', async (t) => {
  const dir = tmpDir();
  const dbPath = makeRuntimeDb(dir);
  t.after(() => cleanupDir(dir));

  const run = (...extra) => spawnSync(process.execPath, [CLI, ...extra, '--db', dbPath], { encoding: 'utf8' });

  await t.test('list 给出会话表和计数', () => {
    const result = run('list');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /会话实况/);
    assert.match(result.stdout, /3 个会话/);
    assert.match(result.stdout, /1 个在跑/);
    assert.match(result.stdout, /1 个在等回答/);
    assert.match(result.stdout, /Alpha 主会话/);
  });

  await t.test('waiting 只列在等回答的会话', () => {
    const result = run('waiting');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Alpha 主会话/);
    assert.ok(!result.stdout.includes('Beta 主会话'), '空闲的会话不该出现在 waiting 里');
  });

  await t.test('show 给出最后一段回复', () => {
    const result = run('show', 'sess-alpha-lead');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /最后回复/);
    assert.match(result.stdout, /大哥的回复/);
    assert.match(result.stdout, /等回答：ask-1/);
  });

  await t.test('show 一个不存在的会话要说清楚，而不是空输出', () => {
    const result = run('show', 'mvs_nope');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /账本里没有这个会话/);
  });

  await t.test('--json 给出完整结构', () => {
    const result = run('list', '--json');
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.counts.total, 3);
    assert.equal(payload.sessions.length, 3);
  });

  await t.test('--status running 只留跑着的', () => {
    const result = run('list', '--status', 'running');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Alpha 主会话/);
    assert.ok(!result.stdout.includes('Beta 主会话'), '空闲的不该留下');
  });
});
