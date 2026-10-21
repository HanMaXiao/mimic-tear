#!/usr/bin/env node
/**
 * The duty watchdog — the observer that lives outside the Mini App.
 *
 * The board's "the boss went quiet" warning only works while somebody is looking at the
 * board. The board is on-demand: close MiniMax Code and it is gone. That is precisely the
 * moment a silent duty boss matters most, so the watcher has to outlive the app.
 *
 * This program is what the Windows scheduled task runs every few minutes. It:
 *
 *   1. reads the duty handover stamp from `patrol-config.json` and the duty intent from
 *      `duty-intent.json` (both read-only),
 *   2. asks `buildDutyStatus` — the board's own rule — whether the boss is alive,
 *   3. reads the scheduler's permanent run log to see whether the boss *was*: a gap the
 *      handover stamp cannot show, because the next handover overwrites it,
 *   4. says something on the desktop when the verdict flips.
 *
 * What it deliberately does **not** do: write to the board's data, dispatch work, or write
 * to the runtime database. A watchdog that can write back is a new source of failure; this
 * one can only read a timestamp, read a log, and speak.
 *
 * Usage:
 *   node watchdog.mjs [--data-dir <dir>] [--db <file>] [--cron-id <id>] [--dry-run]
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { sendToast } from './toast.mjs';
import { computeDutyEvidence } from './view-model.mjs';
import { RuntimeStore } from './runtime-store.mjs';
import {
  applyFailure,
  applySuccess,
  buildAlertMessage,
  decideAction,
  emptyWatchdogState,
  evaluateDuty,
} from './watchdog-rules.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};

const dataDir = resolve(flag('data-dir', join(homedir(), '.minimax', 'v2', 'plugin-data', 'liveboards', 'mimic-tear')));
const runtimeDbPath = resolve(flag('db', process.env.MIMIC_RUNTIME_DB
  ?? join(homedir(), '.minimax', 'v2', 'sqlite', 'runtime-state.sqlite')));
const dryRun = args.includes('--dry-run');

/**
 * The duty cron's id.
 *
 * The run log is keyed by cron id, and the scheduler does not expose "the cron that
 * watches the boss" — so the project's own duty cron is named here. A constant beats a
 * lookup: a wrong id would silently produce no evidence at all, which looks exactly like
 * "nothing went wrong". `--cron-id` overrides it.
 */
const DUTY_CRON_ID = '672fde94-0c52-466d-831e-e2919f49b64a';

const CONFIG_FILE = 'patrol-config.json';
const INTENT_FILE = 'duty-intent.json';
const STATE_FILE = 'watchdog-state.json';
const LOG_FILE = 'watchdog-alert.log';

/**
 * @param {string} path
 * @param {any} fallback
 * @returns {Promise<any>}
 */
async function readJson(path, fallback) {
  try {
    const raw = await readFile(path, 'utf8');
    const value = JSON.parse(raw);
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Write the watchdog's state file.
 *
 * The write goes to a unique temp name and is then renamed, so a tick that is killed
 * halfway leaves the previous state intact instead of a truncated file that would make
 * the next tick believe it had already told the user.
 *
 * @param {string} dir
 * @param {any} state
 */
async function writeState(dir, state) {
  await mkdir(dir, { recursive: true });
  const target = join(dir, STATE_FILE);
  const temp = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;
  await writeFile(temp, JSON.stringify(state, null, 2), 'utf8');
  try {
    await rename(temp, target);
  } catch {
    await rm(temp, { force: true }).catch(() => undefined);
    throw new Error('watchdog 状态写入失败');
  }
}

/**
 * Append a line to the watchdog's own log.
 *
 * This is the fallback channel: if the desktop notification cannot be delivered, the fact
 * is still written down. "The notification failed" must not become "nobody ever knew".
 *
 * @param {string} dir the data directory to write into
 * @param {string} line
 */
async function appendLog(dir, line) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, LOG_FILE), `${line}\n`, { flag: 'a', encoding: 'utf8' });
}

/**
 * The evidence of missed duty rounds, read from the scheduler's permanent run log.
 *
 * The handover stamp cannot answer this: it says when the boss handed over *last*, and the
 * next handover overwrites it. The run log keeps every attempt, so the gap survives.
 *
 * @param {{dbPath:string, cronId:string, duty:any, now:number}} input
 * @returns {Promise<any|null>}
 */
async function readEvidence(input) {
  if (!input.cronId) return null;
  let store = null;
  try {
    store = RuntimeStore.open(input.dbPath);
    const runs = store.listCronRuns(input.cronId);
    if (!runs.length) return null;
    return computeDutyEvidence({
      runs,
      periodMs: (input.duty?.dutyIntervalMinutes ?? 30) * 60_000,
      // One threshold for the whole system: the same window the board's lamp uses.
      evidenceWindowMs: (input.duty?.staleAfterMinutes ?? 45) * 60_000,
      now: input.now,
      currentStale: Boolean(input.duty?.stale),
    });
  } catch {
    return null;
  } finally {
    store?.close();
  }
}

