/**
 * The alert log — the watchdog's primary channel — and the board's inbox.
 *
 * A desktop notification is best-effort: it needs an interactive session, and the OS can
 * swallow it. The file is what survives. Every alert is written down — delivered or not —
 * so "the notification failed" can never become "nobody ever knew".
 *
 * But the file is not only for machines. **The board's inbox (`patrol.json`) is where the
 * user actually looks.** On 2026-10-22 the watchdog fired a stale alert into the log while
 * the board sat empty for four days: the alert was real, and nobody saw it. So the
 * exceptions are *also* published to the board.
 *
 * Two rules keep that from turning into noise:
 *
 * 1. **Only exceptions are published.** A recovered boss or a successful heartbeat is
 *    machinery talk; the user's inbox is not the place for it.
 * 2. **One notice per state.** A record carries the identity of what it reports (the
 *    outage, the gap, the misconfiguration); the same identity is not published twice.
 *    A state *change* has a different identity, so it is published again.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { PatrolStore } from './patrol-store.mjs';

const ALERT_FILE = 'watchdog-alert.log';
const NOTICE_FILE = 'watchdog-notices.json';

/**
 * The alert kinds the user needs to see in their inbox, and how loud they are.
 *
 * @type {Record<string, 'high'|'medium'|'low'>}
 */
const BOARD_SEVERITY = {
  stale: 'high',
  missed: 'high',
  heartbeat_break: 'medium',
  heartbeat_failed: 'medium',
  heartbeat_misconfigured: 'medium',
};

/**
 * @typedef {{
 *   at:number, action:string, title:string, body:string,
 *   delivered:boolean, error:string|null, note:string|null, gapTo:number|null,
 *   identity?:string, severity?:'high'|'medium'|'low',
 * }} AlertRecord
 */

/**
 * A local time the user can read.
 *
 * @param {number|null|undefined} timestamp
 * @returns {string}
 */
export function formatLocal(timestamp) {
  if (!timestamp) return '从未';
  return new Date(timestamp).toLocaleString('sv-SE', { hour12: false }).slice(0, 16);
}

/**
 * The facts a board notice has to carry: when the last handover was, how many rounds that
 * means, and the scheduler's own run-level evidence.
 *
 * "The boss went quiet" is a conclusion; the numbers behind it are what let the reader
 * judge it. The evidence口径 is the same one the watchdog already uses (the permanent run
 * log), so the two never disagree.
 *
 * @param {any} duty
 * @param {any} evidence
 * @returns {string}
 */
export function buildDutyTruthLine(duty, evidence) {
  const lines = [];
  if (duty) {
    lines.push(`上次交班 ${formatLocal(duty.lastRunAt)}（${duty.ageMinutes ?? 0} 分钟前，阈值 ${duty.staleAfterMinutes ?? 0} 分钟）`);
    lines.push(`按交班戳折算：漏 ${duty.missedRounds ?? 0} 轮`);
  }
  if (evidence) {
    lines.push(`调度记录累计漏 ${evidence.missedRounds ?? 0} 轮`);
    const gap = evidence.lastGap;
    if (gap) {
      lines.push(`最近一段空档：${formatLocal(gap.from)} → ${formatLocal(gap.to)}（${gap.gapMinutes} 分钟 / ${gap.missedRounds} 轮${gap.attempted ? ' / 调度器触发了但没投出去' : ' / 调度器根本没触发'}）`);
    }
    for (const run of evidence.pendingTail?.runs ?? []) {
      lines.push(`run_id=${run.runId} status=${run.status} retry_attempt=${run.retryAttempt} created_at=${formatLocal(run.createdAt)}`);
    }
  }
  return lines.join('\n');
}

/**
 * The identity of what a record reports.
 *
 * The same outage must not fill the user's inbox on every tick, and a *different* outage
 * must be published again. The identity is what tells them apart: the handover stamp that
 * started the outage, the end of the gap, the pinned cron that is misconfigured.
 *
 * @param {AlertRecord} record
 * @returns {string}
 */
function noticeIdentity(record) {
  if (record.identity) return record.identity;
  if (record.gapTo) return `${record.action}:${record.gapTo}`;
  if (record.note) return `${record.action}:${record.note}`;
  if (record.error) return `${record.action}:${record.error}`;
  return `${record.action}:${record.at}`;
}

/**
 * The most recent alerts, newest first.
 *
 * Lines written before the format changed (plain text, not JSON) are history, not an error:
 * they are skipped on read.
 *
 * @param {string} dir
 * @param {number} [limit]
 * @returns {Promise<AlertRecord[]>}
 */
