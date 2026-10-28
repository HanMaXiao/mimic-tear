/**
 * 运行时事件流。
 *
 * 服务端把看板的变化推过来，页面照着改：总览变了就重画总览，对话有新话就重画对话，
 * 派工有结果就说结果。页面自己不做轮询。
 */

import { toast } from '../shared/dom.js';
import { request } from '../shared/http.js';
import { API } from '../shared/api.js';
import { state } from '../shared/state.js';
import { overviewChanged, inboxChanged } from '../shared/signatures.js';
import { renderDutyStatus, renderWarning, setStatus } from './frame.js';
import { renderKpi, renderAttention, renderProjects } from '../views/overview.js';
import { renderInbox } from '../views/inbox.js';
import { renderProject } from '../views/project.js';
import { renderChat, recordChatTool, loadChatHistory } from '../views/chat.js';
import { renderDispatchOutcome, normalizeDispatchOutcome, forgetDispatchId } from '../views/dispatch.js';
import { currentRoute, refresh } from './router.js';

let eventSource = null;

/**
 * Subscribe to the board's event stream.
 */
export function connectStream() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource(API.stream);

  eventSource.addEventListener('snapshot', (event) => {
    state.overview = JSON.parse(event.data);
    renderDutyStatus(state.overview?.duty);
    if (overviewChanged(state.overview)) {
      renderKpi(state.overview);
      renderAttention(state.overview);
      renderProjects(state.overview);
    }
    renderWarning(state.overview.dataWarning);
    setStatus('实时同步中', 'live');
  });

  eventSource.addEventListener('update', (event) => {
    state.overview = JSON.parse(event.data);
    renderDutyStatus(state.overview?.duty);
    if (overviewChanged(state.overview)) {
      renderKpi(state.overview);
      renderAttention(state.overview);
      renderProjects(state.overview);
    }
    renderWarning(state.overview.dataWarning);
    void refreshInbox();
    // The project detail shows the live team structure; it must follow the same stream.
    void refreshProjectIfVisible();
  });

  eventSource.addEventListener('chat.history', (event) => {
    // Something was said in the conversation — possibly in the Host chat side panel, which
    // writes to the same session but does not go through this page's SSE. The transcript
    // is re-read so both views show the same thing.
    const payload = JSON.parse(event.data);
    state.chat.transcript = Array.isArray(payload?.messages) ? payload.messages : [];
    // The local optimistic bubbles have been committed to the session by now.
    state.chat.messages = [];
    renderChat();
  });

  eventSource.addEventListener('duty', (event) => {
    // A duty round happened while the board was open. The rounds are the user seeing the
    // boss walk between projects, so they belong in the conversation, not only in the inbox.
    const payload = JSON.parse(event.data);
    state.chat.duty = Array.isArray(payload?.rounds) ? payload.rounds : [];
    renderChat();
  });

  eventSource.addEventListener('patrol', (event) => {
    const payload = JSON.parse(event.data);
    if (payload.error) {
      toast(`巡检失败：${payload.error}`, 'error');
    } else {
      const count = payload.findings?.length ?? 0;
      toast(count > 0 ? `大哥巡检完成，${count} 条结论` : '大哥巡检完成');
    }
    void refresh();
  });

  eventSource.addEventListener('dispatch', (event) => {
    const payload = JSON.parse(event.data);
    renderDispatchOutcome(normalizeDispatchOutcome(payload));
    // The dispatch is finished: there is nothing left to restore after a reload.
    const dispatchId = payload?.dispatchId ?? payload?.id ?? null;
    if (dispatchId) forgetDispatchId(dispatchId);
    void refresh();
  });

  eventSource.addEventListener('permission', (event) => {
    const payload = JSON.parse(event.data);
    void request(API.permission(payload.requestId), {
      method: 'POST',
      body: JSON.stringify({ decision: 'allowOnce' }),
    }).catch(() => undefined);
    toast(`大哥请求使用工具 ${payload.toolName}`, 'error');
  });

  // ---- the conversation with the boss ----

  eventSource.addEventListener('chat.delta', (event) => {
    const payload = JSON.parse(event.data);
    state.chat.streaming = (state.chat.streaming ?? '') + (payload.text ?? '');
    renderChat();
  });

  eventSource.addEventListener('chat.tool', (event) => {
    recordChatTool(JSON.parse(event.data));
  });

  eventSource.addEventListener('chat.question', (event) => {
    const payload = JSON.parse(event.data);
    state.chat.question = { requestId: payload.requestId, request: payload.request ?? null };
    state.chat.answers = {};
    // The turn is paused until the user answers, so the half-written reply becomes a
    // message of its own rather than a bubble that keeps growing.
    if (state.chat.streaming) {
      state.chat.messages.push({ role: 'boss', text: state.chat.streaming, tools: state.chat.tools });
    }
    state.chat.streaming = null;
    state.chat.tools = [];
    renderChat();
  });

  eventSource.addEventListener('chat.done', (event) => {
    const payload = JSON.parse(event.data);
    const text = payload.text || state.chat.streaming || '';
    if (text || state.chat.tools.length) {
      state.chat.messages.push({ role: 'boss', text, tools: state.chat.tools });
    }
    if (payload.error) {
      state.chat.messages.push({ role: 'boss', text: `（大哥这轮没完成：${payload.error}）` });
    }
    state.chat.streaming = null;
    state.chat.tools = [];
    renderChat();
    // The turn is over, so the runtime now holds the committed exchange. Re-read it: the
    // transcript is the truth, and the local bubbles were only ever a stand-in for it.
    // The local bubbles are kept until the transcript actually contains this turn, so a
    // slow commit does not make the reply vanish.
    void loadChatHistory({ keepLocal: true });
    void refresh();
  });

  eventSource.onerror = () => {
    setStatus('正在重连…', 'idle');
  };
}

/**
 * Re-read the desk.
 */
export async function refreshInbox() {
  try {
    const inbox = await request(API.inbox);
    state.inbox = inbox.items ?? [];
    if (inboxChanged(state.inbox)) renderInbox();
  } catch {
    // A transient inbox read failure must not break the page.
  }
}

/**
 * Re-fetch the open project detail.
 *
 * The detail view is the one place where live structure matters (the team tree changes as
 * agents spawn), so it follows the same stream as the overview.
 */
export async function refreshProjectIfVisible() {
  const route = currentRoute();
  if (route.name !== 'project') return;
  try {
    state.project = await request(API.project(route.param));
    renderProject();
  } catch {
    // Keep the last good view rather than blanking the page.
  }
}
