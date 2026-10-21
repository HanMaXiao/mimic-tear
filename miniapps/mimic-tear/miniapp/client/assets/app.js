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
  chat: '/api/chat',
  chatAnswer: '/api/chat/answer',
  chatSession: '/api/chat/session',
  chatDuty: '/api/chat/duty',
  chatHistory: '/api/chat/history',
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
  filterKind: '',
  pendingOnly: true,
  loading: false,
  error: null,
  // The route currently on screen. The header names the section, so the client has to
  // know where it is without re-reading the URL on every repaint.
  view: 'chat',
  // The board's last word on the duty boss. The lamp in the header is driven by it.
  duty: null,
  // The project and session the dispatch dialog is currently aimed at. The dialog must
  // remember its own target: deriving it from the current route silently sends the
  // instruction to whichever project was opened last.
  dispatchTarget: { projectId: null, sessionId: null },
  // The conversation with the boss. `messages` is the transcript; `streaming` is the reply
  // being written right now; `question` is the questionnaire the boss is waiting on.
  // `bossSessionId` is the boss's own session, needed to open the same conversation in the
  // Host's chat side panel.
  //
  // `transcript` is the authoritative list, read back from the runtime session. The Host
  // chat side panel writes to the same session, so the transcript is what keeps the two
  // views in step — and what makes the conversation survive a page reload.
  chat: {
    messages: [],
    streaming: null,
    tools: [],
    question: null,
    answers: {},
    bossSessionId: null,
    duty: [],
    transcript: [],
  },
};

const el = (id) => document.getElementById(id);

/**
 * Add or remove one class.
 *
 * The class list is edited as a string rather than through `classList`, because the DOM
 * shim the client tests run against has a plain `className` and no `classList` — this
 * works the same in both.
 *
 * @param {any} node
 * @param {string} name
 * @param {boolean} on
 */
function setClass(node, name, on) {
  const classes = new Set(String(node.className || '').split(/\s+/).filter(Boolean));
  if (on) classes.add(name);
  else classes.delete(name);
  node.className = [...classes].join(' ');
}

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

/** The runtime speaks in raw states; the board speaks in words. */
const GOAL_STATUS_LABEL = { active: '进行中', paused: '已暂停', done: '已完成', failed: '失败', unknown: '未知' };

const QUESTION_STATUS_LABEL = { pending: '待答', answered: '已答', dismissed: '已忽略', unknown: '未知' };

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
 * The action buttons of an inbox item.
 *
 * A patrol finding may not resolve to a project (the boss named a project that is not on
 * the board), so it gets no dispatch button — a button with project 0 would only produce
 * a confusing 404.
 */
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
function acknowledgedNoteHtml(item) {
  if (!item?.acknowledged) return '';
  if (item.handledBy === 'boss') {
    return `<p class="item__note">大哥已处理：${escapeHtml(item.handledReason || '这条已不适用')}</p>`;
  }
  return '<p class="item__note">你已标记已知</p>';
}

