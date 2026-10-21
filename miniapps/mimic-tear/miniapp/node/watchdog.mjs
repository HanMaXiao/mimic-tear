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
 *   3. says something on the desktop when the verdict flips.
 *
 * What it deliberately does **not** do: write to the board's data, dispatch work, or touch
 * the runtime database. A watchdog that can write back is a new source of failure; this one
 * can only read a timestamp and speak.
 *
 * Usage:
 *   node watchdog.mjs [--data-dir <dir>] [--dry-run]
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { sendToast } from './toast.mjs';
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
const dryRun = args.includes('--dry-run');

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
 * Run one watchdog tick.
 *
 * @param {{dataDir?:string, now?:number, deliver?:(message:{title:string,body:string}) => Promise<{ok:boolean,error?:string}>}} [options]
 * @returns {Promise<{action:string, delivered:boolean, duty:any, message?:{title:string,body:string}, error?:string}>}
 */
export async function runWatchdog(options = {}) {
  const dir = options.dataDir ?? dataDir;
  const now = options.now ?? Date.now();
  const deliver = options.deliver ?? sendToast;

  const config = await readJson(join(dir, CONFIG_FILE), {});
  // The duty intent: was the boss explicitly told to rest? A missing file means "no
  // decision", which means on duty — never an excuse to stay quiet about a dead boss.
  const intent = await readJson(join(dir, INTENT_FILE), null);
  const state = await readJson(join(dir, STATE_FILE), emptyWatchdogState());

  const duty = evaluateDuty(config, now, intent);
  const action = decideAction(state, duty);

  if (action === 'none') {
    // Nothing to say. The baseline still moves, so the next tick knows where it stands.
    const next = applySuccess(state, action, duty, now);
    await writeState(dir, next);
    return { action, delivered: false, duty };
  }

  const message = buildAlertMessage(action, {
    duty,
    staleSince: state.staleSince ?? (action === 'stale' ? now : null),
    now,
    failedDeliveries: state.failedDeliveries ?? 0,
  });

  const result = await deliver(message);

  if (result?.ok) {
    const next = applySuccess(state, action, duty, now);
    await writeState(dir, next);
    return { action, delivered: true, duty, message };
  }

  // Delivery failed: log it, keep the state where it was so the next tick retries.
  const next = applyFailure(state, action, duty, now);
  await writeState(dir, next);
  // The log is read by a human when the notification did not arrive, so it carries the
  // message that *would* have been shown — not just an internal action name.
  await appendLog(
    dir,
    `[${new Date(now).toISOString()}] 通知未能送达（${action === 'stale' ? '大哥掉线' : '大哥恢复'}）：${result?.error ?? '未知原因'}\n`
    + `  标题：${message.title}\n`
    + `  正文：${message.body}`,
  );
  return { action, delivered: false, duty, message, error: result?.error ?? '未知原因' };
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
  const duty = evaluateDuty(config, Date.now(), intent);
  return { dataDir, duty, state, action: decideAction(state, duty) };
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
      error: result.error ?? null,
    })}\n`);
  }
}
