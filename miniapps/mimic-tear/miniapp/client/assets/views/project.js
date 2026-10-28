/**
 * 项目档案。
 *
 * 一个项目的全貌：团队结构、Goal、计划任务与待答问题。
 */

import { el } from '../shared/dom.js';
import {
  escapeHtml,
  HEALTH_LABEL,
  GOAL_STATUS_LABEL,
  STATE_LABEL,
  QUESTION_STATUS_LABEL,
  planAgeLabel,
} from '../shared/format.js';
import { state } from '../shared/state.js';
import { renderHeaderContext } from '../runtime/frame.js';

/**
 * One agent in the team tree.
 *
 * @param {any} node
 * @returns {string}
 */
function treeNodeHtml(node) {
  const children = (node.children ?? [])
    .map((child) => `<li>${treeNodeHtml(child)}</li>`)
    .join('');
  return `
    <div class="tree__row">
      <span class="status status--${node.status === 'error' ? 'error' : node.status === 'started' ? 'active' : 'idle'}">
        <span class="status__dot" aria-hidden="true"></span>
      </span>
      <span class="tree__name">${escapeHtml(node.agentName)}</span>
      <span class="tag">${node.role === 'lead' ? '负责人' : '成员'}</span>
      <span class="tree__title">${escapeHtml(node.title)}</span>
      ${node.error ? `<span class="tree__error">${escapeHtml(node.error)}</span>` : ''}
    </div>
    ${children ? `<ul>${children}</ul>` : ''}`;
}

/**
 * How many sessions the project has.
 *
 * @param {Array<any>} nodes
 * @returns {number}
 */
function countTreeNodes(nodes) {
  return (nodes ?? []).reduce((total, node) => total + 1 + countTreeNodes(node.children), 0);
}

/**
 * Draw the project dossier.
 */
export function renderProject() {
  const detail = state.project;
  if (!detail) {
    el('org-tree').innerHTML = '<div class="state">正在加载项目详情…</div>';
    return;
  }

  const project = detail.project;
  el('project-title').textContent = project.name;
  el('project-path').textContent = project.path;

  const sessions = countTreeNodes(detail.orgTree);

  // The health is a word, not a number: it is read as a state, with the same dot the
  // project table uses, so the two views speak the same language.
  const readouts = [
    {
      label: '状态',
      html: `<span class="kpi__readout"><span class="status status--${escapeHtml(project.health)}">
        <span class="status__dot" aria-hidden="true"></span>${escapeHtml(HEALTH_LABEL[project.health] ?? project.health)}
      </span></span>`,
      tone: '',
    },
    { label: '会话', value: project.sessionCount, tone: '' },
    { label: '待决策', value: project.pendingQuestions, tone: project.pendingQuestions > 0 ? 'kpi--warning' : '' },
    { label: '异常会话', value: project.erroredSessions, tone: project.erroredSessions > 0 ? 'kpi--danger' : '' },
  ];
  el('project-kpi').innerHTML = readouts
    .map(
      (kpi) => `<div class="kpi ${kpi.tone}">
        <p class="kpi__label">${escapeHtml(kpi.label)}</p>
        ${kpi.html ?? `<p class="kpi__value">${escapeHtml(kpi.value)}</p>`}
      </div>`,
    )
    .join('');

  el('org-count').textContent = `${sessions} 个会话`;
  el('org-tree').innerHTML = detail.orgTree.length
    ? detail.orgTree.map((node) => `<li>${treeNodeHtml(node)}</li>`).join('')
    : '<div class="empty">该项目下没有可见会话。</div>';

  el('goal-count').textContent = detail.goals.length ? `${detail.goals.length} 个` : '';
  el('goal-list').innerHTML = detail.goals.length
    ? detail.goals
        .map(
          (goal) => `<div class="item">
            <div class="item__head">
              <span class="tag ${goal.status === 'active' ? 'tag--done' : goal.status === 'paused' ? 'tag--high' : ''}">${escapeHtml(GOAL_STATUS_LABEL[goal.status] ?? goal.status)}</span>
              <span class="item__title">${escapeHtml(goal.objective)}</span>
            </div>
            <p class="item__meta">${goal.tokensUsed} tokens · ${Math.round((goal.timeUsedSeconds ?? 0) / 60)} 分钟</p>
          </div>`,
        )
        .join('')
    : '<div class="empty">该项目没有进行中的 Goal。</div>';

  const planTasks = detail.plan?.tasks ?? [];
  // How the plan actually stands. A plan log can be months old, so the age is said out
  // loud next to the counts — a stale task state is a historical fact, not a live signal.
  const planCounts = planTasks.reduce((counts, task) => {
    counts[task.state] = (counts[task.state] ?? 0) + 1;
    return counts;
  }, {});
  el('plan-count').textContent = planTasks.length
    ? `${planTasks.length} 个任务 · 完成 ${planCounts.done ?? 0} · 进行中 ${planCounts.producing ?? 0}`
      + (planCounts.blocked ? ` · 阻塞 ${planCounts.blocked}` : '')
      + planAgeLabel(detail.project.planUpdatedAt)
    : '';
  el('plan-list').innerHTML = planTasks.length
    ? planTasks
        .map(
          (task) => `<div class="item">
            <div class="item__head">
              <span class="tag ${task.state === 'done' ? 'tag--done' : task.state === 'blocked' ? 'tag--high' : ''}">${STATE_LABEL[task.state] ?? task.state}</span>
              <span class="item__title">${escapeHtml(task.title)}</span>
              ${task.assignedTo ? `<span class="tag">${escapeHtml(task.assignedTo)}</span>` : ''}
            </div>
          </div>`,
        )
        .join('')
    : '<div class="empty">该项目没有 Goal 模式计划状态。</div>';

  el('question-count').textContent = detail.questions.length ? `${detail.questions.length} 条` : '';
  el('question-list').innerHTML = detail.questions.length
    ? detail.questions
        .map(
          (question) => `<div class="item">
            <div class="item__head">
              <span class="tag ${question.status === 'pending' ? 'tag--high' : 'tag--done'}">${escapeHtml(QUESTION_STATUS_LABEL[question.status] ?? question.status)}</span>
              <span class="item__title">${escapeHtml(question.sessionTitle ?? question.sessionId)}</span>
            </div>
            <p class="item__body mono">${escapeHtml(question.id)}</p>
          </div>`,
        )
        .join('')
    : '<div class="empty">该项目没有待答问题。</div>';
  renderHeaderContext();
}
