/**
 * The alert log — the watchdog's primary channel.
 *
 * A desktop notification is best-effort: it needs an interactive session, and the OS can
 * swallow it. The file is what survives. Every alert is written down — delivered or not —
 * so "the notification failed" can never become "nobody ever knew", and so the board can
 * show what happened while it was closed.
 *
 * The format is JSONL: one JSON object per line. It is machine-readable (the board reads
 * the last N entries) and still readable by a human tailing the file.
 *
 * Lines written before the format changed (plain text, not JSON) are history, not an
 * error: they are skipped on read.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ALERT_FILE = 'watchdog-alert.log';

/**
 * @typedef {{
 *   at:number,          // when the alert was raised
 *   action:string,      // 'stale' | 'missed' | 'recovered'
 *   title:string,
 *   body:string,
 *   delivered:boolean,  // did the notification actually land?
 *   error:string|null,  // why it did not land
 *   note:string|null,   // anything else worth keeping (e.g. notifications disabled)
 *   gapTo:number|null,  // the end of the gap this alert is about ('missed' only)
 * }} AlertRecord
 */

/**
 * Append one alert.
 *
 * Append-only, on purpose: this file is the record of what the watchdog saw, and a
 * watchdog that rewrote it would lose exactly the history it exists to keep.
 *
 * @param {string} dir the data directory to write into
 * @param {AlertRecord} record
 * @returns {Promise<void>}
 */
export async function appendAlert(dir, record) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ALERT_FILE), `${JSON.stringify(record)}\n`, { flag: 'a', encoding: 'utf8' });
}

/**
 * The most recent alerts, newest first.
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
