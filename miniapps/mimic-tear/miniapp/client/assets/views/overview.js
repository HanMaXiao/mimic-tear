/**
 * 总览。
 *
 * 四个数字、一摞「需你处理」、一张项目台账——这是整块看板的落地面。
 */

import { el, setClass } from '../shared/dom.js';
import {
  escapeHtml,
  relativeTime,
  waitingLabel,
  HEALTH_LABEL,
  SEVERITY_LABEL,
  KIND_LABEL,
} from '../shared/format.js';
import {
  acknowledgedNoteHtml,
  itemActionsHtml,
  requestIdMark,
  questionnaireCardText,
} from '../shared/cards.js';
import { state } from '../shared/state.js';
import { renderHeaderContext, renderDutyStatus } from '../runtime/frame.js';

/**
 * The four numbers at the top of the overview.
 *
 * @param {any} overview
 */
export function renderKpi(overview) {
  const kpi = overview?.kpi ?? { projects: 0, active: 0, pendingDecisions: 0, errors: 0 };
  el('kpi-projects').textContent = kpi.projects;
  el('kpi-active').textContent = kpi.active;
  el('kpi-pending').textContent = kpi.pendingDecisions;
  el('kpi-errors').textContent = kpi.errors;

  // Zero is not an alarm. The state colour is spent only when there is something on the
  // desk — a board that paints "0" in red teaches the eye to ignore red.
  setClass(el('kpi-tile-pending'), 'kpi--warning', kpi.pendingDecisions > 0);
  setClass(el('kpi-tile-errors'), 'kpi--danger', kpi.errors > 0);

  const badge = el('inbox-badge');
  badge.textContent = kpi.pendingDecisions;
  badge.hidden = kpi.pendingDecisions === 0;
  renderHeaderContext();
}

/**
 * One item on the desk.
 *
 * @param {any} item
 * @returns {string}
 */
export function attentionItemHtml(item) {
  const card = questionnaireCardText(item);
  return `
    <div class="item item--${escapeHtml(item.severity)}${item.acknowledged ? ' item--acknowledged' : ''}">
      <div class="item__head">
        <span class="tag tag--${item.severity}">${SEVERITY_LABEL[item.severity] ?? item.severity}</span>
        <span class="tag">${KIND_LABEL[item.kind] ?? item.kind}</span>
        <span class="item__title">${escapeHtml(item.title)}</span>
      </div>
      <p class="item__meta">${escapeHtml(item.projectName)} · ${waitingLabel(item.createdAt)}${requestIdMark(item)}</p>
      <p class="item__body doc">${escapeHtml(card.text)}</p>
      ${card.extra > 0 ? `<p class="item__note">另有 ${card.extra} 问 · 去回答会带上全文</p>` : ''}
      ${acknowledgedNoteHtml(item)}
      <div class="item__actions">${itemActionsHtml(item)}</div>
    </div>`;
}

/**
 * The list of things waiting for a decision.
 *
 * @param {any} overview
 */
export function renderAttention(overview) {
  const list = el('attention-list');
  const items = overview?.attention ?? [];

  el('attention-count').textContent = items.length ? `${items.length} 项` : '';
  renderDutyStatus(overview?.duty);

  if (state.error && !items.length) {
    list.innerHTML = '<div class="state state--error">数据读取失败，请点击右上角刷新重试。</div>';
    return;
  }
  if (!items.length) {
    list.innerHTML = '<div class="empty">目前没有需要你处理的事项。</div>';
    return;
  }
  list.innerHTML = items.map(attentionItemHtml).join('');
}

/**
 * One project, as a row of the ledger.
 *
 * @param {any} project
 * @returns {string}
 */
export function projectRowHtml(project) {
  const goals = project.goals ?? [];
  const activeGoals = goals.filter((goal) => goal.status === 'active').length;
  // The proportion is already implied by the two numbers; the meter only makes it readable
  // at a glance. It is decorative, so the count stays in text for the screen reader.
  const ratio = goals.length ? Math.round((activeGoals / goals.length) * 100) : 0;
  return `
    <tr>
      <td>
        <a class="cell-project__name" href="#/project/${project.id}">${escapeHtml(project.name)}</a>
        <span class="cell-project__path mono">${escapeHtml(project.path)}</span>
      </td>
      <td>
        <span class="status status--${project.health}">
          <span class="status__dot" aria-hidden="true"></span>${HEALTH_LABEL[project.health] ?? project.health}
        </span>
      </td>
      <td class="nowrap">
        <span class="goal-cell">
          <span class="goal-meter" aria-hidden="true"><span class="goal-meter__fill" style="width: ${ratio}%"></span></span>
          <span class="goal-cell__text"><b>${activeGoals}</b> / ${goals.length} 进行中</span>
        </span>
      </td>
      <td class="numeric">${project.sessionCount}</td>
      <td class="numeric">${project.pendingQuestions}</td>
      <td>${relativeTime(project.lastActivityAt)}</td>
      <td><button type="button" class="btn btn--small" data-action="dispatch" data-project="${project.id}">下达指令</button></td>
    </tr>`;
}

/**
 * The ledger of every project the board knows about.
 *
 * @param {any} overview
 */
export function renderProjects(overview) {
  const body = el('projects-body');
  const projects = overview?.projects ?? [];
  const hidden = overview?.internalProjectCount ?? 0;

  el('projects-count').textContent = projects.length
    ? `${projects.length} 个项目${hidden ? ` · 另有 ${hidden} 个运行时内部工作区未显示` : ''}`
    : '';

  if (state.error && !projects.length) {
    body.innerHTML = '<tr><td colspan="7"><div class="state state--error">项目数据读取失败，请刷新重试。</div></td></tr>';
    return;
  }
  if (!projects.length) {
    body.innerHTML = '<tr><td colspan="7"><div class="empty">没有发现任何项目。</div></td></tr>';
    return;
  }
  body.innerHTML = projects.map(projectRowHtml).join('');
}
