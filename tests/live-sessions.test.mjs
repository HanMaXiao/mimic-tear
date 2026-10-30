import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applyTurnEvent,
  createSessionWatch,
  isAskEvent,
  mergePendingAsks,
  normalizeSession,
  normalizeSessionDetail,
} from '../miniapps/mimic-tear/miniapp/client/assets/runtime/session-watch.js';
import {
  describeSpeechError,
  speechErrorCode,
  toPcm16k,
} from '../miniapps/mimic-tear/miniapp/client/assets/runtime/speech-capture.js';

const CLIENT_DIR = fileURLToPath(new URL('../miniapps/mimic-tear/miniapp/client', import.meta.url));
const SESSIONS_VIEW = join(CLIENT_DIR, 'assets', 'views', 'sessions.js');

/**
 * Load the session view's pure functions without running the browser side of it.
 *
 * The view is an ES module that imports the shared helpers, and the shared helper
 * `format.js` re-exports from `app.js` — whose top-level side effects would blow up
 * outside a browser. So the module body is lifted out and handed the few names it
 * needs, which keeps the assertions running against the real rendering code.
 *
 * @returns {Promise<{sessionsHtml:Function, detailHtml:Function, relativeTime:Function, renderSessions:Function}>}
 */
async function loadSessionsView() {
  const source = await readFile(SESSIONS_VIEW, 'utf8');
  const body = source
    .split('\n')
    .filter((line) => !line.startsWith('import '))
    .join('\n')
    .replace(/^export /gm, '');

  const escapeHtml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const elements = new Map();
  const el = (id) => {
    if (!elements.has(id)) elements.set(id, { id, textContent: '', innerHTML: '', dataset: {} });
    return elements.get(id);
  };
  const state = { sessions: null };

  const factory = new Function('el', 'escapeHtml', 'state', `${body}\nreturn { sessionsHtml, detailHtml, relativeTime, renderSessions };`);
  const view = factory(el, escapeHtml, state);
  view.elements = elements;
  view.state = state;
  return view;
}

/**
 * A stand-in for the Host's agent bridge.
 *
 * @param {{sessions?:Array, detail?:any, failWith?:any}} options
 */
function makeAgent(options = {}) {
  const observers = [];
  const cancelled = [];
  const calls = { sessions: 0, session: [], observe: [] };

  return {
    calls,
    observers,
    cancelled,
    async sessions() {
      calls.sessions += 1;
      if (options.failWith) throw options.failWith;
      return { sessions: options.sessions ?? [] };
    },
    async session(sessionId) {
      calls.session.push(sessionId);
      return options.detail ?? null;
    },
    observe(params, handlers) {
      calls.observe.push(params);
      const record = { params, handlers };
      observers.push(record);
      // A subscription stays open until the Host ends it; a pending promise is that.
      return new Promise(() => {});
    },
    async cancel(requestId) {
      cancelled.push(requestId);
    },
  };
}

test('session-watch: 会话记录统一收', async (t) => {
  await t.test('合法记录被收成看板用的形状', () => {
    const row = normalizeSession({
      sessionId: 's1',
      title: '仿身泪滴 · 值班',
      status: 'running',
      updatedAtMs: 1700000000000,
    });
    assert.deepEqual(row, {
      sessionId: 's1',
      title: '仿身泪滴 · 值班',
      status: 'running',
      updatedAtMs: 1700000000000,
    });
  });

  await t.test('没标题的会话有默认说法', () => {
    const row = normalizeSession({ sessionId: 's1', status: 'idle', updatedAtMs: 1 });
    assert.equal(row.title, '未命名对话');
  });

  await t.test('状态不在名单里就拒绝，而不是猜一个', () => {
    assert.throws(
      () => normalizeSession({ sessionId: 's1', status: 'paused', updatedAtMs: 1 }),
      /invalid_request/,
    );
  });

  await t.test('缺 id 或时间戳不合法都拒绝', () => {
    assert.throws(() => normalizeSession({ status: 'idle', updatedAtMs: 1 }), /invalid_request/);
    assert.throws(() => normalizeSession({ sessionId: 's1', status: 'idle', updatedAtMs: 1.5 }), /invalid_request/);
  });

  await t.test('详情里带出最后一条回复正文', () => {
    const detail = normalizeSessionDetail({
      sessionId: 's1',
      title: 't',
      status: 'idle',
      updatedAtMs: 1,
      lastAssistantText: '已经收尾，结论如下。',
      error: { message: '半路断了' },
    });
    assert.equal(detail.lastAssistantText, '已经收尾，结论如下。');
    assert.equal(detail.error, '半路断了');
  });

  await t.test('没有正文时是 null，不是空串', () => {
    const detail = normalizeSessionDetail({ sessionId: 's1', status: 'idle', updatedAtMs: 1 });
    assert.equal(detail.lastAssistantText, null);
    assert.equal(detail.error, null);
  });
});

