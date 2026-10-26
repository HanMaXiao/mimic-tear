/**
 * Waking the watchdog back up.
 *
 * The watchdog's lifecycle follows the host application's
 * --------------------------------------------------------
 * The duty cron only fires while the host application is open. So when the host is
 * closed, "the duty boss has gone quiet" is arithmetic rather than an incident, and a
 * watchdog that keeps running is doing work nobody asked for. The user put it plainly:
 * no useless process hanging around in the background.
 *
 * So the watchdog stops itself when the host is gone, and something has to wake it up
 * again when the host comes back.
 *
 * What wakes it
 * -------------
 * **The duty handover itself.** `patrol-cli report --duty-stamp` is the duty chain's
 * own handover, and it runs *inside* the host application — so the act of handing over
 * is the proof that the host is alive. It is the natural signal, and it is already
 * being sent: the handover stamp is written there anyway.
 *
 * The alternatives were considered and rejected:
 *
 * - *The Mini App's node runtime* (`server.mjs`): it is `on-demand`, so it only runs
 *   while the board is open. The watchdog would only wake when the user happened to
 *   open the board — not when the host came back.
 * - *A second, slower scheduled task* that re-enables the watchdog: that is another
 *   background task, which is exactly what the user asked not to have.
 * - *A WMI event trigger* on the host's process start: `schtasks /xml` rejects the
 *   subscription (the CDATA-wrapped query comes back as "unexpected node"), and it
 *   would be a fragile dependency on a query syntax that has to survive XML escaping.
 *
 * Why the gap is not lost
 * ----------------------
 * The missed rounds are not remembered by the watchdog — they are remembered by the
 * scheduler's permanent run log. `computeDutyEvidence` derives them from the
 * delivered-run timestamps, so the rounds missed while the host was closed are still
 * there and are reported by the first tick after it reopens. What turning the watchdog
 * off costs is the *timing* of the alert, not the alert itself.
 *
 * One rule the whole thing rests on
 * ---------------------------------
 * **Enabling must never break the handover.** A handover that fails because the
 * watchdog could not be re-enabled would be a catastrophic trade: the duty boss would
 * stop reporting to keep a watchdog quiet. So enabling is best-effort — a failure is
 * recorded and the handover goes through regardless.
 */

import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';

/** The scheduled task this module wakes up. */
export const WATCHDOG_TASK_NAME = 'MimicTear-DutyWatchdog';

/**
 * Run a command and capture its output.
 *
 * @param {string} file
 * @param {string[]} args
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
function exec(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 30_000 }, (error, stdout, stderr) => {
      resolve({
        code: error?.code ?? 0,
        stdout: String(stdout),
        stderr: String(stderr),
      });
    });
  });
}

/**
 * Wake the watchdog task: enable it and give it a near-term run.
 *
 * The near-term run matters: re-enabling a disabled task restores its *old* trigger,
 * which may be hours away. The watchdog has to run soon to notice the gap that
 * accumulated while it was asleep, and to re-arm itself on the new schedule.
 *
 * @param {{taskName?:string, now?:number}} [options]
 * @returns {Promise<{ok:boolean, enabled:boolean, ran:boolean, error?:string|null}>}
 */
export async function wakeWatchdog(options = {}) {
  const taskName = options?.taskName ?? WATCHDOG_TASK_NAME;

  const enabled = await exec('schtasks.exe', ['/change', '/tn', taskName, '/enable']);
  if (enabled.code !== 0) {
    return {
      ok: false,
      enabled: false,
      ran: false,
      error: `启用失败：${enabled.stderr || enabled.stdout}`,
    };
  }

  // Run it now, so the missed gap is picked up without waiting for the next trigger.
  const ran = await exec('schtasks.exe', ['/run', '/tn', taskName]);
  if (ran.code !== 0) {
    return {
      ok: false,
      enabled: true,
      ran: false,
      error: `触发失败：${ran.stderr || ran.stdout}`,
    };
  }

  return { ok: true, enabled: true, ran: true, error: null };
}

/**
 * Whether the watchdog task exists on this machine at all.
 *
 * A machine that never installed the watchdog has nothing to wake, and asking about it
 * is not an error.
 *
 * @param {{taskName?:string}} [options]
 * @returns {Promise<boolean>}
 */
export async function watchdogTaskExists(options = {}) {
  const taskName = options?.taskName ?? WATCHDOG_TASK_NAME;
  const result = await exec('schtasks.exe', ['/query', '/tn', taskName]);
  return result.code === 0;
}

/**
 * Whether the launcher script is present next to this module.
 *
 * Without it the task would start a console window, so there is no point enabling the
 * watchdog at all.
 *
 * @param {string} launcherPath
 * @returns {boolean}
 */
export function launcherPresent(launcherPath) {
  return Boolean(launcherPath) && existsSync(launcherPath);
}