export async function readAlerts(dir, limit = 20) {
  let raw;
  try {
    raw = await readFile(join(dir, ALERT_FILE), 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of raw.split('\n')) {
    const text = line.trim();
    if (!text) continue;
    try {
      const value = JSON.parse(text);
      if (value && typeof value === 'object') rows.push(value);
    } catch {
      // Not JSON: a line from before the format changed. History, not an error.
    }
  }
  return rows.reverse().slice(0, limit);
}

/**
 * The identities already published.
 *
 * @param {string} dir
 * @returns {Promise<Record<string, number>>}
 */
async function readNotices(dir) {
  try {
    const value = JSON.parse(await readFile(join(dir, NOTICE_FILE), 'utf8'));
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

/**
 * @param {string} dir
 * @param {Record<string, number>} notices
 */
async function writeNotices(dir, notices) {
  await mkdir(dir, { recursive: true });
  const target = join(dir, NOTICE_FILE);
  const temp = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;
  await writeFile(temp, `${JSON.stringify(notices, null, 2)}\n`, 'utf8');
  await rename(temp, target);
}

/**
 * Append one alert to the log — and, if it is an exception, publish it to the board.
 *
 * @param {string} dir the data directory to write into
 * @param {AlertRecord} record
 * @returns {Promise<any|null>} the published finding, or null when nothing was published
 */
export async function appendAlert(dir, record) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ALERT_FILE), `${JSON.stringify(record)}\n`, { flag: 'a', encoding: 'utf8' });

  const severity = BOARD_SEVERITY[record.action];
  if (!severity) return null;

  const identity = noticeIdentity(record);
  const notices = await readNotices(dir);
  if (notices[identity]) return null;

  const patrol = new PatrolStore(dir);
  const finding = await patrol.add({
    projectId: null,
    projectName: null,
    severity: record.severity ?? severity,
    title: record.title,
    body: record.body,
  });

  notices[identity] = record.at ?? Date.now();
  // Keep the ledger bounded — only recent identities matter.
  const keys = Object.keys(notices);
  if (keys.length > 50) {
    for (const key of keys.slice(0, keys.length - 50)) delete notices[key];
  }
  await writeNotices(dir, notices);
  return finding;
}

/**
 * The board notice for the current state — or null when there is nothing to report.
 *
 * This is decided **independently of the toast's own state machine**, because "the toast
 * already said it" is not the same as "the board was told": on 2026-10-22 the toast fired
 * at 18:22, the watchdog recorded "I told them", and the board stayed empty for four days.
 * The board's ledger is the only thing that can answer "did the board see it".
 *
 * Only exceptions produce a notice: a healthy boss, a recovered boss and a successful
 * heartbeat are machinery talk.
 *
 * @param {string} action
 * @param {any} duty
 * @param {any} evidence
 * @returns {{identity:string, severity:'high'|'medium', title:string, body:string}|null}
 */
export function buildBoardNotice(action, duty, evidence) {
  const stale = Boolean(duty?.alertable ?? duty?.stale);
  const gap = evidence?.lastGap ?? null;
  const missed = Boolean(evidence?.erasedOutage) && Boolean(gap);
  const truth = buildDutyTruthLine(duty, evidence);

  if (missed) {
    return {
      identity: `missed:${gap.to}`,
      severity: 'high',
      title: '仿身泪滴 · 大哥漏了几轮',
      body: [
        `从 ${formatLocal(gap.from)} 到 ${formatLocal(gap.to)} 漏了 ${gap.missedRounds} 轮（间隔 ${gap.gapMinutes} 分钟）。`,
        '这一段已经被后来的交班盖住了——补交班会刷新「上次交班时间」，所以只有调度记录还留着这段空档。',
        truth,
      ].filter(Boolean).join('\n'),
    };
  }

  if (!stale) return null;

  return {
    identity: `stale:${duty?.lastRunAt ?? 0}`,
    severity: 'high',
    title: '仿身泪滴 · 大哥掉线',
    body: [
      `已 ${duty?.ageMinutes ?? 0} 分钟没有交班（超过 ${duty?.staleAfterMinutes ?? 0} 分钟阈值）。`,
      truth,
    ].filter(Boolean).join('\n'),
  };
}

/**
 * Publish a board notice — once per state.
 *
 * @param {string} dir
 * @param {{identity:string, severity:'high'|'medium', title:string, body:string}} notice
 * @returns {Promise<any|null>}
 */
export async function publishBoardNotice(dir, notice) {
  if (!notice) return null;
  const notices = await readNotices(dir);
  if (notices[notice.identity]) return null;

  const patrol = new PatrolStore(dir);
  const finding = await patrol.add({
    projectId: null,
    projectName: null,
    severity: notice.severity,
    title: notice.title,
    body: notice.body,
  });

  notices[notice.identity] = Date.now();
  const keys = Object.keys(notices);
  if (keys.length > 50) {
    for (const key of keys.slice(0, keys.length - 50)) delete notices[key];
  }
  await writeNotices(dir, notices);
  return finding;
}
