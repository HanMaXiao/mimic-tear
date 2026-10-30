/**
 * 路由。
 *
 * hash 路由：URL 说清自己在哪，路由说清该画哪一块。整板刷新也在这里，因为每个视图
 * 读的都是同一份总览与收件箱。
 */

import { el } from '../shared/dom.js';
import { escapeHtml } from '../shared/format.js';
import { request } from '../shared/http.js';
import { API } from '../shared/api.js';
import { state } from '../shared/state.js';
import { overviewChanged, inboxChanged } from '../shared/signatures.js';
import { renderHeaderContext, renderDutyStatus, renderWarning, setStatus } from './frame.js';
import { renderKpi, renderAttention, renderProjects } from '../views/overview.js';
import { renderInbox } from '../views/inbox.js';
import { renderProject } from '../views/project.js';
import { renderSkills } from '../views/skills.js';
import { loadWatchdogAlerts } from '../views/alerts.js';
import { renderSessions } from '../views/sessions.js';

export const VIEWS = {
  chat: 'view-chat',
  overview: 'view-overview',
  inbox: 'view-inbox',
  project: 'view-project',
  skills: 'view-skills',
  alerts: 'view-alerts',
  sessions: 'view-sessions',
};

/**
 * Where the page is.
 *
 * @returns {{name:string, param:number|null}}
 */
export function currentRoute() {
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

/**
 * Show one view and mark the rail.
 *
 * @param {string} name
 */
export function showView(name) {
  for (const [key, id] of Object.entries(VIEWS)) {
    el(id).hidden = key !== name;
  }
  // A project dossier is opened from the ledger, so the ledger stays the marked slot:
  // otherwise the rail would look like it has no current section at all.
  const active = name === 'project' ? 'overview' : name;
  for (const link of document.querySelectorAll('[data-nav]')) {
    if (link.dataset.nav === active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  state.view = name;
  renderHeaderContext();
}

/**
 * Draw whatever the URL points at.
 */
export async function renderRoute() {
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
    // The registry is a separate read: a board that has never packaged a skill still has a
    // perfectly good capability scan to show, and a registry that fails to load must not
    // take the capability library down with it.
    if (!state.skillLibrary) {
      try {
        state.skillLibrary = await request(API.skillLibrary);
      } catch {
        state.skillLibrary = { entries: [], stats: { total: 0, active: 0, stale: 0, retired: 0 }, domains: [], dispatchable: [], stale: [], retired: [] };
      }
    }
    renderSkills();
    await overviewPromise;
    return;
  }

  if (route.name === 'alerts') {
    // The alert log is read on every visit: it is the record of what happened while the
    // board was closed, so a stale copy would defeat the whole point of it.
    await loadWatchdogAlerts();
    await overviewPromise;
    return;
  }

  if (route.name === 'sessions') {
    // The live session list comes from the Host, not from this board's API, so there is
    // nothing to fetch here: the observer pushes it in and the view redraws itself.
    // The board's own snapshot is still loaded, because the header and the KPI row read
    // it and the two must not disagree about the projects.
    renderSessions();
    await overviewPromise;
    return;
  }

  await overviewPromise;
}

/**
 * Read the whole board again.
 */
export async function refresh() {
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
