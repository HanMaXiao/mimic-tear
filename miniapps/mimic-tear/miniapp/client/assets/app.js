/**
 * Mimic Tear client.
 *
 * Presentation only: every read goes through the board's REST API, every change goes
 * through its POST endpoints. The runtime state is pushed over SSE, so the page reflects
 * the boss's work without the user watching anything.
 */

const API = {
  overview: '/api/overview',
  inbox: '/api/inbox',
  projects: '/api/projects',
  project: (id) => `/api/projects/${id}`,
  skills: '/api/skills',
  dispatch: '/api/dispatch',
  ack: '/api/inbox/ack',
  permission: (requestId) => `/api/permissions/${requestId}`,
  patrol: '/api/patrol',
  patrolConfig: '/api/patrol/config',
  patrolRun: '/api/patrol/run',
  stream: '/api/stream',
};

const state = {
  overview: null,
  inbox: [],
  skills: null,
  project: null,
  projectId: null,
  domain: null,
  filterProject: '',
  pendingOnly: true,
  loading: false,
  error: null,
  // The project and session the dispatch dialog is currently aimed at. The dialog must
  // remember its own target: deriving it from the current route silently sends the
  // instruction to whichever project was opened last.
  dispatchTarget: { projectId: null, sessionId: null },
};

const el = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ utils */

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function relativeTime(timestamp) {
  if (!timestamp) return '—';
  const diff = Date.now() - timestamp;
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(timestamp).toLocaleDateString('zh-CN');
}

const HEALTH_LABEL = {
  active: '推进中',
  idle: '空闲',
  blocked: '有阻塞',
  error: '异常',
};

const STATE_LABEL = {
  producing: '进行中',
  ready: '待开始',
  blocked: '被阻塞',
  done: '已完成',
  failed: '失败',
  unknown: '未知',
};

const SEVERITY_LABEL = { high: '高', medium: '中', low: '低' };

/**
 * Label for how old a plan state snapshot is.
 *
 * A Goal-mode plan log is only rewritten when the plan runs, so a plan can be months old.
 * Showing its age keeps a stale task state from being read as a live signal.
 */
function planAgeLabel(updatedAt) {
  if (!updatedAt) return '';
  const days = Math.floor((Date.now() - updatedAt) / 86_400_000);
  if (days <= 0) return '· 状态为今日';
  if (days === 1) return '· 状态为 1 天前';
  if (days < 30) return `· 状态为 ${days} 天前`;
  return `· 状态为 ${Math.floor(days / 30)} 个月前`;
}

/** Human-readable waiting time, so a three-week-old item does not read as "20140 分钟". */
function waitingLabel(timestamp) {
  if (!timestamp) return '时间未知';
  const minutes = Math.round((Date.now() - timestamp) / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `等待 ${minutes} 分钟`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `等待 ${hours} 小时`;
  return `等待 ${Math.round(hours / 24)} 天`;
}

const KIND_LABEL = {
  questionnaire: '待答问题',
  'goal-paused': 'Goal 暂停',
  'session-error': '会话异常',
  'plan-blocked': '计划阻塞',
  patrol: '大哥巡检',
};

function toast(message, kind = 'info') {
  const host = el('toast-host');
  const node = document.createElement('div');
  node.className = kind === 'error' ? 'toast toast--error' : 'toast';
  node.textContent = message;
  host.appendChild(node);
  setTimeout(() => node.remove(), 4000);
}

async function request(path, options) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  if (!response.ok) {
    const message = payload?.message || payload?.error || `请求失败（${response.status}）`;
    const error = new Error(message);
    error.code = payload?.error;
    error.status = response.status;
    throw error;
  }
  return payload;
}

/* --------------------------------------------------------------- rendering */

/**
 * Rendering is guarded by a content signature.
 *
 * The runtime pushes an update whenever any session anywhere moves, so a naive re-render
 * would replace the whole table every few seconds — destroying the element under the user's
 * cursor and dropping focus mid-click. Re-rendering only when the visible content actually
 * changed keeps the DOM stable.
 */
let overviewSignature = '';
let inboxSignature = '';

function overviewChanged(overview) {
  const signature = JSON.stringify([
    overview?.kpi,
    overview?.projects,
    overview?.attention,
    overview?.internalProjectCount,
  ]);
  if (signature === overviewSignature) return false;
  overviewSignature = signature;
  return true;
}

function inboxChanged(items) {
  const signature = JSON.stringify(items);
  if (signature === inboxSignature) return false;
  inboxSignature = signature;
  return true;
}

