/**
 * 派工单。
 *
 * 一张单子，一次投递。投递在服务端跑，页面只记得它的 id：刷新之后按 id 读回来，
 * 指令就不会在半路上丢掉。
 */

import { el, toast } from '../shared/dom.js';
import { escapeHtml } from '../shared/format.js';
import { request } from '../shared/http.js';
import { API } from '../shared/api.js';
import { state } from '../shared/state.js';

/**
 * Resolve a project by id.
 *
 * The overview list is the usual source, but a deep link straight to a project
 * (`/?project=32`) never loads the overview — the loaded project detail is the fallback.
 *
 * @param {number} projectId
 * @returns {any}
 */
export function findProject(projectId) {
  const fromOverview = (state.overview?.projects ?? []).find((item) => item.id === projectId);
  if (fromOverview) return fromOverview;
  if (state.project && state.project.project?.id === projectId) return state.project.project;
  return null;
}

/**
 * Every session of the team tree, flattened.
 *
 * @param {Array<any>} nodes
 * @param {Array<any>} [collected]
 * @returns {Array<any>}
 */
function collectSessions(nodes, collected = []) {
  for (const node of nodes ?? []) {
    collected.push(node);
    collectSessions(node.children, collected);
  }
  return collected;
}

/**
 * Open the dispatch dialog, aimed at a specific project and optionally a specific session.
 *
 * @param {number} projectId
 * @param {{ sessionId?: string|null, instruction?: string }} [options]
 */
export function openDispatchDialog(projectId, options = {}) {
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

/**
 * Send the dispatch slip.
 *
 * @param {any} event
 */
export async function submitDispatch(event) {
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
    const payload = await request(API.dispatch, {
      method: 'POST',
      body: JSON.stringify({
        projectId: target.projectId,
        sessionId: el('dispatch-session').value || target.sessionId || null,
        instruction,
        idempotencyKey: crypto.randomUUID(),
      }),
    });
    // The id is what makes the dispatch recoverable: the page can read the record back
    // after a reload instead of losing the instruction on the way.
    rememberDispatchPayload(payload);
    el('dispatch-dialog').close();
    toast('指令已交给大哥，正在投递');
  } catch (error) {
    showDispatchError(error.message);
  } finally {
    submit.disabled = false;
    submit.textContent = '下达';
  }
}

/**
 * Show why the dispatch did not go out.
 *
 * @param {string} message
 */
function showDispatchError(message) {
  const node = el('dispatch-error');
  node.hidden = false;
  node.textContent = message;
}

/**
 * Where the id of the dispatch this page is waiting for is kept.
 *
 * The dispatch itself lives on the server; the page only has to remember which one to ask
 * for. `localStorage` is the obvious place, but it is not guaranteed to exist (a sandboxed
 * frame, a test shim), so every access is guarded — a page that cannot remember still
 * works, it just cannot recover.
 */
let dispatchStoreCache;

/**
 * The store this page keeps its dispatch id in.
 *
 * The store is looked up once and then kept: it belongs to this page, and a page that
 * swapped stores underneath itself would forget the dispatch it is waiting for.
 *
 * @returns {Storage|null}
 */
function dispatchStore() {
  if (dispatchStoreCache === undefined) {
    try {
      dispatchStoreCache = globalThis.localStorage ?? null;
    } catch {
      dispatchStoreCache = null;
    }
  }
  return dispatchStoreCache;
}

const DISPATCH_ID_KEY = 'mimic-tear:dispatch-id';

/**
 * Remember the dispatch this page is waiting for.
 *
 * @param {string} id
 */
function rememberDispatchId(id) {
  const value = String(id ?? '');
  if (!value) return;
  state.dispatchId = value;
  try {
    dispatchStore()?.setItem(DISPATCH_ID_KEY, value);
  } catch {
    // A blocked or full store must not break the dispatch: the page still works, it just
    // cannot recover from a reload.
  }
}

/**
 * The dispatch id this page remembers, if any.
 *
 * @returns {string|null}
 */
export function readRememberedDispatchId() {
  try {
    return dispatchStore()?.getItem(DISPATCH_ID_KEY) || null;
  } catch {
    return null;
  }
}

/**
 * Forget a dispatch: it is finished, so there is nothing left to restore.
 *
 * @param {string|null} id only the dispatch with this id is forgotten; another dispatch
 *   this page is waiting for is left alone.
 */
export function forgetDispatchId(id) {
  if (id && state.dispatchId && state.dispatchId !== id) return;
  state.dispatchId = null;
  try {
    const store = dispatchStore();
    // Only drop the key when it still points at this dispatch: another page may have
    // taken over the slot, and that page's dispatch must not be forgotten by this one.
    if (!id || store?.getItem(DISPATCH_ID_KEY) === id) store?.removeItem(DISPATCH_ID_KEY);
  } catch {
    // Nothing to do: the in-memory copy is gone, which is what this page needs.
  }
}

/**
 * Is this dispatch still on its way?
 *
 * @param {string} status
 * @returns {boolean}
 */