test('session-watch: turn 事件折进会话表', async (t) => {
  await t.test('turn 开始 → 进行中', () => {
    const rows = new Map();
    const next = applyTurnEvent(rows, { type: 'turn.started', sessionId: 's1', title: '新任务' }, 1000);
    assert.equal(next.get('s1').status, 'running');
    assert.equal(next.get('s1').title, '新任务');
  });

  await t.test('turn 正常结束 → 空闲', () => {
    const rows = new Map([['s1', { sessionId: 's1', title: 't', status: 'running', updatedAtMs: 1 }]]);
    const next = applyTurnEvent(rows, { type: 'turn.finished', sessionId: 's1', status: 'finished' }, 2000);
    assert.equal(next.get('s1').status, 'idle');
    assert.equal(next.get('s1').running, false);
  });

  await t.test('turn 出错 → 出错状态，不装作空闲', () => {
    const rows = new Map([['s1', { sessionId: 's1', title: 't', status: 'running', updatedAtMs: 1 }]]);
    const next = applyTurnEvent(rows, { type: 'turn.finished', sessionId: 's1', status: 'error' }, 2000);
    assert.equal(next.get('s1').status, 'error');
  });

  await t.test('不认识的事件原样放过', () => {
    const rows = new Map([['s1', { sessionId: 's1', title: 't', status: 'idle', updatedAtMs: 1 }]]);
    const next = applyTurnEvent(rows, { type: 'tool.started', sessionId: 's1', name: 'bash' }, 2000);
    assert.equal(next.get('s1').status, 'idle');
  });

  await t.test('不改传进来的那张表', () => {
    const rows = new Map([['s1', { sessionId: 's1', title: 't', status: 'idle', updatedAtMs: 1 }]]);
    applyTurnEvent(rows, { type: 'turn.started', sessionId: 's1' }, 2000);
    assert.equal(rows.get('s1').status, 'idle', '原表不能被事件改写');
  });

  await t.test('只有 ask_user 才算在等回答', () => {
    assert.equal(isAskEvent({ name: 'ask_user' }), true);
    assert.equal(isAskEvent({ name: 'bash' }), false);
    assert.equal(isAskEvent(null), false);
  });
});