/**
 * One line describing an alert, for the log file.
 *
 * @param {number} now
 * @param {string} action
 * @param {{title:string, body:string}} message
 * @param {string} note
 * @returns {string}
 */
function formatAlertLine(now, action, message, note) {
  const label = action === 'stale' ? '大哥掉线' : action === 'missed' ? '大哥漏班' : '大哥恢复';
  return `[${new Date(now).toISOString()}] ${label}（${note}）\n  标题：${message.title}\n  正文：${message.body}`;
}

/**
 * Run one watchdog tick.
 *
 * @param {{dataDir?:string, now?:number, dbPath?:string, cronId?:string,
 *          deliver?:(message:{title:string,body:string}) => Promise<{ok:boolean,error?:string}>}} [options]
 * @returns {Promise<{action:string, delivered:boolean, duty:any, evidence:any|null, message?:{title:string,body:string}, error?:string}>}
 */
export async function runWatchdog(options = {}) {
  const dir = options.dataDir ?? dataDir;
  const now = options.now ?? Date.now();
  const deliver = options.deliver ?? sendToast;
  const dbPath = options.dbPath ?? runtimeDbPath;
  const cronId = options.cronId ?? DUTY_CRON_ID;

  const config = await readJson(join(dir, CONFIG_FILE), {});
  // The duty intent: was the boss explicitly told to rest? A missing file means "no
  // decision", which means on duty — never an excuse to stay quiet about a dead boss.
  const intent = await readJson(join(dir, INTENT_FILE), null);
  const state = await readJson(join(dir, STATE_FILE), emptyWatchdogState());

  const duty = evaluateDuty(config, now, intent);
  const evidence = await readEvidence({ dbPath, cronId, duty, now });
  const action = decideAction(state, duty, evidence);

  const message = action === 'none' ? undefined : buildAlertMessage(action, {
    duty,
    evidence,
    staleSince: state.staleSince ?? (action === 'stale' ? now : null),
    now,
    failedDeliveries: state.failedDeliveries ?? 0,
  });

  if (options.dryRun) {
    // A dry run looks; it does not touch. No toast, no state file: a preview must not
    // consume the gap it just found, and must not claim the user was told anything.
    return { action, delivered: false, duty, evidence, message };
  }

  if (action === 'none') {
    // Nothing to say. The baseline still moves, so the next tick knows where it stands.
    const next = applySuccess(state, action, duty, now, evidence);
    await writeState(dir, next);
    return { action, delivered: false, duty, evidence };
  }

  let result;
  try {
    result = await deliver(message);
  } catch (error) {
    result = { ok: false, error: error?.message ?? String(error) };
  }

  if (result?.ok) {
    // A missed round is evidence, not just a notification: it is written down even when
    // the toast lands, because the handover that erased the gap is the whole story.
    if (action === 'missed') {
      await appendLog(dir, formatAlertLine(now, action, message, '已记录（漏班证据）'));
    }
    const next = applySuccess(state, action, duty, now, evidence);
    await writeState(dir, next);
    return { action, delivered: true, duty, evidence, message };
  }

  // Delivery failed: log it, keep the state where it was so the next tick retries.
  const next = applyFailure(state, action, duty, now, evidence);
  await writeState(dir, next);
  // The log is read by a human when the notification did not arrive, so it carries the
  // message that *would* have been shown — not just an internal action name.
  await appendLog(dir, formatAlertLine(now, action, message, `通知未能送达：${result?.error ?? '未知原因'}`));
  return { action, delivered: false, duty, evidence, message, error: result?.error ?? '未知原因' };
}

/**
 * Print the current watchdog verdict without notifying anybody.
 * Used by the setup script to check the wiring.
 *
 * @returns {Promise<any>}
 */
export async function inspect() {
  const config = await readJson(join(dataDir, CONFIG_FILE), {});
  const intent = await readJson(join(dataDir, INTENT_FILE), null);
  const state = await readJson(join(dataDir, STATE_FILE), emptyWatchdogState());
  const now = Date.now();
  const duty = evaluateDuty(config, now, intent);
  const evidence = await readEvidence({ dbPath: runtimeDbPath, cronId: DUTY_CRON_ID, duty, now });
  return { dataDir, duty, evidence, state, action: decideAction(state, duty, evidence) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runWatchdog({ dryRun });
  if (dryRun) {
    const preview = await inspect();
    process.stdout.write(`${JSON.stringify(preview, null, 2)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify({
      action: result.action,
      delivered: result.delivered,
      // The fact (the board's lamp follows it) and the verdict (what this watchdog acts on).
      stale: result.duty.stale,
      alertable: result.duty.alertable,
      resting: result.duty.resting,
      ageMinutes: result.duty.ageMinutes,
      // The evidence: what the scheduler's permanent run log says.
      missedRounds: result.evidence?.missedRounds ?? 0,
      erasedOutage: Boolean(result.evidence?.erasedOutage),
      lastGap: result.evidence?.lastGap ?? null,
      error: result.error ?? null,
    })}\n`);
  }
}
