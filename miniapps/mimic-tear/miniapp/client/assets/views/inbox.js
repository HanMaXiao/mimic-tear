/**
 * 决策收件箱。
 *
 * 桌面上待办的分级列表：先 loudest first，再按项目与类型过滤。
 */

import { el } from '../shared/dom.js';
import { escapeHtml, relativeTime, KIND_LABEL, SEVERITY_LABEL } from '../shared/format.js';
import {
  acknowledgedNoteHtml,
  itemActionsHtml,
  requestIdMark,
  questionnaireCardText,
} from '../shared/cards.js';
import { state } from '../shared/state.js';
import { renderHeaderContext } from '../runtime/frame.js';

/**
 * One item of the desk.
 *
 * @param {any} item
 * @returns {string}
 */
export function inboxItemHtml(item) {
  const card = questionnaireCardText(item);
  return `
    <div class="item item--${escapeHtml(item.severity)}${item.acknowledged ? ' item--acknowledged' : ''}">
      <div class="item__head">
        <span class="tag">${KIND_LABEL[item.kind] ?? item.kind}</span>
        <span class="item__title">${escapeHtml(item.title)}</span>
      </div>
      <p class="item__meta">${escapeHtml(item.projectName)} · ${relativeTime(item.createdAt)}${requestIdMark(item)}</p>
      <p class="item__body doc">${escapeHtml(card.text)}</p>
      ${card.extra > 0 ? `<p class="item__note">另有 ${card.extra} 问 · 去回答会带上全文</p>` : ''}
      ${acknowledgedNoteHtml(item)}
      <div class="item__actions">${itemActionsHtml(item)}</div>
    </div>`;
}

/** The order the desk is read in: the loudest first. */
const SEVERITY_ORDER = ['high', 'medium', 'low'];

/**
 * The inbox, grouped by severity.
 *
 * A flat list makes the reader do the sorting. The desk has a natural order — high
 * first — so the board states it instead of leaving it implied.
 *
 * @param {Array<any>} items
 * @returns {string}
 */
export function inboxGroupsHtml(items) {
  const groups = SEVERITY_ORDER
    .map((severity) => ({ severity, items: items.filter((item) => item.severity === severity) }))
    .filter((group) => group.items.length > 0);

  // An item with a severity the board does not know about still has to be shown.
  const unknown = items.filter((item) => !SEVERITY_ORDER.includes(item.severity));
  if (unknown.length) groups.push({ severity: 'low', items: unknown });

  return groups
    .map(
      (group) => `
      <div class="inbox-group inbox-group--${escapeHtml(group.severity)}">
        <p class="inbox-group__head">
          <span class="inbox-group__severity">${escapeHtml(SEVERITY_LABEL[group.severity] ?? group.severity)}</span>
          <span>${group.items.length} 项</span>
        </p>
        ${group.items.map(inboxItemHtml).join('')}
      </div>`,
    )
    .join('');
}

/**
 * Draw the desk.
 */
export function renderInbox() {
  const list = el('inbox-list');
  const projects = state.overview?.projects ?? [];

  const filterOptions = projects
    .map((project) => `<option value="${project.id}">${escapeHtml(project.name)}</option>`)
    .join('');
  const filter = el('inbox-filter');
  const currentFilter = filter.value;
  filter.innerHTML = `<option value="">全部项目</option>${filterOptions}`;
  filter.value = currentFilter;

  // The kind filter: the inbox holds several kinds of thing, and hunting through all of
  // them to find one kind is the reason the list felt endless.
  const kinds = [...new Set(state.inbox.map((item) => item.kind))];
  const kindSelect = el('inbox-kind');
  const currentKind = kindSelect.value;
  kindSelect.innerHTML = '<option value="">全部类型</option>'
    + kinds
      .map((kind) => `<option value="${escapeHtml(kind)}">${escapeHtml(KIND_LABEL[kind] ?? kind)}</option>`)
      .join('');
  kindSelect.value = currentKind;

  const items = state.inbox.filter((item) => {
    if (state.filterProject && String(item.projectId) !== state.filterProject) return false;
    if (state.filterKind && item.kind !== state.filterKind) return false;
    if (state.pendingOnly && item.acknowledged) return false;
    return true;
  });

  // How many raw runtime items the boss ruled out. It leaves the attention list, so the
  // count has to be said out loud — otherwise the screening is invisible.
  const ruledOut = state.overview?.duty?.dismissed ?? 0;

  el('inbox-count').textContent = items.length
    ? `${items.length} 项${ruledOut > 0 ? ` · ${ruledOut} 条已由大哥排除` : ''}`
    : (ruledOut > 0 ? `${ruledOut} 条已由大哥排除` : '');

  if (state.error && !state.inbox.length) {
    list.innerHTML = '<div class="state state--error">收件箱读取失败，请刷新重试。</div>';
    return;
  }
  if (!items.length) {
    list.innerHTML = '<div class="empty">没有待处理事项。</div>';
    return;
  }
  list.innerHTML = inboxGroupsHtml(items);
  renderHeaderContext();
}
