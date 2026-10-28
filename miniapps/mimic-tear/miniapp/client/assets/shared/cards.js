/**
 * 共用的条目渲染。
 *
 * 总览的「需你处理」与收件箱的「决策」摆的是同一类东西——一条待办、一个建议、一张卡片。
 * 它们的壳（严重度条、标题、已处理说明、操作按钮）共用同一份实现，所以住在这里。
 */

import { escapeHtml } from './format.js';

/**
 * Why an item is no longer on your desk.
 *
 * `user` means you marked it known. `boss` means the boss ruled it out — either withdrawing a
 * conclusion of its own that turned out not to apply, or disproving a raw runtime item (a
 * session error it proved was a leftover). The reason is always shown, because an item that
 * leaves the desk without a trace is just a quieter kind of noise.
 *
 * @param {any} item
 * @returns {string}
 */
export function acknowledgedNoteHtml(item) {
  if (!item?.acknowledged) return '';
  if (item.handledBy === 'boss') {
    return `<p class="item__note">大哥已处理：${escapeHtml(item.handledReason || '这条已不适用')}</p>`;
  }
  return '<p class="item__note">你已标记已知</p>';
}

/**
 * The action buttons of an inbox item.
 *
 * A patrol finding may not resolve to a project (the boss named a project that is not on
 * the board), so it gets no dispatch button — a button with project 0 would only produce
 * a confusing 404.
 *
 * @param {any} item
 * @returns {string}
 */
export function itemActionsHtml(item) {
  const actions = [];
  if (item.kind === 'questionnaire' && item.recommendation) {
    actions.push(
      `<button type="button" class="btn btn--small btn--primary" data-action="apply-recommendation"`
      + ` data-item="${escapeHtml(item.id)}">按大哥的建议回复</button>`,
    );
  }
  if (item.sessionId) {
    actions.push(
      `<button type="button" class="btn btn--small" data-action="open-session"`
      + ` data-project="${item.projectId}" data-session="${escapeHtml(item.sessionId)}"`
      + ` data-body="${escapeHtml(item.body)}">去回答</button>`,
    );
  }
  if (item.projectId) {
    actions.push(
      `<button type="button" class="btn btn--small" data-action="dispatch" data-project="${item.projectId}">下达指令</button>`,
    );
  }
  if (!item.acknowledged) {
    actions.push(
      `<button type="button" class="btn btn--small btn--text" data-action="ack" data-item="${escapeHtml(item.id)}">标记已知</button>`,
    );
  }
  return actions.join('');
}

/**
 * The card's id, so a person can tell which card this is.
 *
 * Several cards can sit on the desk at once, and the body text alone does not say which
 * one it is — the body is the question, the id is what the runtime and the boss talk
 * about. The short form is enough to recognise a card; the full id rides along in the
 * title so it can still be copied.
 *
 * @param {any} item
 * @returns {string}
 */
export function requestIdMark(item) {
  const id = String(item?.requestId ?? '').trim();
  if (!id) return '';
  const short = id.length > 12 ? `${id.slice(0, 12)}…` : id;
  return ` · <span class="mono" title="${escapeHtml(id)}">${escapeHtml(short)}</span>`;
}

/**
 * The first question of a card, and how many more it carries.
 *
 * A card can ask several questions, and the board used to print all of them in one
 * paragraph — which made the desk unreadable and, worse, made every card look alike. Only
 * the first question is shown; the rest are counted, because a card that asks two things
 * must not look like a card that asks one.
 *
 * Nothing is lost: the full text still travels with the item on the 「去回答」 button, so
 * the question that gets delivered is still the whole question.
 *
 * @param {any} item
 * @returns {{ text: string, extra: number }}
 */
export function questionnaireCardText(item) {
  const body = String(item?.body ?? '');
  if (item?.kind !== 'questionnaire') return { text: body, extra: 0 };
  try {
    const steps = JSON.parse(item.requestJson ?? '')?.steps;
    if (Array.isArray(steps) && steps.length > 0 && steps[0]?.question) {
      return { text: String(steps[0].question), extra: steps.length - 1 };
    }
  } catch {
    // A malformed payload falls back to the text the server already prepared.
  }
  return { text: body, extra: 0 };
}
