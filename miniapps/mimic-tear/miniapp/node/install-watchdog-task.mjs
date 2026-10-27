#!/usr/bin/env node
/**
 * Install (or remove) the Windows scheduled task that runs the duty watchdog.
 *
 * The watchdog has to run when MiniMax Code is closed — that is the whole point — so it
 * cannot live inside the Mini App's process. A Windows scheduled task is the one thing on
 * this machine that is always there.
 *
 * Why `/it` (run only when the user is logged on): a desktop toast needs a desktop to
 * land on. With no interactive session there is nothing to show, and a notification that
 * cannot be seen is just noise.
 *
 * Why the task runs through `run-watchdog-hidden.vbs`: a scheduled task that runs a
 * console program directly makes Windows allocate a console, and this machine's default
 * console host is Windows Terminal — so every run flashed a Terminal window open and
 * shut. `wscript.exe` is a GUI application and allocates no console at all.
 *
 * Usage:
 *   node install-watchdog-task.mjs install     register (or update) the task
 *   node install-watchdog-task.mjs remove      unregister it
 *   node install-watchdog-task.mjs status      show what is registered
 *   node install-watchdog-task.mjs test        run the watchdog once, right now
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRearmXml, formatLocalBoundary } from './watchdog-rearm.mjs';

const TASK_NAME = 'MimicTear-DutyWatchdog';
const WATCHDOG_PATH = join(dirname(fileURLToPath(import.meta.url)), 'watchdog.mjs');
/**
 * The hidden launcher that actually starts the watchdog.
 *
 * Running `node.exe` directly from a scheduled task makes Windows allocate a
 * console, and this machine's default console host is Windows Terminal — so the
 * task visibly flashed a Terminal window every five minutes. `wscript.exe` is a
 * GUI application and never allocates a console, so it starts the watchdog
 * without one. See `run-watchdog-hidden.vbs` for the full reasoning.
 */
const LAUNCHER_PATH = join(dirname(fileURLToPath(import.meta.url)), 'run-watchdog-hidden.vbs');
const DATA_DIR = join(homedir(), '.minimax', 'v2', 'plugin-data', 'liveboards', 'mimic-tear');
/**
 * The Windows Script Host that runs the launcher.
 *
 * Resolved to an absolute path for the same reason `node` is: a scheduled task
 * does not inherit the interactive shell's PATH.
 */
const WSCRIPT_PATH = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wscript.exe');

/**
 * Run a command and capture its output.
 *
 * @param {string} file
 * @param {string[]} args
 * @param {Record<string, string>} [env] extra environment variables for the child
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
function run(file, args, env) {
  return new Promise((res) => {
    execFile(file, args, {
      windowsHide: true,
      timeout: 60_000,
      ...(env ? { env: { ...process.env, ...env } } : {}),
    }, (error, stdout, stderr) => {
      res({ code: error?.code ?? 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/**
 * The command the task runs.
 *
 * `node` is resolved to its absolute path: a scheduled task does not inherit the
 * interactive shell's PATH, so a bare `node` may not be found at all.
 */
function buildCommand() {
  const node = process.execPath;
  return `"${node}" "${WATCHDOG_PATH}" --data-dir "${DATA_DIR}"`;
}

/**
 * The task's action: the hidden launcher, with the watchdog's command as arguments.
 *
 * The executable and its arguments are kept apart on purpose. The task scheduler
 * treats `<Command>` as the executable and `<Arguments>` as the rest — put the `//B`
 * switch or the script path in `<Command>` and Windows treats the whole string as a
 * file to open, which fails silently (or opens a "pick an app" dialog) while the
 * task still reports success.
 *
 * `schtasks /tr` strips the quotes out of the command it is handed, which breaks
 * any path containing a space. Registering through an XML file keeps the quotes
 * exactly as they are written here.
 *
 * @returns {{command: string, arguments: string}}
 */
function buildTaskAction() {
  return {
    command: WSCRIPT_PATH,
    arguments: `//B "${LAUNCHER_PATH}" "${process.execPath}" "${WATCHDOG_PATH}" --data-dir "${DATA_DIR}"`,
  };
}

/**
 * The task definition, as the XML that `schtasks /create /xml` accepts.
 *
 * The task is registered as a **one-shot**, not as a repeating timer. The watchdog
 * re-arms it after every run for the moment it actually wants to look again — so a
 * boss that is on schedule is checked once per duty period instead of once per five
 * minutes. `buildRearmXml` is the single source of truth for this XML: the installer
 * and the self-rearm must not be able to drift apart.
 *
 * @returns {string}
 */
