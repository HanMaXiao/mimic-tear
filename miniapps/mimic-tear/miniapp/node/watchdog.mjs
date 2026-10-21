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
 *   4. writes every alert down (`watchdog-alert.log`, JSONL) and *then* tries to tell the
 *      user about it with a desktop notification.
 *
 * The order matters: **the file is the channel, the toast is the courtesy.** A toast
 * needs an interactive session and can be swallowed; the file cannot. So an alert is
 * recorded whether or not the notification landed, and the board can read the log back
 * the next time it is opened.
 *
 * What it deliberately does **not** do: write to the board's data, dispatch work, or write
 * to the runtime database. A watchdog that can write back is a new source of failure; this
 * one can only read a timestamp, read a log, write down what it saw, and speak.
 *
 * Usage:
 *   node watchdog.mjs [--data-dir <dir>] [--db <file>] [--cron-id <id>] [--no-notify] [--dry-run]
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { sendToast } from './toast.mjs';
import { computeDutyEvidence } from './view-model.mjs';
import { RuntimeStore } from './runtime-store.mjs';
import { appendAlert } from './watchdog-alerts.mjs';
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
 * Headless mode: write the alert down, do not pop anything.
 *
 * A scheduled task that runs without an interactive session cannot show a toast anyway —
 * trying costs a failed notification and a confusing log. With this flag the file is the
 * only channel, which is exactly what it is for.
 */
const noNotify = args.includes('--no-notify');

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
 * Run one watchdog tick.
 *
 * @param {{dataDir?:string, now?:number, dbPath?:string, cronId?:string, noNotify?:boolean,
 *          deliver?:(message:{title:string,body:string}) => Promise<{ok:boolean,error?:string,note?:string}>}} [options]
 * @returns {Promise<{action:string, delivered:boolean, duty:any, evidence:any|null, message?:{title:string,body:string}, error?:string}>}
 */
export async function runWatchdog(options = {}) {
  const dir = options.dataDir ?? dataDir;
  const now = options.now ?? Date.now();
  const headless = options.noNotify ?? noNotify;
  const deliver = options.deliver
    ?? (headless
      ? async () => ({ ok: false, error: null, note: '通知已禁用（--no-notify）' })
      : sendToast);
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
    // A dry run looks; it does not touch. No toast, no state file, no alert file: a
    // preview must not consume the gap it just found, and must not claim the user was
    // told anything.
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

  // The gap this alert is about, so the same stretch is never written down twice.
  const gapTo = action === 'missed' ? (evidence?.lastGap?.to ?? null) : null;

  if (result?.ok) {
    // Every alert is written down, not just the ones that failed to deliver: the file is
    // the channel that survives a closed board and a swallowed toast.
    await appendAlert(dir, {
      at: now,
      action,
      title: message.title,
      body: message.body,
      delivered: true,
      error: null,
      note: null,
      gapTo,
    });
    const next = applySuccess(state, action, duty, now, evidence);
    await writeState(dir, next);
    return { action, delivered: true, duty, evidence, message };
  }

  // Delivery failed: the fact still goes down, with the reason. Keep the state where it
  // was so the next tick tries again.
  const next = applyFailure(state, action, duty, now, evidence);
  await writeState(dir, next);
  await appendAlert(dir, {
    at: now,
    action,
    title: message.title,
    body: message.body,
    delivered: false,
    error: result?.error ?? null,
    note: result?.note ?? null,
    gapTo,
  });
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
