/**
 * Is the host application still running?
 *
 * Why this module exists
 * ----------------------
 * The duty cron lives *inside* the host application: it only fires while that
 * application is open. So when the application is closed, "the duty boss has gone
 * quiet" is not an incident — it is arithmetic. The watchdog would keep "discovering"
 * an outage that is simply the application being closed, and it would keep paying for
 * the privilege of saying so.
 *
 * The user's line is blunt and right: *I do not want a useless process hanging around
 * in the background.* So the watchdog stops itself when its host is gone.
 *
 * Why nothing is lost
 * -------------------
 * The gap is not remembered by the watchdog — it is remembered by the scheduler's
 * permanent run log. `computeDutyEvidence` derives the missing rounds from the
 * delivered-run timestamps, so a four-day gap (201 rounds) is still there after the
 * fact and is still reported the next time the watchdog runs. Turning the watchdog off
 * while the application is closed costs nothing but the *timing* of the alert.
 *
 * Why `tasklist` and not WMI
 * -------------------------
 * The check has to be cheap (it runs on every tick) and dependable (a wrong "not
 * running" would silence the watchdog). WMI took 204ms per query and can fail for
 * reasons that have nothing to do with the application. `tasklist` took 140ms, needs no
 * COM, and reports "no such process" as an empty result rather than an error.
 */

import { execFile } from 'node:child_process';

/**
 * The host application's image name.
 *
 * Matched as a prefix of the image name, so both `MiniMax Code.exe` and a
 * `MiniMax Code` variant are found.
 */
export const HOST_IMAGE_NAME = 'MiniMax Code.exe';

/**
 * Other image names that count as "the host is up".
 *
 * The runtime may run under a differently named process (a helper, an updater, a
 * development build). If none of these are found the watchdog would conclude the host
 * is gone and stop — so the list is deliberately generous. A false "alive" costs one
 * extra tick; a false "gone" costs the watchdog its job.
 */
export const HOST_IMAGE_NAMES = Object.freeze([
  HOST_IMAGE_NAME,
  'MiniMax Code',
  'minimax-code',
]);

/**
 * How long to wait for `tasklist`.
 *
 * Generous enough for a cold machine, short enough that a hung call cannot wedge the
 * watchdog's own tick.
 */
const TASKLIST_TIMEOUT_MS = 15_000;

/**
 * Run `tasklist` and return its output.
 *
 * @param {string[]} filterArgs
 * @returns {Promise<string>}
 */
function runTasklist(filterArgs) {
  return new Promise((resolve) => {
    execFile(
      'tasklist.exe',
      ['/FI', `IMAGENAME eq ${filterArgs[1]}`, '/NH'],
      { windowsHide: true, timeout: TASKLIST_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        // A non-zero exit means "nothing matched" for `/NH` queries, which is an
        // answer, not a failure. Only a hard error is treated as unknown.
        resolve(error ? '' : String(stdout));
      },
    );
  });
}

/**
 * Whether the host application is running.
 *
 * A check that cannot be performed is reported as "running": stopping the watchdog
 * because a probe failed would be the worst possible way to be wrong — it would turn a
 * transient problem into a permanently silent watchdog.
 *
 * @param {{imageNames?:string[], run?:Function}} [options]
 * @returns {Promise<boolean>}
 */
export async function isHostRunning(options = {}) {
  const imageNames = options.imageNames ?? HOST_IMAGE_NAMES;
  const run = options.run ?? runTasklist;

  for (const imageName of imageNames) {
    let output = '';
    try {
      output = String(await run(['/FI', imageName]));
    } catch {
      // The probe itself failed. That is not evidence that the host is gone — it is
      // evidence that we could not look. Report "alive" and keep the watchdog running:
      // a false "gone" would silence it permanently, and silence is the one outcome
      // this whole system exists to prevent.
      return true;
    }
    const lines = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      // `tasklist /NH` prints "INFO: No tasks are running..." when nothing matches.
      .filter((line) => !/^INFO:/i.test(line));
    if (lines.some((line) => line.toLowerCase().startsWith(imageName.toLowerCase()))) {
      return true;
    }
  }
  return false;
}