function itemActionsHtml(item) {
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
 * Answer a pending question with the boss's decision.
 *
 * The board asks the Host to answer the questionnaire on the blocked session. If the Host
 * will not answer a session this Mini App does not own, the decision is delivered as a
 * message instead, so the answer still reaches the project lead.
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

function attentionItemHtml(item) {
  const card = questionnaireCardText(item);
  return `
    <div class="item item--${escapeHtml(item.severity)}${item.acknowledged ? ' item--acknowledged' : ''}">
      <div class="item__head">
        <span class="tag tag--${item.severity}">${SEVERITY_LABEL[item.severity] ?? item.severity}</span>
        <span class="tag">${KIND_LABEL[item.kind] ?? item.kind}</span>
        <span class="item__title">${escapeHtml(item.title)}</span>
        <span class="item__meta">${escapeHtml(item.projectName)} · ${waitingLabel(item.createdAt)}${requestIdMark(item)}</span>
      </div>
      <p class="item__body doc">${escapeHtml(card.text)}</p>
      ${card.extra > 0 ? `<p class="item__note">另有 ${card.extra} 问 · 去回答会带上全文</p>` : ''}
      ${acknowledgedNoteHtml(item)}
      <div class="item__actions">${itemActionsHtml(item)}</div>
    </div>`;
}

function renderAttention(overview) {
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
 * The duty lamp.
 *
 * The board's own mark, filled while the boss is watching. The rail carries the same drop
 * as the product's name; this one is the pulse, and it is the only coloured thing in the
 * header — so a glance at the top of the window answers the question the board exists to
 * answer: is anybody actually on duty?
 *
 * @param {'live'|'stale'|'off'|null} lamp
 */
function setDutyLamp(lamp) {
  const root = document.documentElement;
  if (!root || typeof root.setAttribute !== 'function') return;
  if (lamp) root.setAttribute('data-duty', lamp);
  else root.removeAttribute('data-duty');
}

/**
 * What the lamp should show.
 *
 * The lamp is a duty signal, so it follows the duty facts and nothing else. The
 * 「大哥在岗」 switch is *not* the source: `enabled` only gates the board's own patrol
 * loop, while the duty handover stamp (`lastRunAt`) is written by the duty cron alone
 * and keeps moving whether the switch is on or off. Driving the lamp from the switch
 * would make it contradict the sentence right next to it.
 *
 * @returns {'live'|'stale'|null} `null` means the board has no duty facts yet.
 */
function currentDutyLamp() {
  if (state.duty === null) return null;
  return state.duty.stale ? 'stale' : 'live';
}

/**
 * Show whether the boss is on duty.
 *
 * The boss runs on its own schedule, so the board has to make its state visible: a stale
 * "last patrol" is the difference between "nothing is wrong" and "nobody is watching".
 * A boss that has gone quiet is therefore announced in words, not left to be inferred
 * from a timestamp nobody reads twice.
 */
function renderDutyStatus(duty) {
  const node = el('duty-status');
  state.duty = duty ?? null;

  if (!duty) {
    node.textContent = '';
    node.removeAttribute('data-duty-state');
    setDutyLamp(currentDutyLamp());
    return;
  }
  const since = duty.lastRunAt ? relativeTime(duty.lastRunAt) : '尚未巡检';
  const open = duty.openFindings ?? 0;
  const withdrawn = duty.withdrawn ?? 0;
  const tail = (open > 0 ? ` · ${open} 条结论待你过目` : '')
    + (withdrawn > 0 ? ` · ${withdrawn} 条已由大哥撤回` : '');

  if (duty.stale) {
    node.textContent = duty.neverRan
      ? `大哥尚未巡检 · 值班可能没启动${tail}`
      : `大哥可能掉线 · 上次巡检 ${since}${tail}`;
    node.setAttribute('data-duty-state', 'stale');
    setDutyLamp(currentDutyLamp());
    return;
  }

  node.removeAttribute('data-duty-state');
  node.textContent = `大哥值班中 · 上次巡检 ${since}${tail}`;
  setDutyLamp(currentDutyLamp());
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
      <td class="nowrap">${activeGoals} 个进行中 / ${(project.goals ?? []).length} 个</td>
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
function requestIdMark(item) {
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
function questionnaireCardText(item) {
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

function inboxItemHtml(item) {
  const card = questionnaireCardText(item);
  return `
    <div class="item item--${escapeHtml(item.severity)}${item.acknowledged ? ' item--acknowledged' : ''}">
      <div class="item__head">
        <span class="tag">${KIND_LABEL[item.kind] ?? item.kind}</span>
        <span class="item__title">${escapeHtml(item.title)}</span>
        <span class="item__meta">${escapeHtml(item.projectName)} · ${relativeTime(item.createdAt)}${requestIdMark(item)}</span>
      </div>
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
function inboxGroupsHtml(items) {
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
  renderHeaderContext();
}

/* -------------------------------------------------------------------- chat */

/**
 * The duty rounds, rendered as the boss's own reports.
 *
 * The duty boss runs on its own cron session, so the Host chat side panel (one session)
 * never shows the rounds. The rounds are the user seeing the boss walk between projects,
 * so they belong here too — as reports, not as chat messages: a duty round is something
 * the boss did on its own, and it must not look like something it said to you.
 *
 * The newest round is open; the older ones are collapsed to a one-line summary. The
 * conversation is the main surface, and the rounds are a standing record beside it: left
 * fully expanded they push the user's own messages and the boss's replies off the screen,
 * which is the opposite of what this panel is for.
 *
 * @param {Array<{startedAt:number, findings:Array<{id:string,severity:string,title:string,
 *                projectName:string|null,acknowledged:boolean,acknowledgedBy:string|null}>,
 *                counts:{high:number,medium:number,low:number}}>} rounds
 * @returns {string}
 */
function dutyRoundsHtml(rounds) {
  if (!rounds || !rounds.length) return '';
  const items = rounds.map((round, index) => {
    const parts = [];
    if (round.counts.high) parts.push(`${round.counts.high} 项高`);
    if (round.counts.medium) parts.push(`${round.counts.medium} 项中`);
    if (round.counts.low) parts.push(`${round.counts.low} 项低`);
    const lines = round.findings.map((f) => `
      <li class="chat__duty-item chat__duty-item--${escapeHtml(f.severity)}">
        <span class="chat__duty-title">${escapeHtml(f.title)}</span>
        ${f.projectName ? `<span class="chat__duty-project">${escapeHtml(f.projectName)}</span>` : ''}
        ${f.acknowledgedBy === 'boss' ? '<span class="chat__duty-tag">已撤回</span>' : ''}
      </li>`).join('');
    const summary = `
      <span class="chat__duty-when">${escapeHtml(dutyRoundTime(round.startedAt))}</span>
      <span class="chat__duty-counts">交班 ${parts.join(' / ') || '无结论'}</span>`;
    // `details`/`summary` is native: it is keyboard reachable, screen-reader friendly and
    // needs no JavaScript to work.
    return `
      <details class="chat__duty-round"${index === 0 ? ' open' : ''}>
        <summary class="chat__duty-head">${summary}</summary>
        <ul class="chat__duty-list">${lines}</ul>
      </details>`;
  }).join('');
  return `<div class="chat__duty-label">大哥的值班交班</div>${items}`;
}

/**
 * Format a round's start time as "今天 21:07" or "昨天 21:07".
 *
 * @param {number} ms
 * @returns {string}
 */
function dutyRoundTime(ms) {
  const date = new Date(Number(ms) || 0);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const yesterday = new Date(now.getTime() - 86400_000).toDateString() === date.toDateString();
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  if (sameDay) return `今天 ${time}`;
  if (yesterday) return `昨天 ${time}`;
  return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
}

/**
 * One line of the conversation.
 *
 * @param {{role:'user'|'boss', text:string, tools?:Array<{name:string, ok?:boolean|null}>}} message
 * @returns {string}
 */
function chatMessageHtml(message) {
  const mine = message.role === 'user';
  const tools = (message.tools ?? [])
    .map((tool) => `<span class="chat__tool${tool.ok === false ? ' chat__tool--failed' : ''}">${escapeHtml(tool.name)}</span>`)
    .join('');
  return `
    <article class="chat__msg chat__msg--${mine ? 'me' : 'boss'}${message.fromHost ? ' chat__msg--host' : ''}">
      <span class="chat__who">${mine ? '你' : '大哥'}${message.fromHost ? '<span class="chat__from-host">侧栏</span>' : ''}</span>
      <div class="chat__bubble">${escapeHtml(message.text || '').replace(/\n/g, '<br />')}</div>
      ${tools ? `<div class="chat__tools">${tools}</div>` : ''}
    </article>`;
}

/**
 * The questionnaire the boss paused on.
 *
 * The boss can only be unblocked by the person who owns the session, so this has to be
 * answerable right here in the conversation.
 *
 * @returns {string}
 */
function chatQuestionHtml() {
  const question = state.chat.question;
  if (!question) return '';
  const steps = (question.request?.steps ?? []).map((step) => {
    const answer = state.chat.answers[step.id] ?? { selectedOptionIds: [] };
    const options = (step.options ?? []).map((option) => {
      const on = answer.selectedOptionIds.includes(option.id);
      return `<button type="button" class="chat__option${on ? ' chat__option--on' : ''}" data-action="chat-option" data-step="${escapeHtml(step.id)}" data-option="${escapeHtml(option.id)}">${escapeHtml(option.label)}</button>`;
    }).join('');
    return `
      <div class="chat__step">
        <p class="chat__question">${escapeHtml(step.question)}</p>
        <div class="chat__options">${options}</div>
      </div>`;
  }).join('');
  return `
    <div class="chat__ask">
      <p class="chat__ask-title">${escapeHtml(question.request?.title ?? '大哥需要你确认一件事')}</p>
      ${steps}
      <button type="button" class="btn" data-action="chat-answer">提交回答</button>
    </div>`;
}

/**
 * Pick (or un-pick) one option of the questionnaire the boss is waiting on.
 *
 * @param {string} stepId
 * @param {string} optionId
 */
function selectChatOption(stepId, optionId) {
  const step = (state.chat.question?.request?.steps ?? []).find((entry) => entry.id === stepId);
  if (!step) return;
  const picked = state.chat.answers[stepId] ?? { selectedOptionIds: [] };
  const single = step.selectionMode !== 'multiple';
  const selectedOptionIds = single
    ? (picked.selectedOptionIds.includes(optionId) ? [] : [optionId])
    : (picked.selectedOptionIds.includes(optionId)
      ? picked.selectedOptionIds.filter((id) => id !== optionId)
      : [...picked.selectedOptionIds, optionId]);
  state.chat.answers = { ...state.chat.answers, [stepId]: { selectedOptionIds } };
  renderChat();
}

function renderChat() {
  const log = el('chat-log');
  if (!log) return;
  const { streaming } = state.chat;
  // The transcript from the runtime session is the truth: the Host chat side panel writes
  // to the same session, so anything said there belongs in this list. The locally-held
  // `messages` are the optimistic bubbles (a message you just sent, shown before the
  // runtime has committed it) and are drawn on top.
  const transcript = state.chat.transcript.map((m) => ({
    role: m.role === 'user' ? 'user' : 'boss',
    text: m.text,
    fromHost: m.source === 'communication',
  }));
  // The optimistic bubbles may still be around when the transcript already contains the
  // same lines (the runtime commits a turn a moment after it finishes). Showing both would
  // double every line, so a local bubble whose text is already in the transcript is dropped.
  const inTranscript = new Set(transcript.map((m) => `${m.role} ${m.text}`));
  const local = state.chat.messages.filter((m) => !inTranscript.has(`${m.role} ${m.text ?? ''}`));
  const shown = [...transcript, ...local];
  let html;
  if (!shown.length) {
    html = `
      <div class="chat__intro">
        <p>大哥在。</p>
        <p class="chat__intro-hint">告诉他哪个项目有什么需求、要盯紧谁、什么时候开始、什么时候停。他做的事会直接出现在这里——他在哪个项目上动了什么、给谁派了工。</p>
      </div>`;
  } else {
    html = shown.map(chatMessageHtml).join('');
  }
  // The tools show up while the turn is still running: "seeing what the boss is doing"
  // means seeing it now, not after it finishes. A tool call can also arrive before the
  // first words, so the block is shown whenever the turn is still in flight.
  const inTurn = streaming !== null || state.chat.tools.length > 0;
  if (inTurn) {
    const tools = state.chat.tools
      .map((tool) => `<span class="chat__tool${tool.ok === false ? ' chat__tool--failed' : ''}">${escapeHtml(tool.name)}</span>`)
      .join('');
    html += `
      <article class="chat__msg chat__msg--boss chat__msg--streaming">
        <span class="chat__who">大哥</span>
        ${streaming !== null ? `<div class="chat__bubble">${escapeHtml(streaming).replace(/\n/g, '<br />')}</div>` : ''}
        ${tools ? `<div class="chat__tools">${tools}</div>` : ''}
      </article>`;
  }
  html += chatQuestionHtml();
  log.innerHTML = html;
  log.scrollTop = log.scrollHeight;

  // The duty rounds live above the conversation: they are the boss's own reports, and
  // they happened whether or not anyone was talking to it.
  const duty = el('chat-duty');
  if (duty) duty.innerHTML = dutyRoundsHtml(state.chat.duty);
}

/**
 * Load the conversation from the runtime session.
 *
 * The transcript is the Host's. The side panel and this page show the same session, so
 * reading it back is what keeps the two views in step — and what makes the conversation
 * survive a reload.
 *
 * @param {{ keepLocal?: boolean }} [options] `keepLocal` leaves the optimistic bubbles in
 *   place — used right after a turn ends, while the runtime may not have committed the
 *   exchange yet.
 */
async function loadChatHistory(options = {}) {
  try {
    const payload = await request(API.chatHistory);
    state.chat.transcript = Array.isArray(payload?.messages) ? payload.messages : [];
    // The runtime now holds the committed exchange, so the optimistic bubbles have served
    // their purpose — keeping them would show every line twice.
    if (!options.keepLocal) state.chat.messages = [];
  } catch {
    state.chat.transcript = [];
  }
  renderChat();
}

/**
 * Load the duty rounds.
 *
 * A failure here must not take the conversation down: the rounds are an extra view of
 * the boss's work, and losing them is much less bad than losing the ability to talk.
 */
async function loadDutyRounds() {
  try {
    const payload = await request(API.chatDuty);
    state.chat.duty = Array.isArray(payload?.rounds) ? payload.rounds : [];
  } catch {
    state.chat.duty = [];
  }
  renderChat();
}

/**
 * Send a message to the boss.
 *
 * The turn runs on the server, so the reply arrives over SSE rather than in the response.
 *
 * @param {string} text
 */
async function sendChat(text) {
  const message = String(text ?? '').trim();
  if (!message) return;
  state.chat.messages.push({ role: 'user', text: message });
  state.chat.streaming = '';
  state.chat.tools = [];
  renderChat();
  try {
    const payload = await request(API.chat, { method: 'POST', body: JSON.stringify({ text: message }) });
    // The acknowledgement carries the boss's session id, so the side-panel button works even
    // before the first reply arrives.
    if (payload?.bossSessionId) state.chat.bossSessionId = payload.bossSessionId;
  } catch (error) {
    state.chat.streaming = null;
    state.chat.messages.push({ role: 'boss', text: `（消息没送到大哥：${error.message}）` });
    renderChat();
  }
}

/**
 * Record one tool call the boss made during the turn.
 *
 * @param {{name:string, phase:string, ok?:boolean}} payload
 */
function recordChatTool(payload) {
  const tools = state.chat.tools;
  if (payload.phase === 'started') {
    tools.push({ name: payload.name || '工具', ok: null });
    return;
  }
  const last = tools.at(-1);
  if (last && last.name === (payload.name || '工具')) last.ok = payload.ok !== false;
  else tools.push({ name: payload.name || '工具', ok: payload.ok !== false });
  renderChat();
}

/**
 * Answer the questionnaire the boss paused on.
 */
async function submitChatAnswer() {
  const question = state.chat.question;
  if (!question) return;
  const answers = (question.request?.steps ?? []).map((step) => {
    const picked = state.chat.answers[step.id] ?? { selectedOptionIds: [] };
    return {
      stepId: step.id,
      selectedOptionIds: picked.selectedOptionIds ?? [],
      selectedOther: false,
    };
  });
  state.chat.question = null;
  state.chat.answers = {};
  renderChat();
  try {
    await request(API.chatAnswer, {
      method: 'POST',
      body: JSON.stringify({ requestId: question.requestId, answers }),
    });
  } catch (error) {
    state.chat.messages.push({ role: 'boss', text: `（回答没送到大哥：${error.message}）` });
    renderChat();
  }
}

/* ------------------------------------------------------------------ host panel */

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
 */
async function openBossInHostPanel() {
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

/* ------------------------------------------------------------------ router */

const VIEWS = {
  chat: 'view-chat',
  overview: 'view-overview',
  inbox: 'view-inbox',
  project: 'view-project',
  skills: 'view-skills',
};

/**
 * Name the section in the header, and say what is in it.
 *
 * The header used to be an empty strip with three buttons on it, so the board never told
 * you where you were. It now carries the section's name and one fact about it — the count
 * you would otherwise have to go and find.
 *
 * @param {string} title
 * @param {string} context
 */
function setHeader(title, context) {
  el('view-title').textContent = title;
  el('view-context').textContent = context;
}

/**
 * Refresh the header's context line for the section on screen.
 */
function renderHeaderContext() {
  const view = state.view;
  if (view === 'project') {
    const detail = state.project;
    if (!detail) {
      setHeader('项目详情', '正在加载…');
      return;
    }
    const project = detail.project;
    // The project keeps its own name on the page; the header names the section, so the
    // two never say the same thing twice.
    setHeader(
      '项目详情',
      `${HEALTH_LABEL[project.health] ?? project.health} · ${project.sessionCount} 个会话 · ${project.pendingQuestions} 项待决策`,
    );
    return;
  }
  if (view === 'overview') {
    const kpi = state.overview?.kpi;
    setHeader('总览', kpi ? `${kpi.projects} 个项目 · ${kpi.active} 个在推进` : '正在加载…');
    return;
  }
  if (view === 'inbox') {
    const pending = (state.inbox ?? []).filter((item) => !item.acknowledged).length;
    setHeader('决策收件箱', `${pending} 项待你处理`);
    return;
  }
  if (view === 'skills') {
    const scan = state.skills;
    setHeader('能力库', scan ? `${scan.total} 个技能 · ${scan.groups.length} 个领域` : '正在加载…');
    return;
  }
  setHeader('对话', '大哥的交班与对话');
}

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
  // The board opens on the conversation: the boss is the product, the dashboards are
  // what he reports on.
  return { name: 'chat', param: null };
}

function showView(name) {
  for (const [key, id] of Object.entries(VIEWS)) {
    el(id).hidden = key !== name;
  }
  for (const link of document.querySelectorAll('[data-nav]')) {
    if (link.dataset.nav === name) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  state.view = name;
  renderHeaderContext();
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
    // The duty state is the one thing the header shows on every section, so it is read
    // from the snapshot on its own — it must not wait for the rest of the board to change.
    renderDutyStatus(overview.duty);
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
});

/* --------------------------------------------------------------- patrol */

async function loadPatrolConfig() {
  try {
    const payload = await request(API.patrol);
    el('patrol-enabled').checked = Boolean(payload.config?.enabled);
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

/**
 * Apply an explicit theme override.
 *
 * The stylesheet ships a `[data-theme='light']` hook, but nothing could ever reach it:
 * the board simply followed the operating system. A `?theme=light|dark` parameter makes
 * that hook reachable — and it is also the only way to *look at* the light theme, since
 * the operating system's colour scheme is not something the app can change.
 *
 * @param {string|null} theme
 * @returns {boolean} whether a theme was applied
 */
function applyTheme(theme) {
  if (theme !== 'light' && theme !== 'dark') return false;
  document.documentElement.setAttribute('data-theme', theme);
  return true;
}

applyTheme(new URLSearchParams(window.location.search).get('theme'));

setStatus('正在连接…', 'idle');
renderChat();
void renderRoute();
void loadPatrolConfig();
void loadDutyRounds();
void loadChatHistory();
connectStream();