test('session-watch: 观察宿主', async (t) => {
  await t.test('清单读回来就绪', async () => {
    const agent = makeAgent({
      sessions: [{ sessionId: 's1', title: '甲', status: 'idle', updatedAtMs: 10 }],
    });
    const snapshots = [];
    const watch = createSessionWatch({ agent, onChange: (s) => snapshots.push(s) });
    await watch.start();

    const last = snapshots[snapshots.length - 1];
    assert.equal(last.availability, 'ready');
    assert.equal(last.sessions.length, 1);
    assert.equal(last.sessions[0].title, '甲');
    watch.dispose();
  });

  await t.test('turn 事件把会话点亮成进行中', async () => {
    const agent = makeAgent({
      sessions: [{ sessionId: 's1', title: '甲', status: 'idle', updatedAtMs: 10 }],
    });
    const snapshots = [];
    const watch = createSessionWatch({ agent, onChange: (s) => snapshots.push(s) });
    await watch.start();

    const global = agent.observers.find((o) => o.params.all === true);
    assert.ok(global, '必须订阅全局观察');
    global.handlers.onEvent({ type: 'turn.started', sessionId: 's1', turnId: 't1', title: '甲在跑' });

    const last = snapshots[snapshots.length - 1];
    const row = last.sessions.find((s) => s.sessionId === 's1');
    assert.equal(row.status, 'running');
    assert.equal(row.running, true);
    watch.dispose();
  });

  await t.test('正在跑的会话会开一个单会话观察，等回答靠它', async () => {
    const agent = makeAgent({
      sessions: [{ sessionId: 's1', title: '甲', status: 'running', updatedAtMs: 10 }],
    });
    const snapshots = [];
    const watch = createSessionWatch({ agent, onChange: (s) => snapshots.push(s) });
    await watch.start();

    const single = agent.observers.find((o) => o.params.sessionId === 's1');
    assert.ok(single, '运行中的会话要有单会话观察');

    single.handlers.onEvent({ type: 'tool.started', sessionId: 's1', turnId: 't1', name: 'ask_user' });
    await new Promise((resolve) => setTimeout(resolve, 200));

    const last = snapshots[snapshots.length - 1];
    const row = last.sessions.find((s) => s.sessionId === 's1');
    assert.equal(row.needsAnswer, true, 'ask_user 之后要标成在等回答');
    watch.dispose();
  });

  await t.test('选中会话会读它的最终回复', async () => {
    const agent = makeAgent({
      sessions: [{ sessionId: 's1', title: '甲', status: 'idle', updatedAtMs: 10 }],
      detail: {
        sessionId: 's1',
        title: '甲',
        status: 'idle',
        updatedAtMs: 20,
        lastAssistantText: '收工了，结论是……',
      },
    });
    const snapshots = [];
    const watch = createSessionWatch({ agent, onChange: (s) => snapshots.push(s) });
    await watch.start();
    watch.select('s1');
    await new Promise((resolve) => setTimeout(resolve, 10));

    const last = snapshots[snapshots.length - 1];
    assert.equal(last.detail.lastAssistantText, '收工了，结论是……');
    assert.deepEqual(agent.calls.session, ['s1']);
    watch.dispose();
  });

  await t.test('宿主不给读权限时说未授权，不装作没有会话', async () => {
    const agent = makeAgent({ failWith: Object.assign(new Error('not_permitted'), { code: 'not_permitted' }) });
    const snapshots = [];
    const watch = createSessionWatch({ agent, onChange: (s) => snapshots.push(s) });
    await watch.start();

    const last = snapshots[snapshots.length - 1];
    assert.equal(last.availability, 'not_permitted');
    assert.equal(last.sessions.length, 0);
    watch.dispose();
  });

  await t.test('没有桥接就报不支持', async () => {
    const snapshots = [];
    const watch = createSessionWatch({ agent: {}, onChange: (s) => snapshots.push(s) });
    await watch.start();
    assert.equal(snapshots[snapshots.length - 1].availability, 'unavailable');
    watch.dispose();
  });
});

test('sessions 视图: 画得对', async (t) => {
  const view = await loadSessionsView();

  await t.test('等回答的会话排在最前面', () => {
    const html = view.sessionsHtml({
      availability: 'ready',
      selectedSessionId: null,
      sessions: [
        { sessionId: 's1', title: '普通的', status: 'idle', updatedAtMs: 200, needsAnswer: false },
        { sessionId: 's2', title: '卡住的', status: 'running', updatedAtMs: 100, needsAnswer: true },
      ],
    });
    assert.ok(html.indexOf('卡住的') < html.indexOf('普通的'), '等回答的必须排前面');
    assert.match(html, /等回答/);
  });

  await t.test('标题里的标签被转义', () => {
    const html = view.sessionsHtml({
      availability: 'ready',
      selectedSessionId: null,
      sessions: [
        { sessionId: 's1', title: '<img src=x onerror=alert(1)>', status: 'idle', updatedAtMs: 1, needsAnswer: false },
      ],
    });
    assert.ok(!html.includes('<img'), '不能把标签原样写进页面');
    assert.match(html, /&lt;img/);
  });

  await t.test('未授权时说明白怎么开', () => {
    const html = view.sessionsHtml({ availability: 'not_permitted', sessions: [] });
    assert.match(html, /session\.read/);
  });

  await t.test('最新结果显示回复正文', () => {
    const html = view.detailHtml({
      detail: {
        sessionId: 's1',
        title: '甲',
        status: 'idle',
        updatedAtMs: 1,
        lastAssistantText: '结论在这里',
        error: null,
      },
    });
    assert.match(html, /结论在这里/);
  });

  await t.test('没选中会话时不编内容', () => {
    const html = view.detailHtml({ detail: null, detailLoading: false, error: null });
    assert.match(html, /点一个会话/);
  });

  await t.test('连接状态说清楚有几个在跑、几个在等回答', () => {
    view.state.sessions = {
      availability: 'ready',
      sessions: [
        { sessionId: 's1', status: 'running', running: true, needsAnswer: false },
        { sessionId: 's2', status: 'idle', running: false, needsAnswer: true },
      ],
    };
    view.renderSessions();
    const connection = view.elements.get('session-connection');
    assert.match(connection.textContent, /2 个会话/);
    assert.match(connection.textContent, /1 个在跑/);
    assert.match(connection.textContent, /1 个在等回答/);
  });
});

