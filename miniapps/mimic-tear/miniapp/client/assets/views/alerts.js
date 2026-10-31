/**
 * 看门狗告警日志。
 *
 * 看板关着的时候发生了什么，都留在这里：每一次告警都写下来，通知送没送到也写。
 */

import { el } from '../shared/dom.js';
import { escapeHtml, relativeTime } from '../shared/format.js';
import { request } from '../shared/http.js';
import { API } from '../shared/api.js';
import { state } from '../shared/state.js';
import { loadingState } from '../shared/loading.js';

/**
 * The three things the watchdog's log can say.
 *
 * The watchdog flips between them: the boss went quiet (`stale`), the boss came back
 * (`recovered`), or rounds were lost on the way (`missed`). The board speaks in words;
 * the raw name stays on the tag, so the log can still be matched against the watchdog's
 * own output.
 */
const ALERT_ACTION_LABEL = {
  stale: '掉线',
  recovered: '归位',
  missed: '漏轮',
};

/** How loud each kind of alert is, in the board's existing tag vocabulary. */
const ALERT_ACTION_TONE = {
  stale: 'tag--high',
  recovered: 'tag--done',
  missed: 'tag--medium',
};

/** How many entries the alert log shows at once. */
const ALERT_LIMIT = 50;

/** How many columns the alert table has — the four states span all of them. */
const ALERT_COLUMNS = 5;

/**
 * A duration in words.
 *
 * @param {number} minutes
 * @returns {string}
 */
function durationLabel(minutes) {
  const total = Number(minutes);
  if (!Number.isFinite(total) || total < 0) return '—';
  if (total < 60) return `${Math.round(total)} 分钟`;
  if (total < 1440) return `${Math.round(total / 60)} 小时`;
  return `${Math.round(total / 1440)} 天`;
}

/**
 * How long the condition an alert reports lasted.
 *
 * The alert record does not carry a duration field: the watchdog writes the facts down in
 * its own words ("已 35 分钟没有交班"). The number of minutes is therefore read from the
 * body — the first "N 分钟" is the duration in every message the watchdog writes (the
 * silence for a stale boss, the downtime for a recovered one, the gap for a missed round).
 * A record that ever carries the number outright is used as it is.
 *
 * @param {any} alert
 * @returns {string}
 */
function alertDurationLabel(alert) {
  const explicit = Number(alert?.durationMinutes ?? alert?.gapMinutes ?? NaN);
  if (Number.isFinite(explicit)) return durationLabel(explicit);
  const match = /(\d+)\s*分钟/.exec(String(alert?.body ?? ''));
  if (match) return durationLabel(Number(match[1]));
  return '—';
}

/**
 * The moment an alert was written down, in local time.
 *
 * @param {number} timestamp
 * @returns {string}
 */
function alertMoment(timestamp) {
  const time = Number(timestamp);
  if (!Number.isFinite(time) || time <= 0) return '—';
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * One alert, as a row of the log.
 *
 * @param {any} alert
 * @returns {string}
 */
function alertRowHtml(alert) {
  const action = String(alert?.action ?? '');
  const label = ALERT_ACTION_LABEL[action] ?? (action || '未知');
  const tone = ALERT_ACTION_TONE[action] ?? '';
  const delivered = alert?.delivered === true;
  // Why the notification did not land: the error first, the note second. One of the two is
  // always the reason, and saying which one is the difference between "it failed" and
  // "it failed because the notifications are switched off".
  const reason = alert?.error || alert?.note || '';

  return `
    <tr>
      <td class="nowrap">
        <span class="cell-project__name">${escapeHtml(alertMoment(alert?.at))}</span>
        <span class="cell-project__path">${escapeHtml(relativeTime(alert?.at))}</span>
      </td>
      <td class="nowrap"><span class="tag ${tone}" title="${escapeHtml(action)}">${escapeHtml(label)}</span></td>
      <td class="nowrap">${escapeHtml(alertDurationLabel(alert))}</td>
      <td class="nowrap">
        <span class="tag ${delivered ? 'tag--done' : 'tag--high'}">${delivered ? '已送达' : '未送达'}</span>
        ${reason ? `<span class="cell-project__path">${escapeHtml(reason)}</span>` : ''}
      </td>
      <td>
        <span class="alerts__title">${escapeHtml(alert?.title ?? '')}</span>
        <span class="alerts__body">${escapeHtml(alert?.body ?? '')}</span>
      </td>
    </tr>`;
}

/**
 * The alert log, in its four states.
 *
 * A log that says nothing has to say *why* it says nothing: "still loading" and "the read
 * failed" are different facts, and a panel that shows an empty table for both makes the
 * second one look like the first.
 */
export function renderAlerts() {
  const body = el('alerts-body');
  if (!body) return;
  const count = el('alerts-count');
  const alerts = state.alerts;

  if (alerts === null) {
    if (count) count.textContent = '';
    body.innerHTML = `<tr><td colspan="${ALERT_COLUMNS}">${loadingState('正在加载告警日志…')}</td></tr>`;
    return;
  }
  if (state.alertsError) {
    if (count) count.textContent = '';
    body.innerHTML = `<tr><td colspan="${ALERT_COLUMNS}"><div class="state state--error">告警日志读取失败：${escapeHtml(state.alertsError)}</div></td></tr>`;
    return;
  }
  if (!alerts.length) {
    if (count) count.textContent = '';
    body.innerHTML = `<tr><td colspan="${ALERT_COLUMNS}"><div class="empty">看门狗还没有报过警。</div></td></tr>`;
    return;
  }
  if (count) count.textContent = `${alerts.length} 条`;
  body.innerHTML = alerts.map(alertRowHtml).join('');
}

/**
 * Read the alert log.
 *
 * The log is read fresh every time the panel is opened: it is a record of what happened
 * while nobody was looking, so a cached copy would be the one thing it must never be.
 */
export async function loadWatchdogAlerts() {
  state.alerts = null;
  state.alertsError = null;
  renderAlerts();

  try {
    const payload = await request(`${API.watchdogAlerts}?limit=${ALERT_LIMIT}`);
    state.alerts = Array.isArray(payload?.alerts) ? payload.alerts : [];
  } catch (error) {
    state.alerts = [];
    state.alertsError = error.message;
  }
  renderAlerts();
}