function setStatus(text, status = 'idle') {
  const node = el('app-status');
  node.textContent = text;
  node.dataset.state = status;
}

function renderWarning(message) {
  const node = el('data-warning');
  if (!message) {
    node.hidden = true;
    node.textContent = '';
    return;
  }
  node.hidden = false;
  node.textContent = message;
}

function renderKpi(overview) {
  const kpi = overview?.kpi ?? { projects: 0, active: 0, pendingDecisions: 0, errors: 0 };
  el('kpi-projects').textContent = kpi.projects;
  el('kpi-active').textContent = kpi.active;
  el('kpi-pending').textContent = kpi.pendingDecisions;
  el('kpi-errors').textContent = kpi.errors;

  const badge = el('inbox-badge');
  badge.textContent = kpi.pendingDecisions;
  badge.hidden = kpi.pendingDecisions === 0;
}

/**
 * The action buttons of an inbox item.
 *
 * A patrol finding may not resolve to a project (the boss named a project that is not on
 * the board), so it gets no dispatch button — a button with project 0 would only produce
 * a confusing 404.
 */
function itemActionsHtml(item) {
  const actions = [];
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

function attentionItemHtml(item) {
  return `
    <div class="item${item.acknowledged ? ' item--acknowledged' : ''}">
      <div class="item__head">
        <span class="tag tag--${item.severity}">${SEVERITY_LABEL[item.severity] ?? item.severity}</span>
        <span class="tag">${KIND_LABEL[item.kind] ?? item.kind}</span>
        <span class="item__title">${escapeHtml(item.title)}</span>
        <span class="item__meta">${escapeHtml(item.projectName)} · ${waitingLabel(item.createdAt)}</span>
      </div>
      <p class="item__body">${escapeHtml(item.body)}</p>
      <div class="item__actions">${itemActionsHtml(item)}</div>
    </div>`;
}

function renderAttention(overview) {
  const list = el('attention-list');
  const items = overview?.attention ?? [];

  el('attention-count').textContent = items.length ? `${items.length} 项` : '';

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

function projectRowHtml(project) {
  const activeGoals = (project.goals ?? []).filter((goal) => goal.status === 'active').length;
  return `
    <tr>
      <td>
        <a href="#/project/${project.id}">${escapeHtml(project.name)}</a>
        <div class="item__meta mono">${escapeHtml(project.path)}</div>
      </td>
      <td>
        <span class="status status--${project.health}">
          <span class="status__dot" aria-hidden="true"></span>${HEALTH_LABEL[project.health] ?? project.health}
        </span>
      </td>
      <td>${activeGoals} 个进行中 / ${(project.goals ?? []).length} 个</td>
      <td class="numeric">${project.sessionCount}</td>
      <td class="numeric">${project.pendingQuestions}</td>
      <td>${relativeTime(project.lastActivityAt)}</td>
      <td><button type="button" class="btn btn--small" data-action="dispatch" data-project="${project.id}">下达指令</button></td>
    </tr>`;
}

function renderProjects(overview) {
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

function inboxItemHtml(item) {
  return `
    <div class="item${item.acknowledged ? ' item--acknowledged' : ''}">
      <div class="item__head">
        <span class="tag tag--${item.severity}">${SEVERITY_LABEL[item.severity] ?? item.severity}</span>
        <span class="tag">${KIND_LABEL[item.kind] ?? item.kind}</span>
        <span class="item__title">${escapeHtml(item.title)}</span>
        <span class="item__meta">${escapeHtml(item.projectName)} · ${relativeTime(item.createdAt)}</span>
      </div>
      <p class="item__body">${escapeHtml(item.body)}</p>
      <div class="item__actions">${itemActionsHtml(item)}</div>
    </div>`;
}

function renderInbox() {
  const list = el('inbox-list');
  const projects = state.overview?.projects ?? [];

  const filterOptions = projects
    .map((project) => `<option value="${project.id}">${escapeHtml(project.name)}</option>`)
    .join('');
  const filter = el('inbox-filter');
  const currentFilter = filter.value;
  filter.innerHTML = `<option value="">全部项目</option>${filterOptions}`;
  filter.value = currentFilter;

  const items = state.inbox.filter((item) => {
    if (state.filterProject && String(item.projectId) !== state.filterProject) return false;
    if (state.pendingOnly && item.acknowledged) return false;
    return true;
  });

  el('inbox-count').textContent = items.length ? `${items.length} 项` : '';

  if (state.error && !state.inbox.length) {
    list.innerHTML = '<div class="state state--error">收件箱读取失败，请刷新重试。</div>';
    return;
  }
  if (!items.length) {
    list.innerHTML = '<div class="empty">没有待处理事项。</div>';
    return;
  }
  list.innerHTML = items.map(inboxItemHtml).join('');
}

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

function renderProject() {
  const detail = state.project;
  if (!detail) {
    el('org-tree').innerHTML = '<div class="state">正在加载项目详情…</div>';
    return;
  }

  const project = detail.project;
  el('project-title').textContent = project.name;
  el('project-path').textContent = project.path;

  const sessions = countTreeNodes(detail.orgTree);
  el('project-kpi').innerHTML = [
    { label: '状态', value: HEALTH_LABEL[project.health] ?? project.health, tone: '' },
    { label: '会话', value: project.sessionCount, tone: '' },
    { label: '待决策', value: project.pendingQuestions, tone: 'kpi--warning' },
    { label: '异常会话', value: project.erroredSessions, tone: 'kpi--danger' },
  ]
    .map(
      (kpi) => `<div class="kpi ${kpi.tone}">
        <p class="kpi__label">${kpi.label}</p>
        <p class="kpi__value">${escapeHtml(kpi.value)}</p>
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
              <span class="tag ${goal.status === 'active' ? 'tag--done' : ''}">${escapeHtml(goal.status)}</span>
              <span class="item__title">${escapeHtml(goal.objective)}</span>
            </div>
            <p class="item__meta">${goal.tokensUsed} tokens · ${Math.round((goal.timeUsedSeconds ?? 0) / 60)} 分钟</p>
          </div>`,
        )
        .join('')
    : '<div class="empty">该项目没有进行中的 Goal。</div>';

  const planTasks = detail.plan?.tasks ?? [];
  el('plan-count').textContent = planTasks.length
    ? `${planTasks.length} 个任务${planAgeLabel(detail.project.planUpdatedAt)}`
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
              <span class="tag ${question.status === 'pending' ? 'tag--high' : 'tag--done'}">${escapeHtml(question.status)}</span>
              <span class="item__title">${escapeHtml(question.sessionTitle ?? question.sessionId)}</span>
            </div>
            <p class="item__body mono">${escapeHtml(question.id)}</p>
          </div>`,
        )
        .join('')
    : '<div class="empty">该项目没有待答问题。</div>';
}

function countTreeNodes(nodes) {
  return (nodes ?? []).reduce((total, node) => total + 1 + countTreeNodes(node.children), 0);
}

function renderSkills() {
  const scan = state.skills;
  const nav = el('domain-nav');
  const list = el('skill-list');

  if (!scan) {
    list.innerHTML = '<div class="state">正在加载能力库…</div>';
    return;
  }

  el('skills-count').textContent = `${scan.total} 个技能 · ${scan.unmapped.length} 个未归类`
    + (scan.failures ? ` · ${scan.failures} 个目录扫描失败` : '');

  const domains = [
    ...scan.groups.map((group) => ({ key: group.key, label: group.label, count: group.skills.length, skills: group.skills })),
    { key: '__unmapped', label: '未归类', count: scan.unmapped.length, skills: scan.unmapped },
  ];

  if (!state.domain || !domains.some((domain) => domain.key === state.domain)) {
    state.domain = domains[0]?.key ?? null;
  }

  nav.innerHTML = domains
    .map(
      (domain) => `<button type="button" data-domain="${escapeHtml(domain.key)}" aria-pressed="${domain.key === state.domain}">
        <span>${escapeHtml(domain.label)}</span><span class="count">${domain.count}</span>
      </button>`,
    )
    .join('');

  const current = domains.find((domain) => domain.key === state.domain);
  if (!current) {
    list.innerHTML = '<div class="empty">没有可显示的技能。</div>';
    return;
  }
  list.innerHTML = current.skills.length
    ? current.skills
        .map(
          (skill) => `<div class="skill-row">
            <span class="skill-row__name">${escapeHtml(skill.name)}</span>
            ${skill.description ? `<span class="skill-row__desc">${escapeHtml(skill.description)}</span>` : ''}
            <span class="item__meta mono">${escapeHtml(skill.path)}</span>
          </div>`,
        )
        .join('')
    : '<div class="empty">该领域下没有技能。</div>';
}

/* ------------------------------------------------------------------ router */

const VIEWS = {
  overview: 'view-overview',
  inbox: 'view-inbox',
  project: 'view-project',
  skills: 'view-skills',
};

function currentRoute() {
  const hash = window.location.hash.replace(/^#\/?/, '');
  const [name, param] = hash.split('/');
  if (name === 'project' && param) return { name: 'project', param: Number(param) };
  if (VIEWS[name]) return { name, param: null };

  // Deep link: /?project=5 opens one project directly. The Host's open API cannot carry a
  // fragment, so a query parameter is the way to hand the board a specific project.
  const deepLink = new URLSearchParams(window.location.search).get('project');
  if (deepLink && Number.isFinite(Number(deepLink))) {
    return { name: 'project', param: Number(deepLink) };
  }
  return { name: 'overview', param: null };
}

function showView(name) {
  for (const [key, id] of Object.entries(VIEWS)) {
    el(id).hidden = key !== name;
  }
  for (const link of document.querySelectorAll('[data-nav]')) {
    if (link.dataset.nav === name) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

async function renderRoute() {
  const route = currentRoute();
  showView(route.name);

  if (route.name !== 'project') {
    // Leaving the project view drops its cached detail, so coming back always re-fetches
    // instead of showing a stale team tree.
    state.projectId = null;
    state.project = null;
  }

  // The overview feeds the KPI, the badge and the project lookup used by the dispatch
  // dialog, so it is loaded on every route — not only on the overview.
  const overviewPromise = state.overview ? Promise.resolve() : refresh();

  if (route.name === 'project') {
    if (state.projectId !== route.param) {
      state.projectId = route.param;
      state.project = null;
      el('org-tree').innerHTML = '<div class="state"><span class="spinner" aria-hidden="true"></span>正在加载项目详情…</div>';
      try {
        state.project = await request(API.project(route.param));
      } catch (error) {
        el('org-tree').innerHTML = `<div class="state state--error">${escapeHtml(error.message)}</div>`;
        await overviewPromise;
        return;
      }
    }
    renderProject();
    await overviewPromise;
    return;
  }

  if (route.name === 'skills') {
    if (!state.skills) {
      try {
        state.skills = await request(API.skills);
      } catch (error) {
        el('skill-list').innerHTML = `<div class="state state--error">${escapeHtml(error.message)}</div>`;
        await overviewPromise;
        return;
      }
    }
    renderSkills();
    await overviewPromise;
    return;
  }

  await overviewPromise;
}

async function refresh() {
  state.loading = true;
  try {
    const [overview, inbox] = await Promise.all([request(API.overview), request(API.inbox)]);
    state.overview = overview;
    state.inbox = inbox.items ?? [];
    state.error = null;
    renderWarning(overview.dataWarning);
    if (overviewChanged(overview)) {
      renderKpi(overview);
      renderAttention(overview);
      renderProjects(overview);
    }
    if (inboxChanged(state.inbox)) renderInbox();
    setStatus('实时同步中', 'live');
  } catch (error) {
    state.error = error.message;
    renderWarning(`读取运行时状态失败：${error.message}`);
    renderAttention(state.overview);
    renderProjects(state.overview);
    renderInbox();
    setStatus('连接异常', 'error');
  } finally {
    state.loading = false;
  }
}

/* ------------------------------------------------------------------- SSE */

let eventSource = null;

function connectStream() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource(API.stream);

  eventSource.addEventListener('snapshot', (event) => {
    state.overview = JSON.parse(event.data);
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
    if (payload.delivered) toast('指令已投递给目标会话');
    else toast(`派工未完成：${payload.error || '大哥未确认投递'}`, 'error');
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

  eventSource.onerror = () => {
    setStatus('正在重连…', 'idle');
  };
}

async function refreshInbox() {
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
async function refreshProjectIfVisible() {
  const route = currentRoute();
  if (route.name !== 'project') return;
  try {
    state.project = await request(API.project(route.param));
    renderProject();
  } catch {
    // Keep the last good view rather than blanking the page.
  }
}

/* --------------------------------------------------------------- dispatch */

/**
 * Resolve a project by id.
 *
 * The overview list is the usual source, but a deep link straight to a project
 * (`/?project=32`) never loads the overview — the loaded project detail is the fallback.
 */
function findProject(projectId) {
  const fromOverview = (state.overview?.projects ?? []).find((item) => item.id === projectId);
  if (fromOverview) return fromOverview;
  if (state.project && state.project.project?.id === projectId) return state.project.project;
  return null;
}

/**
 * Open the dispatch dialog, aimed at a specific project and optionally a specific session.
 *
 * @param {number} projectId
 * @param {{ sessionId?: string|null, instruction?: string }} [options]
 */
function openDispatchDialog(projectId, options = {}) {
  const project = findProject(projectId);
  if (!project) {
    toast('找不到该项目', 'error');
    return;
  }

  // Remember the target here. It must not be derived from the current route: doing so
  // silently sends the instruction to whichever project was opened last.
  state.dispatchTarget = { projectId: project.id, sessionId: options.sessionId ?? null };

  el('dispatch-target').textContent = `目标项目：${project.name}（${project.path}）`;
  el('dispatch-error').hidden = true;
  el('dispatch-instruction').value = options.instruction ?? '';

  const sessionSelect = el('dispatch-session');
  const sessions = state.project && state.projectId === project.id
    ? collectSessions(state.project.orgTree)
    : [];
  sessionSelect.innerHTML =
    '<option value="">由大哥自行选择</option>' +
    sessions
      .map((session) => `<option value="${escapeHtml(session.id)}">${escapeHtml(session.title)} · ${escapeHtml(session.agentName)}</option>`)
      .join('');
  sessionSelect.value = state.dispatchTarget.sessionId ?? '';

  const dialog = el('dispatch-dialog');
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
  el('dispatch-instruction').focus();
}

function collectSessions(nodes, collected = []) {
  for (const node of nodes ?? []) {
    collected.push(node);
    collectSessions(node.children, collected);
  }
  return collected;
}

async function submitDispatch(event) {
  event.preventDefault();

  const instruction = el('dispatch-instruction').value.trim();
  const target = state.dispatchTarget;

  if (!target.projectId) {
    showDispatchError('没有确定目标项目，请重新选择');
    return;
  }
  if (!instruction) {
    showDispatchError('指令内容不能为空');
    return;
  }

  const submit = el('dispatch-submit');
  submit.disabled = true;
  submit.textContent = '下达中…';

  try {
    await request(API.dispatch, {
      method: 'POST',
      body: JSON.stringify({
        projectId: target.projectId,
        sessionId: el('dispatch-session').value || target.sessionId || null,
        instruction,
        idempotencyKey: crypto.randomUUID(),
      }),
    });
    el('dispatch-dialog').close();
    toast('指令已交给大哥，正在投递');
  } catch (error) {
    showDispatchError(error.message);
  } finally {
    submit.disabled = false;
    submit.textContent = '下达';
  }
}

function showDispatchError(message) {
  const node = el('dispatch-error');
  node.hidden = false;
  node.textContent = message;
}


/* ---------------------------------------------------------------- actions */

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

el('inbox-pending-only').addEventListener('change', (event) => {
  state.pendingOnly = event.target.checked;
  renderInbox();
});

el('refresh-button').addEventListener('click', () => {
  void refresh();
});

/* --------------------------------------------------------------- patrol */

async function loadPatrolConfig() {
  try {
    const payload = await request(API.patrol);
    el('patrol-enabled').checked = Boolean(payload.config?.enabled);
    el('patrol-autodispatch').checked = Boolean(payload.config?.autoDispatch);
  } catch {
    // The patrol is optional; a board without it still works.
  }
}

async function savePatrolConfig() {
  try {
    await request(API.patrolConfig, {
      method: 'POST',
      body: JSON.stringify({
        enabled: el('patrol-enabled').checked,
        autoDispatch: el('patrol-autodispatch').checked,
      }),
    });
    toast('巡检设置已保存');
  } catch (error) {
    toast(error.message, 'error');
  }
}

el('patrol-enabled').addEventListener('change', () => {
  void savePatrolConfig();
});

el('patrol-autodispatch').addEventListener('change', () => {
  void savePatrolConfig();
});

el('patrol-run-button').addEventListener('click', () => {
  const button = el('patrol-run-button');
  button.disabled = true;
  button.textContent = '巡检中…';
  request(API.patrolRun, { method: 'POST' })
    .then((outcome) => {
      toast(outcome.error ? `巡检失败：${outcome.error}` : '巡检完成');
      void refresh();
    })
    .catch((error) => toast(error.message, 'error'))
    .finally(() => {
      button.disabled = false;
      button.textContent = '巡检';
    });
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

setStatus('正在连接…', 'idle');
void renderRoute();
void loadPatrolConfig();
connectStream();