test('speech-capture: 录音与转写', async (t) => {
  await t.test('48 kHz 降到 16 kHz，样本数按比例', () => {
    const chunks = [new Float32Array(480)];
    const pcm = toPcm16k(chunks, 480, 48000);
    assert.equal(pcm.length, 160);
  });

  await t.test('16 kHz 原样通过', () => {
    const pcm = toPcm16k([new Float32Array(320)], 320, 16000);
    assert.equal(pcm.length, 320);
  });

  await t.test('满刻度映射到 16 位边界', () => {
    const pcm = toPcm16k([new Float32Array([1, -1])], 2, 16000);
    assert.equal(pcm[0], 32767);
    assert.equal(pcm[1], -32768);
  });

  await t.test('超出范围的值被夹住', () => {
    const pcm = toPcm16k([new Float32Array([2, -2])], 2, 16000);
    assert.equal(pcm[0], 32767);
    assert.equal(pcm[1], -32768);
  });

  await t.test('权限错误翻译成 not_permitted', () => {
    assert.equal(speechErrorCode({ name: 'NotAllowedError' }, 'capture'), 'not_permitted');
    assert.equal(speechErrorCode({ code: 'busy' }, 'transcribing'), 'busy');
    assert.equal(speechErrorCode({ code: 'not_permitted' }, 'transcribing'), 'not_permitted');
  });

  await t.test('每种失败都有一句人话', () => {
    assert.match(describeSpeechError('not_permitted'), /麦克风/);
    assert.match(describeSpeechError('no_audio'), /没有录到声音/);
    assert.match(describeSpeechError('transcription_failed'), /重发/);
  });
});

test('session-watch: 待答卡合并', async (t) => {
  const snapshot = {
    availability: 'ready',
    sessions: [
      { sessionId: 's1', title: '甲', status: 'running', updatedAtMs: 10, needsAnswer: false },
      { sessionId: 's2', title: '乙', status: 'idle', updatedAtMs: 20, needsAnswer: false },
    ],
  };

  await t.test('运行时有的待答卡 → 标成在等回答', () => {
    const merged = mergePendingAsks(snapshot, new Set(['s2']));
    assert.equal(merged.sessions.find((row) => row.sessionId === 's1').needsAnswer, false);
    assert.equal(merged.sessions.find((row) => row.sessionId === 's2').needsAnswer, true);
  });

  await t.test('事件已经点亮的，不被运行时那份抹掉', () => {
    const merged = mergePendingAsks(
      { ...snapshot, sessions: [{ ...snapshot.sessions[0], needsAnswer: true }] },
      new Set(),
    );
    assert.equal(merged.sessions[0].needsAnswer, true, '事件是加速器，不能被运行时覆盖掉');
  });

  await t.test('卡答掉之后标记会熄灭——合的是原始快照，不是上一份合并结果', () => {
    const first = mergePendingAsks(snapshot, new Set(['s2']));
    assert.equal(first.sessions.find((row) => row.sessionId === 's2').needsAnswer, true);
    // 原始快照里没有事件标记，运行时也不再有待答卡 → 应当熄灭。
    const second = mergePendingAsks(snapshot, new Set());
    assert.equal(second.sessions.find((row) => row.sessionId === 's2').needsAnswer, false);
  });

  await t.test('没有待答卡时不影响别的字段', () => {
    const merged = mergePendingAsks(snapshot, new Set());
    assert.equal(merged.sessions.length, 2);
    assert.equal(merged.sessions[0].title, '甲');
    assert.equal(merged.availability, 'ready');
  });
});
