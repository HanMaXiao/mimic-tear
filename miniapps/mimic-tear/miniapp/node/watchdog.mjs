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
 * The duty chain is resolved by **name**, not by a hardcoded cron id: the scheduler was
 * re-pointed on 2026-10-22 and the runtime created a new cron definition for it. A
 * hardcoded id pointed at the deleted one, and the symptom was the worst kind — no runs at
 * all, therefore "nothing went wrong". See `duty-chain.mjs`.
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
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { sendToast } from './toast.mjs';
import { computeDutyEvidence } from './view-model.mjs';
import { RuntimeStore } from './runtime-store.mjs';
import { appendAlert, buildBoardNotice, buildDutyTruthLine, publishBoardNotice } from './watchdog-alerts.mjs';
import { DUTY_CRON_SEED, readDutyChain } from './duty-chain.mjs';
import { decideNextCheckAt } from './watchdog-schedule.mjs';
import { isHostRunning } from './host-liveness.mjs';
import {
  rearmWatchdogTask,
  restoreFallbackSchedule,
  disableWatchdogTask,
  launcherExists,
  TASK_NAME as REARM_TASK_NAME,
} from './watchdog-rearm.mjs';
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
 * The chain is resolved by name so that a re-pointed cron does not blind the watchdog: it
 * reads every generation of the chain, merged by time.
 *
 * @param {{dbPath:string, cronId?:string|null, dir?:string, duty:any, now:number}} input
 * @returns {Promise<any|null>}
 */
async function readEvidence(input) {
  let store = null;
  try {
    store = RuntimeStore.open(input.dbPath);
    const config = input.dir ? await readJson(join(input.dir, CONFIG_FILE), {}) : {};
    // The pin (the user's decision) and the seed (the built-in family hint) are separate
    // channels: a pinned id that has been deleted is a misconfiguration, not a hint.
    const pinnedCronId = typeof config?.dutyCronId === 'string' && config.dutyCronId.trim()
      ? config.dutyCronId.trim()
      : null;
    const seedCronId = input.cronId ?? DUTY_CRON_SEED;
    const { chain, runs } = readDutyChain(store, { pinnedCronId, seedCronId });
    if (!chain.active || !runs.length) return null;
    return {
      ...computeDutyEvidence({
        runs,
        periodMs: (input.duty?.dutyIntervalMinutes ?? 30) * 60_000,
        // One threshold for the whole system: the same window the board's lamp uses.
        evidenceWindowMs: (input.duty?.staleAfterMinutes ?? 45) * 60_000,
        now: input.now,
        currentStale: Boolean(input.duty?.stale),
      }),
      chain,
    };
  } catch {
    return null;
  } finally {
    store?.close();
  }
}

/**
 * Run one watchdog tick.
 *
 * @param {{dataDir?:string, now?:number, dbPath?:string, cronId?:string|null, noNotify?:boolean,
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

  const config = await readJson(join(dir, CONFIG_FILE), {});
  // The duty intent: was the boss explicitly told to rest? A missing file means "no
  // decision", which means on duty — never an excuse to stay quiet about a dead boss.
  const intent = await readJson(join(dir, INTENT_FILE), null);
  const state = await readJson(join(dir, STATE_FILE), emptyWatchdogState());

  const duty = evaluateDuty(config, now, intent);
  const evidence = await readEvidence({ dbPath, cronId: options.cronId ?? null, dir, duty, now });
  const action = decideAction(state, duty, evidence);

  // The board's notice is decided **independently of the toast's own state machine**:
  // "the toast already said it" is not the same as "the board was told". On 2026-10-22 the
  // toast fired at 18:22, the watchdog recorded "I told them", and the board stayed empty
  // for four days. The board's own ledger is the only thing that can answer "did the
  // board see it", so the notice is computed from the current state every tick.
  const boardNotice = buildBoardNotice(action, duty, evidence);
  if (boardNotice) await publishBoardNotice(dir, boardNotice);

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

  // **The identity of what this alert reports.** The same outage must not fill the user's
  // inbox on every tick, and a *different* outage must be published again: the handover
  // stamp that started the outage identifies the first, the gap's end the second.
  const identity = action === 'missed'
    ? `missed:${gapTo ?? 0}`
    : `stale:${duty.lastRunAt ?? 0}`;

  // The board notice carries the facts, not just a sentence: when the last handover was,
  // how many rounds that means, and the scheduler's own run-level evidence.
  const truth = buildDutyTruthLine(duty, evidence);
  const boardBody = truth ? `${message.body}\n${truth}` : message.body;

  if (result?.ok) {
    // Every alert is written down, not just the ones that failed to deliver: the file is
    // the channel that survives a closed board and a swallowed toast.
    await appendAlert(dir, {
      at: now,
      action,
      title: message.title,
      body: boardBody,
      delivered: true,
      error: null,
      note: null,
      gapTo,
      identity,
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
    body: boardBody,
    delivered: false,
    error: result?.error ?? null,
    note: result?.note ?? null,
    gapTo,
    identity,
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
  const evidence = await readEvidence({ dbPath: runtimeDbPath, cronId: null, dir: dataDir, duty, now });
  return { dataDir, duty, evidence, state, action: decideAction(state, duty, evidence) };
}

/**
 * Re-arm the scheduled task for the next moment a check could matter.
 *
 * This is what turns the watchdog from a fixed five-minute timer into something that
 * sleeps until the answer *could* have changed. It is deliberately defensive:
 *
 * - it never throws — a failed rearm must not turn a good tick into a failed one, and
 *   must not stop the alert from being delivered;
 * - if the smart one-shot rearm cannot be applied, the task is put back on the old
 *   fixed interval, so the watchdog keeps waking up either way;
 * - it only runs when this process is the one the task actually launches (the hidden
 *   launcher), so a manual `node watchdog.mjs` never hijacks the schedule.
 *
 * @param {{action:string, duty:any, failedDeliveries:number, now:number}} input
 * @returns {Promise<{mode:string, nextCheckAt:number|null, reason:string|null, error?:string|null}>}
 */