function isPendingDispatch(status) {
  return status === 'queued' || status === 'running';
}

/**
 * One shape for both kinds of dispatch outcome.
 *
 * The live event says `delivered`; the stored record says `status`. The two have to end up
 * in the same shape, or a restored result would be a different thing from a live one.
 *
 * @param {any} source
 * @returns {{dispatchId:string|null, status:string, delivered:boolean, text:string, error:string|null}}
 */
export function normalizeDispatchOutcome(source) {
  const status = String(source?.status ?? '');
  const delivered = typeof source?.delivered === 'boolean' ? source.delivered : status === 'done';
  return {
    dispatchId: source?.dispatchId ?? source?.id ?? null,
    status,
    delivered,
    text: source?.text ?? '',
    error: source?.error ?? null,
  };
}

/**
 * The one place a dispatch outcome becomes something the user sees.
 *
 * The live path is the SSE 'dispatch' event; the recovery path is the record read back
 * from the server after a reload. Both go through here, so a dispatch that was restored
 * can never look different from one that arrived live.
 *
 * @param {{dispatchId:string|null, status:string, delivered:boolean, error:string|null}} outcome
 */
export function renderDispatchOutcome(outcome) {
  if (!outcome) return;

  if (isPendingDispatch(outcome.status)) {
    // Still on its way: this is a state, not a verdict. The outcome follows.
    toast('指令仍在投递中');
    return;
  }

  const key = outcome.dispatchId ?? '';
  if (key) {
    // The live event and the restored record describe the same dispatch; saying it twice
    // would read as two dispatches.
    if (state.announcedDispatches.has(key)) return;
    state.announcedDispatches.add(key);
  }

  if (outcome.delivered) toast('指令已投递给目标会话');
  else toast(`派工未完成：${outcome.error || '大哥未确认投递'}`, 'error');
}

/**
 * Remember the dispatch this page is waiting for.
 *
 * Only a dispatch that is still on its way is worth remembering: a finished one has
 * already been announced, and a reload must not repeat it.
 *
 * @param {any} payload
 */
function rememberDispatchPayload(payload) {
  const id = payload?.dispatchId ?? payload?.id ?? null;
  if (!id) return;
  if (isPendingDispatch(payload?.status)) {
    rememberDispatchId(id);
    return;
  }
  forgetDispatchId(id);
}

/** How long the page waits before it looks at an in-flight dispatch again. */
const DISPATCH_POLL_MS = 1500;

/** How many times it looks before it stops looking on its own. */
const DISPATCH_POLL_MAX = 20;

/**
 * Keep an eye on a dispatch that is still on its way.
 *
 * The server keeps the record, so the page can ask again. It stops on its own: a dispatch
 * that never finishes must not keep the page busy forever.
 *
 * @param {string} id
 * @param {number} [attempt]
 */
function scheduleDispatchPoll(id, attempt = 0) {
  if (attempt >= DISPATCH_POLL_MAX) return;
  const timer = setTimeout(() => {
    void pollDispatch(id, attempt + 1);
  }, DISPATCH_POLL_MS);
  // In Node the timer would keep the process alive; a browser has nothing to unref.
  if (timer && typeof timer.unref === 'function') timer.unref();
}

/**
 * Read a dispatch again and see whether it has arrived.
 *
 * @param {string} id
 * @param {number} attempt
 */
async function pollDispatch(id, attempt) {
  try {
    const record = await request(API.dispatchStatus(id));
    state.dispatch = record;
    const outcome = normalizeDispatchOutcome(record);
    if (isPendingDispatch(outcome.status)) {
      // Still running: keep waiting, but do not repeat the notice.
      scheduleDispatchPoll(id, attempt);
      return;
    }
    renderDispatchOutcome(outcome);
    forgetDispatchId(id);
  } catch (error) {
    // The record is gone (404): there is nothing left to wait for. Anything else is a
    // transient failure, so the id is kept and the next reload can try again.
    if (error?.status === 404) forgetDispatchId(id);
  }
}

/**
 * The dispatch that was still in flight when this page was opened.
 *
 * A dispatch runs on the server, in the background: the page only hears about it over
 * SSE. Reload the page while one is running and that announcement is lost — the
 * instruction looks like it never went anywhere. The server kept the record, so the page
 * reads it back by id and says the same thing the live event would have said.
 *
 * @returns {Promise<void>}
 */
export async function restoreDispatch() {
  const id = readRememberedDispatchId();
  if (!id) return;

  try {
    const record = await request(API.dispatchStatus(id));
    state.dispatch = record;
    const outcome = normalizeDispatchOutcome(record);
    renderDispatchOutcome(outcome);
    if (isPendingDispatch(outcome.status)) {
      scheduleDispatchPoll(id);
      return;
    }
    // It is finished: there is nothing left to restore after the next reload.
    forgetDispatchId(id);
  } catch (error) {
    // The record is gone (404): there is nothing to restore. Anything else is a transient
    // failure, so the id is kept and the next reload can try again.
    if (error?.status === 404) forgetDispatchId(id);
  }
}