function buildTaskXml() {
  const action = buildTaskAction();
  return buildRearmXml({
    // A boundary in the near future: the first run happens shortly after installing.
    startBoundary: formatLocalBoundary(Date.now() + 60_000),
    command: action.command,
    arguments: action.arguments,
    userId: process.env.USERNAME ?? '',
  });
}

async function install() {
  if (!existsSync(WATCHDOG_PATH)) {
    throw new Error(`找不到 watchdog：${WATCHDOG_PATH}`);
  }
  if (!existsSync(LAUNCHER_PATH)) {
    throw new Error(`找不到隐藏启动器：${LAUNCHER_PATH}`);
  }

  // The task is registered from XML, not from `schtasks /create /tr`: the `/tr`
  // form strips the quotes out of the command, which breaks paths that contain a
  // space. XML keeps them exactly as written.
  const xmlPath = join(tmpdir(), `mimic-tear-watchdog-${process.pid}.xml`);
  // `schtasks /xml` wants UTF-16 *with* a BOM: without it the file is rejected as
  // malformed XML ("元素类型声明无效"). The BOM bytes are written explicitly
  // because Node's 'utf16le' encoding does not emit one.
  const xmlBody = Buffer.from(buildTaskXml(), 'utf16le');
  await writeFile(xmlPath, Buffer.concat([Buffer.from([0xff, 0xfe]), xmlBody]));

  try {
    // /f overwrites an existing registration, so re-running this is how you update it.
    const result = await run('schtasks.exe', [
      '/create', '/tn', TASK_NAME,
      '/xml', xmlPath,
      '/f',
    ]);
    if (result.code !== 0) {
      throw new Error(`注册失败：${result.stderr || result.stdout}`);
    }
    return result.stdout.trim();
  } finally {
    await rm(xmlPath, { force: true }).catch(() => undefined);
  }
}

async function remove() {
  const result = await run('schtasks.exe', ['/delete', '/tn', TASK_NAME, '/f']);
  if (result.code !== 0) {
    throw new Error(`删除失败：${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

async function status() {
  const result = await run('schtasks.exe', ['/query', '/tn', TASK_NAME, '/fo', 'list', '/v']);
  return {
    installed: result.code === 0,
    detail: result.code === 0 ? result.stdout.trim() : result.stderr.trim(),
  };
}

/**
 * Run the watchdog once, right now, so that it re-arms the schedule itself.
 *
 * This is the manual "check now" entry point. It is also the recovery path: if the
 * task's one-shot trigger was ever missed (the machine was off, for instance), running
 * this puts the schedule back in the watchdog's own hands.
 *
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
async function arm() {
  // The marker is what authorises the watchdog to re-arm the task. This is the
  // operator's explicit path — "run the watchdog now and let it put the schedule back" —
  // so it asks for the same authorisation the scheduled task's launcher gives.
  const result = await run(process.execPath, [WATCHDOG_PATH, '--data-dir', DATA_DIR], {
    MIMIC_WATCHDOG_LAUNCHED: '1',
  });
  return result;
}

const command = process.argv[2] ?? 'status';

/**
 * Run the CLI.
 *
 * Kept behind a check on the entry point so that importing this module (to test
 * `buildTaskAction` / `buildTaskXml`) does not register or delete anything.
 *
 * @returns {Promise<void>}
 */
export async function main() {
  if (command === 'install') {
    process.stdout.write(`${await install()}\n`);
  } else if (command === 'remove') {
    process.stdout.write(`${await remove()}\n`);
  } else if (command === 'status') {
    const info = await status();
    process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
  } else if (command === 'test') {
    const result = await run(process.execPath, [WATCHDOG_PATH, '--data-dir', DATA_DIR], {
      MIMIC_WATCHDOG_LAUNCHED: '1',
    });
    process.stdout.write(`${result.stdout}${result.stderr}\n`);
  } else if (command === 'arm') {
    // Run the watchdog once so that it re-arms its own schedule.
    const result = await arm();
    process.stdout.write(`${result.stdout}${result.stderr}\n`);
    if (result.code !== 0) {
      process.exit(result.code);
    }
  } else {
    process.stderr.write(`未知命令：${command}\n可用：install / remove / status / test / arm\n`);
    process.exit(2);
  }
}

export { buildTaskAction, buildTaskXml, buildCommand, TASK_NAME, LAUNCHER_PATH, WATCHDOG_PATH, DATA_DIR, WSCRIPT_PATH };

const isEntryPoint = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isEntryPoint) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exit(1);
  }
}
