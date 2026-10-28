/**
 * 页面框架。
 *
 * 侧栏的连接状态、顶栏的区块名、值班灯与全局告警条——它们不属于任何一个视图，
 * 但每个视图都会更新它们，所以住在框架层。
 */

import { el } from '../shared/dom.js';
import { relativeTime, HEALTH_LABEL } from '../shared/format.js';
import { state } from '../shared/state.js';

/**
 * The connection state in the sidebar.
 *
 * @param {string} text
 * @param {string} [status]
 */
export function setStatus(text, status = 'idle') {
  const node = el('app-status');
  node.textContent = text;
  node.dataset.state = status;
}

/**
 * The warning bar above the views.
 *
 * @param {string} message
 */
export function renderWarning(message) {
  const node = el('data-warning');
  if (!message) {
    node.hidden = true;
    node.textContent = '';
    return;
  }
  node.hidden = false;
  node.textContent = message;
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
export function setDutyLamp(lamp) {
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
export function currentDutyLamp() {
  if (state.duty === null) return null;
  // A boss that was told to rest is not an outage. The stamp goes stale for a sleeping
  // boss exactly as it would for a dead one — that is the price of an explicit rest, and
  // the lamp must not cry wolf over it.
  if (state.duty.mode === 'resting') return 'resting';
  return state.duty.stale ? 'stale' : 'live';
}

/**
 * Show whether the boss is on duty.
 *
 * The boss runs on its own schedule, so the board has to make its state visible: a stale
 * "last patrol" is the difference between "nothing is wrong" and "nobody is watching".
 * A boss that has gone quiet is therefore announced in words, not left to be inferred
 * from a timestamp nobody reads twice.
 *
 * @param {any} duty
 */
export function renderDutyStatus(duty) {
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

  if (duty.mode === 'resting') {
    // Resting is a decision with a reason, not a missing handover. Saying 「可能掉线」
    // here would be a false alarm about a boss that is asleep on purpose and wakes the
    // moment it is summoned.
    const seen = duty.neverRan ? '' : ` · 上次巡检 ${since}`;
    node.textContent = `大哥休息中 · 召唤才醒${seen}${tail}`;
    node.setAttribute('data-duty-state', 'resting');
    setDutyLamp(currentDutyLamp());
    return;
  }

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
export function setHeader(title, context) {
  el('view-title').textContent = title;
  el('view-context').textContent = context;
}

/**
 * Refresh the header's context line for the section on screen.
 */
export function renderHeaderContext() {
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
    const library = state.skillLibrary;
    const installed = scan ? `${scan.total} 个技能 · ${scan.groups.length} 个领域` : '正在加载…';
    const packaged = library ? `已封装 ${library.stats?.active ?? 0} 个可派工` : null;
    setHeader('能力库', packaged ? `${installed} · ${packaged}` : installed);
    return;
  }
  if (view === 'alerts') {
    const alerts = state.alerts;
    setHeader(
      '看门狗告警',
      alerts === null ? '正在加载…' : (alerts.length ? `${alerts.length} 条告警` : '还没有告警'),
    );
    return;
  }
  setHeader('对话', '大哥的交班与对话');
}

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
export function applyTheme(theme) {
  if (theme !== 'light' && theme !== 'dark') return false;
  document.documentElement.setAttribute('data-theme', theme);
  return true;
}
