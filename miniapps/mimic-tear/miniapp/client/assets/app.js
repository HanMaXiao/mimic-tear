/**
 * Mimic Tear client — 入口。
 *
 * Presentation only: every read goes through the board's REST API, every change goes
 * through its POST endpoints. The runtime state is pushed over SSE, so the page reflects
 * the boss's work without the user watching anything.
 *
 * The client is split into native ES modules — there is no build step, the browser loads
 * them as they are:
 *
 * - `shared/` — the parts every view needs: the API table, the page state, DOM helpers,
 *   the request wrapper, the wording tables, the re-draw signature guards.
 * - `views/` — one module per view: overview, inbox, project, skills, chat, alerts,
 *   dispatch.
 * - `runtime/` — the parts that drive the page: the frame (header, status, duty lamp),
 *   the router, the event stream, the event bindings, the patrol switch.
 *
 * This file only assembles them and starts the page.
 */

import { API } from './shared/api.js';
import { state } from './shared/state.js';
import { el, toast } from './shared/dom.js';
import { request } from './shared/http.js';
import { applyTheme, setStatus } from './runtime/frame.js';
import { renderRoute } from './runtime/router.js';
import { connectStream } from './runtime/stream.js';
import { bindActions } from './runtime/actions.js';
import { loadPatrolConfig, loadRunningRound } from './runtime/patrol.js';
import { renderChat, loadChatHistory, loadDutyRounds } from './views/chat.js';
import { restoreDispatch } from './views/dispatch.js';
import { initLiveSessions, selectLiveSession, stopLiveSessions } from './runtime/live-sessions.js';
import { initVoiceInput } from './runtime/voice-input.js';
import { applyDeskMode, initDeskWindow, popOutToDesk, returnToPanel } from './runtime/desk-window.js';
import { initRail } from './runtime/rail.js';

/* ------------------------------------------------- 旧契约函数（必须留在本文件） */

/*
 * 下面三个函数留在入口文件里，是因为仓库里有两个测试直接按源码找它们：
 *
 * - `tests/client-skill-library-render.test.mjs` 把 `escapeHtml` 与 `renderSkillLibrary`
 *   的源码单独抠出来跑，断言跑的是真实实现而不是转述。
 * - `tests/host-chat-panel.test.mjs` 断言本文件里出现 `agent.open` 与
 *   `window.mcode?.miniapp?.agent`。
 *
 * 把它们挪进子模块会让这两个测试失去被测对象，所以这里保留定义，其余模块从这里取用。
 */

/**
 * Escape a value that goes into the page.
 *
 * @param {any} value
 * @returns {string}
 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The packaged-skill registry, rendered under the capability library.
 *
 * The two lists answer different questions and mixing them would be a lie: the capability
 * library is what happens to be installed on this machine, the registry is what the boss
 * deliberately packaged out of finished work and dispatches from. A retired entry stays
 * visible on purpose — it is the record of what was tried and rejected.
 */
export function renderSkillLibrary() {
  const container = el('skill-library-list');
  const counter = el('skill-library-count');
  if (!container) return;

  const library = state.skillLibrary;
  if (!library) {
    container.innerHTML = '<div class="state">正在加载已封装技能库…</div>';
    return;
  }

  const entries = library.entries ?? [];
  const stats = library.stats ?? { active: 0, stale: 0, retired: 0 };
  if (counter) {
    counter.textContent = `${stats.active ?? 0} 个可派工`
      + (stats.candidates ? ` · ${stats.candidates} 个待封装` : '')
      + (stats.stale ? ` · ${stats.stale} 个失效` : '')
      + (stats.retired ? ` · ${stats.retired} 个已退役` : '');
  }

  if (entries.length === 0) {
    container.innerHTML = '<div class="empty">还没有封装过的技能。大哥在项目执行中提炼出可复用流程后会登记到这里。</div>';
    return;
  }

  const statusLabel = { candidate: '待封装', active: '可派工', stale: '已失效', retired: '已退役' };
  const statusClass = { candidate: '', active: 'tag--done', stale: 'tag--high', retired: '' };

  container.innerHTML = entries
    .map(
      (entry) => `<div class="skill-row skill-row--entry">
        <div class="skill-row__head">
          <span class="skill-row__name">${escapeHtml(entry.skillName)}</span>
          <span class="skill-row__tags">
            <span class="tag ${statusClass[entry.status] ?? ''}">${escapeHtml(statusLabel[entry.status] ?? entry.status)}</span>
            ${entry.domain ? `<span class="tag">${escapeHtml(entry.domain)}</span>` : ''}
          </span>
        </div>
        ${entry.title && entry.title !== entry.skillName ? `<span class="skill-row__desc">${escapeHtml(entry.title)}</span>` : ''}
        ${(entry.triggers ?? []).length ? `<span class="skill-row__desc">触发词：${escapeHtml(entry.triggers.join('、'))}</span>` : ''}
        <span class="item__meta mono">派工 ${entry.usageCount ?? 0} 次 · 成功 ${entry.successCount ?? 0} 次${entry.lastError ? ` · ${escapeHtml(entry.lastError)}` : ''}</span>
      </div>`,
    )
    .join('');
}

