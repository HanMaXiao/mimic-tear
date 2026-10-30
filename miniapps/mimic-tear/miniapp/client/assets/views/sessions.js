/**
 * 会话实况视图。
 *
 * 这一块回答的是「现在机上有谁在干活、谁卡住了、谁在等我回答」。
 * 它和大哥自己的值班状态不是一回事：值班状态是大哥自己写的结论（他巡没巡、发现没发现），
 * 这一块是宿主给出的事实（哪些会话在跑、哪些 turn 刚结束、哪个会话在等一个回答）。
 * 两者并排放在看板上，是为了不让「大哥说一切正常」盖住「有个会话真的卡在提问上」。
 *
 * 数据来自 `runtime/session-watch.js`，这一层只负责画。
 */

import { el } from '../shared/dom.js';
import { escapeHtml } from '../shared/format.js';
import { state } from '../shared/state.js';

/** 会话状态的中文说法。 */
const STATUS_LABEL = {
  idle: '空闲',
  running: '进行中',
  error: '出错',
  aborted: '已中止',
};

/**
 * 把一个时间戳说成「刚刚 / 3 分钟前 / 2 小时前 / 昨天 21:07」。
 *
 * @param {number} ms
 * @returns {string}
 */
export function relativeTime(ms) {
  const value = Number(ms) || 0;
  if (!value) return '未知';
  const delta = Date.now() - value;
  if (delta < 0) return '刚刚';
  if (delta < 60_000) return '刚刚';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  const date = new Date(value);
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${time}`;
}

/**
 * 一条会话的标题区。
 *
 * @param {any} row
 * @param {boolean} selected
 * @returns {string}
 */
function sessionRowHtml(row, selected) {
  const status = STATUS_LABEL[row.status] ?? row.status;
  const flags = [];
  if (row.needsAnswer) flags.push('<span class="tag tag--high">等回答</span>');
  if (row.running) flags.push('<span class="tag tag--live">进行中</span>');
  return `<li class="session-row${selected ? ' session-row--selected' : ''}${row.needsAnswer ? ' session-row--ask' : ''}">
    <button type="button" class="session-row__main" data-session="${escapeHtml(row.sessionId)}">
      <span class="session-row__title">${escapeHtml(row.title)}</span>
      <span class="session-row__meta">
        <span class="session-row__status session-row__status--${escapeHtml(row.status)}">${escapeHtml(status)}</span>
        <span class="session-row__when">${escapeHtml(relativeTime(row.updatedAtMs))}</span>
      </span>
    </button>
    ${flags.length ? `<span class="session-row__flags">${flags.join('')}</span>` : ''}
  </li>`;
}

/**
 * 画出会话表。
 *
 * @param {any} snapshot
 * @returns {string}
 */
export function sessionsHtml(snapshot) {
  const rows = snapshot?.sessions ?? [];
  if (!rows.length) {
    if (snapshot?.availability === 'connecting') return '<div class="state"><span class="spinner" aria-hidden="true"></span>正在连接宿主…</div>';
    if (snapshot?.availability === 'not_permitted') {
      return '<div class="state state--error">宿主没有放开「读取会话」权限——在插件详情里打开 session.read 开关。</div>';
    }
    if (snapshot?.availability === 'unavailable') {
      return '<div class="state state--error">读不到宿主会话：' + escapeHtml(snapshot?.error ?? '未知原因') + '</div>';
    }
    return '<div class="empty">现在没有可读取的会话。</div>';
  }

  // 等回答的会话排在最前面——那是唯一一件必须立刻处理的事。
  const ordered = [...rows].sort((a, b) => {
    if (Boolean(b.needsAnswer) !== Boolean(a.needsAnswer)) return b.needsAnswer ? 1 : -1;
    if (Boolean(b.running) !== Boolean(a.running)) return b.running ? 1 : -1;
    return Number(b.updatedAtMs || 0) - Number(a.updatedAtMs || 0);
  });

  return ordered.map((row) => sessionRowHtml(row, row.sessionId === snapshot.selectedSessionId)).join('');
}

/**
 * 画出「最新结果」——选中会话的最后一条回复正文。
 *
 * @param {any} snapshot
 * @returns {string}
 */
export function detailHtml(snapshot) {
  if (snapshot?.detailLoading) return '<div class="state"><span class="spinner" aria-hidden="true"></span>正在读取…</div>';
  const detail = snapshot?.detail;
  if (!detail) {
    if (snapshot?.error) return `<div class="state state--error">${escapeHtml(snapshot.error)}</div>`;
    return '<div class="empty">左边点一个会话，这里显示它最后一条回复。</div>';
  }
  const body = detail.lastAssistantText;
  const bodyHtml = body && body.trim()
    ? `<pre class="session-detail__reply">${escapeHtml(body)}</pre>`
    : '<div class="empty">这个会话还没有可显示的回复正文。</div>';
  const errorHtml = detail.error ? `<div class="state state--error">${escapeHtml(detail.error)}</div>` : '';
  return `<div class="session-detail__head">
      <span class="session-detail__title">${escapeHtml(detail.title)}</span>
      <span class="session-detail__status">${escapeHtml(STATUS_LABEL[detail.status] ?? detail.status)}</span>
    </div>${errorHtml}${bodyHtml}`;
}

/**
 * 刷新会话实况这一块。
 */
export function renderSessions() {
  const list = el('session-list-live');
  if (list) list.innerHTML = sessionsHtml(state.sessions);

  const detail = el('session-detail-live');
  if (detail) detail.innerHTML = detailHtml(state.sessions);

  const connection = el('session-connection');
  if (connection) {
    const snapshot = state.sessions ?? {};
    const counts = { running: 0, ask: 0, total: (snapshot.sessions ?? []).length };
    for (const row of snapshot.sessions ?? []) {
      if (row.running) counts.running += 1;
      if (row.needsAnswer) counts.ask += 1;
    }
    const label = {
      connecting: '正在连接宿主…',
      ready: `已连接 · ${counts.total} 个会话 · ${counts.running} 个在跑`,
      not_permitted: '未授权读取会话',
      unavailable: '连接不可用',
    }[snapshot.availability] ?? '状态未知';
    connection.textContent = counts.ask ? `${label} · ${counts.ask} 个在等回答` : label;
    connection.dataset.state = snapshot.availability ?? 'unknown';
  }
}
