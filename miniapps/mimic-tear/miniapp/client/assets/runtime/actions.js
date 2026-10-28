/**
 * 事件绑定。
 *
 * 页面上所有的点击与输入都在这里落到对应的动作上：点击用委托，控件各自绑定。
 */

import { el, toast } from '../shared/dom.js';
import { request } from '../shared/http.js';
import { API } from '../shared/api.js';
import { state } from '../shared/state.js';
import { currentRoute, refresh, renderRoute } from './router.js';
import { savePatrolConfig, runPatrolNow } from './patrol.js';
import { loadWatchdogAlerts } from '../views/alerts.js';
import { openDispatchDialog, submitDispatch } from '../views/dispatch.js';
import { selectChatOption, sendChat, submitChatAnswer } from '../views/chat.js';
import { renderSkills } from '../views/skills.js';
import { renderInbox } from '../views/inbox.js';
// 「在宿主侧栏打开」的入口留在 app.js 里（旧的契约测试按字符串断言它），
// 这里照旧调用它。
import { openBossInHostPanel } from '../app.js';

/**
 * Answer a pending question with the boss's decision.
 *
 * The board asks the Host to answer the questionnaire on the blocked session. If the Host
 * will not answer a session this Mini App does not own, the decision is delivered as a
 * message instead, so the answer still reaches the project lead.
 *
 * @param {any} item
 */
async function applyRecommendation(item) {
  const recommendation = item.recommendation;
  if (!recommendation) {
    toast('大哥还没有给出建议', 'error');
    return;
  }

  const agent = window.mcode?.miniapp?.agent;
  if (agent?.answer) {
    try {
      await agent.answer({
        sessionId: item.sessionId,
        questionId: item.requestId,
        answers: [{
          stepId: item.stepIds?.[0] ?? '',
          selectedOptionIds: recommendation.optionIds ?? [],
          selectedOther: false,
        }],
      });
      toast('已按大哥的建议回复');
      void refresh();
      return;
    } catch (error) {
      // Fall through to the message path.
      console.warn('mimic-tear: direct answer failed', error);
    }
  }

  openDispatchDialog(item.projectId, {
    sessionId: item.sessionId,
    instruction: `回复你的提问「${item.body}」。大哥的建议：${recommendation.answer}`
      + (recommendation.rationale ? `（理由：${recommendation.rationale}）` : ''),
  });
  toast('此 Host 无法直接代答，已把建议内容投递给该会话');
}

/**
 * Bind every listener the page needs.
 */
export function bindActions() {
  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-action]');
    if (!target) return;

    const action = target.dataset.action;
    if (action === 'dispatch') {
      event.preventDefault();
      openDispatchDialog(Number(target.dataset.project));
      return;
    }
    if (action === 'ack') {
      event.preventDefault();
      void request(API.ack, {
        method: 'POST',
        body: JSON.stringify({ id: target.dataset.item }),
      })
        .then(() => {
          toast('已标记为已知');
          void refresh();
        })
        .catch((error) => toast(error.message, 'error'));
      return;
    }
    if (action === 'open-session') {
      event.preventDefault();
      // The Mini App cannot open a session it does not own, so the answer is delivered
      // through the verified dispatch path: it reaches the very session that asked.
      const projectId = Number(target.dataset.project);
      const sessionId = target.dataset.session || null;
      const body = target.dataset.body || '';
      openDispatchDialog(projectId, {
        sessionId,
        instruction: `回复你之前的提问：${body}`,
      });
      return;
    }
    if (action === 'apply-recommendation') {
      event.preventDefault();
      const item = (state.inbox ?? []).find((entry) => entry.id === target.dataset.item);
      if (!item) {
        toast('找不到这条待答问题', 'error');
        return;
      }
      void applyRecommendation(item);
      return;
    }
    if (action === 'chat-option') {
      event.preventDefault();
      selectChatOption(target.dataset.step, target.dataset.option);
      return;
    }
    if (action === 'chat-answer') {
      event.preventDefault();
      void submitChatAnswer();
      return;
    }
  });

  el('chat-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = el('chat-input');
    const text = input.value;
    input.value = '';
    void sendChat(text);
  });

  /**
   * Enter sends, Shift + Enter breaks the line.
   *
   * The board is written in Chinese, so the input is mostly used with an IME running. While
   * a candidate is being composed, Enter belongs to the IME — it confirms the word, it does
   * not send the message. `isComposing` and the legacy keyCode 229 are both checked for
   * that reason.
   */
  el('chat-input').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    const form = el('chat-form');
    if (typeof form.requestSubmit === 'function') {
      form.requestSubmit();
      return;
    }
    form.dispatchEvent({ type: 'submit', preventDefault() {} });
  });

  el('chat-open-host').addEventListener('click', () => {
    void openBossInHostPanel();
  });

  el('domain-nav').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-domain]');
    if (!button) return;
    state.domain = button.dataset.domain;
    renderSkills();
  });

  el('inbox-filter').addEventListener('change', (event) => {
    state.filterProject = event.target.value;
    renderInbox();
  });

  el('inbox-kind').addEventListener('change', (event) => {
    state.filterKind = event.target.value;
    renderInbox();
  });

  el('inbox-pending-only').addEventListener('change', (event) => {
    state.pendingOnly = event.target.checked;
    renderInbox();
  });

  el('refresh-button').addEventListener('click', () => {
    void refresh();
    // The alert log is a record of the past: it is a separate read, and it only matters
    // while the log is on screen.
    if (currentRoute().name === 'alerts') void loadWatchdogAlerts();
  });

  el('patrol-enabled').addEventListener('change', () => {
    void savePatrolConfig();
  });

  el('patrol-run-button').addEventListener('click', () => {
    runPatrolNow();
  });

  el('project-dispatch-button').addEventListener('click', () => {
    openDispatchDialog(state.projectId);
  });

  el('dispatch-session').addEventListener('change', (event) => {
    state.dispatchTarget.sessionId = event.target.value || null;
  });

  el('project-back-button').addEventListener('click', () => {
    window.location.hash = '#/overview';
  });

  el('dispatch-cancel').addEventListener('click', () => {
    el('dispatch-dialog').close();
  });

  el('dispatch-form').addEventListener('submit', submitDispatch);

  window.addEventListener('hashchange', () => {
    void renderRoute();
  });
}