/**
 * Open the conversation with the boss in the Host's own chat side panel.
 *
 * The Host renders an agent turn far better than a Mini App can re-implement it: streaming
 * text, tool calls, permission prompts and questionnaires all come for free, and the user
 * gets the same dialogue they already know from talking to any other agent. The Host
 * exposes exactly this through `agent.open(sessionId)` — it shows one of this plugin's own
 * sessions in the side panel of the chat the Mini App is open in.
 *
 * Two things it deliberately does not do:
 *
 * - **It does not replace the in-page conversation.** The panel is an extra view of the same
 *   session, not a better one; the Mini App stays usable when the Mini App is opened on its
 *   own, outside any chat.
 * - **It does not fail silently.** If the Host refuses — no chat session, no permission, an
 *   older session id — the user is told, because a button that does nothing visible is worse
 *   than no button at all.
 *
 * The boss's own session id comes from the server (`/api/chat/session`), never from the
 * client side.
 */
export async function openBossInHostPanel() {
  const agent = window.mcode?.miniapp?.agent;
  if (!agent?.open) {
    toast('这个窗口没有可用的宿主侧栏（Mini App 需要开在聊天里）', 'error');
    return;
  }

  let sessionId = state.chat.bossSessionId;
  if (!sessionId) {
    try {
      const payload = await request(API.chatSession);
      sessionId = payload?.bossSessionId ?? null;
      state.chat.bossSessionId = sessionId;
    } catch (error) {
      toast(`拿不到大哥的会话：${error.message}`, 'error');
      return;
    }
  }

  if (!sessionId) {
    toast('大哥还没有会话，先跟他说一句话再打开侧栏', 'error');
    return;
  }

  try {
    await agent.open(sessionId);
    toast('已在宿主侧栏打开与大哥的对话');
  } catch (error) {
    toast(`宿主侧栏打开失败：${error?.message ?? error}`, 'error');
  }
}

/* ------------------------------------------------------------------- 启动 */

bindActions();

applyTheme(new URLSearchParams(window.location.search).get('theme'));

setStatus('正在连接…', 'idle');
renderChat();
void renderRoute();
void loadPatrolConfig();
void loadRunningRound();
void loadDutyRounds();
void loadChatHistory();
// A dispatch that was still on its way when the page was closed is read back here: the
// server kept the record, and the page must not pretend the instruction never went out.
void restoreDispatch();
connectStream();

// The live session list is the Host's own truth about this machine, so it is watched
// from the moment the page opens — not when the user happens to click the section.
// The observer pushes changes in; the view redraws itself.
initLiveSessions();
initVoiceInput();
initDeskWindow();
initRail();

// The page goes away, the observer goes with it. A watch that outlives the page
// keeps a timer alive and keeps a slot occupied on the Host side.
globalThis.addEventListener?.('pagehide', () => {
  stopLiveSessions();
});

// Clicking a session in the live list opens its final reply.
document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-session]');
  if (!target) return;
  event.preventDefault();
  selectLiveSession(target.dataset.session);
});

// The desk button is a toggle: the Host reports which mode the page is in, and the
// label follows it. `update({mode})` has to be called from a user gesture, so the
// call itself happens synchronously inside this handler.
el('desk-toggle')?.addEventListener('click', () => {
  const mode = document.documentElement.dataset.deskMode;
  if (mode === 'window') {
    returnToPanel();
    applyDeskMode('inline');
    return;
  }
  popOutToDesk();
  applyDeskMode('window');
});