async function reschedule(input) {
  const decision = decideNextCheckAt({
    duty: input.duty,
    action: input.action,
    failedDeliveries: input.failedDeliveries,
    now: input.now,
  });

  const launcherPath = join(dirname(fileURLToPath(import.meta.url)), 'run-watchdog-hidden.vbs');
  const wscriptPath = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wscript.exe');

  // The command the task runs: the hidden launcher, with the watchdog's own arguments.
  //
  // The executable and its arguments are kept apart on purpose. The task scheduler
  // treats `<Command>` as the executable and `<Arguments>` as the rest — put the
  // `//B` switch or the script path in `<Command>` and Windows treats the whole
  // string as a file to open, which fails silently (or opens a "pick an app" dialog).
  const command = wscriptPath;
  const args = `//B "${launcherPath}" "${process.execPath}" "${join(dirname(fileURLToPath(import.meta.url)), 'watchdog.mjs')}" --data-dir "${dataDir}"`;

  // **The host is gone — stop.** The duty cron only fires while the host application is
  // open, so with the host closed "the boss has gone quiet" is arithmetic, not an
  // incident. There is nobody to tell and nothing to watch, and the user's line is
  // clear: no useless process left hanging in the background. Disabling the task ends
  // it completely — no next run, no process, nothing left over.
  //
  // Nothing is lost by this: the gap is remembered by the scheduler's permanent run
  // log, so the next time the host opens, the first tick reports the rounds that were
  // missed while it was closed.
  const hostAlive = await isHostRunning();
  if (!hostAlive) {
    const stopped = await disableWatchdogTask();
    return {
      mode: stopped.ok ? 'stopped' : 'stop_failed',
      nextCheckAt: null,
      reason: 'host_not_running',
      error: stopped.ok ? null : stopped.error,
    };
  }

  if (!launcherExists(launcherPath)) {
    // Without the launcher the task would start a console window; rearming it that way
    // would trade a quiet watchdog for a loud one. Keep the old schedule instead.
    const restored = await restoreFallbackSchedule({ command, arguments: args, userId: process.env.USERNAME });
    return {
      mode: restored.ok ? 'fallback' : 'skipped',
      nextCheckAt: null,
      reason: decision.reason,
      error: restored.ok ? null : restored.error,
    };
  }

  const rearmed = await rearmWatchdogTask({
    nextCheckAt: decision.nextCheckAt,
    command,
    arguments: args,
    userId: process.env.USERNAME,
    taskName: REARM_TASK_NAME,
  });

  if (rearmed.ok) {
    return { mode: 'oneshot', nextCheckAt: rearmed.nextCheckAt, reason: decision.reason, error: null };
  }

  // The smart path failed: fall back to the fixed interval rather than going silent.
  const restored = await restoreFallbackSchedule({ command, arguments: args, userId: process.env.USERNAME });
  return {
    mode: restored.ok ? 'fallback' : 'skipped',
    nextCheckAt: null,
    reason: decision.reason,
    error: restored.ok ? rearmed.error : `${rearmed.error}；回退也失败：${restored.error}`,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // **Is the host even running?** The duty cron only fires while the host application is
  // open, so with the host closed the watchdog has nothing to watch and nobody to tell:
  // "the boss has gone quiet" would be arithmetic, not an incident. It stops itself
  // instead — completely, leaving no task and no process behind.
  //
  // This happens *before* the tick, so no alert is raised for a condition that is simply
  // "the application is closed". The missed rounds are not lost: they live in the
  // scheduler's permanent run log, and the first tick after the host reopens reports
  // them.
  const hostAlive = await isHostRunning();
  if (!hostAlive) {
    const stopped = await disableWatchdogTask();
    process.stdout.write(`${JSON.stringify({
      action: 'skipped',
      delivered: false,
      // The reason the watchdog stopped, in the words of the thing it noticed.
      schedule: {
        mode: stopped.ok ? 'stopped' : 'stop_failed',
        reason: 'host_not_running',
        nextCheckAt: null,
        error: stopped.ok ? null : stopped.error,
      },
      error: null,
    })}\n`);
    process.exit(stopped.ok ? 0 : 1);
  }

  const result = await runWatchdog({ dryRun });
  if (dryRun) {
    const preview = await inspect();
    process.stdout.write(`${JSON.stringify(preview, null, 2)}\n`);
  } else {
    // The schedule is computed from the facts of this tick, then the task is re-armed.
    const state = await readJson(join(dataDir, STATE_FILE), emptyWatchdogState());
    const schedule = await reschedule({
      action: result.action,
      duty: result.duty,
      failedDeliveries: state?.failedDeliveries ?? 0,
      now: Date.now(),
    });

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
      chain: result.evidence?.chain ?? null,
      // The schedule: when this watchdog will look again, and why.
      schedule: {
        mode: schedule.mode,
        reason: schedule.reason,
        nextCheckAt: schedule.nextCheckAt,
        error: schedule.error ?? null,
      },
      error: result.error ?? null,
    })}\n`);
  }
}
