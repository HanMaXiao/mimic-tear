/**
 * 会话实况的接线。
 *
 * 这一层是「宿主桥接」与「看板状态」之间唯一的接口：它拿到宿主给的 agent，
 * 起一个观察，把结果写进共享状态，再让视图重画。
 *
 * 它也负责回答「这个宿主到底给不给人看会话」：没有 `session.read` 授权时，
 * 宿主会拒绝，观察层把它翻译成「未授权」，看板如实显示，而不是假装没有会话。
 *
 * 「等回答」有两个来源，**权威的是运行时那份**：
 *
 * 1. **运行时待答卡（权威）** —— 板面自己的接口 `/api/sessions/pending-asks` 直接读
 *    运行时的 `questionnaire_requests`。它是持久状态：页面关过、重载过、订阅之前
 *    就挂着的卡，都还在。
 * 2. **宿主工具事件（加速）** —— `tool.started(name='ask_user')` 到达时立刻点亮。
 *    但宿主的事件流只覆盖订阅之后新起的提问，页面一重载就断，所以它只能当加速器，
 *    不能当判据。
 *
 * 两条取并集：事件负责「快」，运行时负责「准」。
 */

import { API } from '../shared/api.js';
import { state } from '../shared/state.js';
import { request } from '../shared/http.js';
import { renderSessions } from '../views/sessions.js';
import { createSessionWatch, mergePendingAsks } from './session-watch.js';

/** @type {any} */
let watch = null;
/** @type {Set<string>} */
let pendingAsks = new Set();
/**
 * 观察层给的原始快照。
 *
 * 单独留着，是因为「等回答」有两个来源：原始快照里带的是**事件**判出来的，
 * 合并后带的是**事件 ∪ 运行时**。卡被答掉之后，运行时那份不再有它，
 * 但合并过的那份还留着旧标记——不回到原始快照重算，这个标记就永远熄不掉。
 *
 * @type {any}
 */
let rawSnapshot = null;

/**
 * 宿主给的 agent。没有它就没有会话可读。
 *
 * @returns {any}
 */
function hostAgent() {
  return globalThis.window?.mcode?.miniapp?.agent ?? null;
}

/**
 * 读一遍运行时的待答卡。
 *
 * 读不到就保持上一次的结果：看板不该因为这个接口抖一下就整个失明。
 */
export async function refreshPendingAsks() {
  try {
    const payload = await request(API.sessionPendingAsks);
    pendingAsks = new Set((payload?.asks ?? []).map((entry) => entry.sessionId));
  } catch {
    // 保留上一次的集合。
  }
  if (!rawSnapshot) return;
  state.sessions = mergePendingAsks(rawSnapshot, pendingAsks);
  renderSessions();
}

/**
 * 起观察，连上宿主。
 */
export function initLiveSessions() {
  const agent = hostAgent();
  if (!agent) {
    state.sessions = {
      availability: 'unavailable',
      sessions: [],
      selectedSessionId: null,
      detail: null,
      detailLoading: false,
      error: 'unsupported',
    };
    renderSessions();
    return null;
  }

  watch = createSessionWatch({
    agent,
    onChange: (snapshot) => {
      rawSnapshot = snapshot;
      state.sessions = mergePendingAsks(snapshot, pendingAsks);
      renderSessions();
    },
    // 待答卡挂在观察层那一个节拍上：客户端只留一个定时器。
    onTick: () => { void refreshPendingAsks(); },
  });

  void watch.start();
  void refreshPendingAsks();
  return watch;
}

/**
 * 选中一个会话。
 *
 * @param {string} sessionId
 */
export function selectLiveSession(sessionId) {
  watch?.select(sessionId);
}

/**
 * 重新读一遍会话清单与待答卡。
 */
export function refreshLiveSessions() {
  void watch?.refresh();
  void refreshPendingAsks();
}

/**
 * 停掉观察。
 */
export function stopLiveSessions() {
  watch?.dispose();
  watch = null;
}
