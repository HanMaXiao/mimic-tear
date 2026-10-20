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
 * Usage:
 *   node install-watchdog-task.mjs install     register (or update) the task
 *   node install-watchdog-task.mjs remove      unregister it
 *   node install-watchdog-task.mjs status      show what is registered
 *   node install-watchdog-task.mjs test        run the watchdog once, right now
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TASK_NAME = 'MimicTear-DutyWatchdog';
const WATCHDOG_PATH = join(dirname(fileURLToPath(import.meta.url)), 'watchdog.mjs');
const DATA_DIR = join(homedir(), '.minimax', 'v2', 'plugin-data', 'liveboards', 'mimic-tear');

/**
 * Run a command and capture its output.
 *
 * @param {string} file
 * @param {string[]} args
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
function run(file, args) {
  return new Promise((res) => {
    execFile(file, args, { windowsHide: true, timeout: 60_000 }, (error, stdout, stderr) => {
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

async function install() {
  if (!existsSync(WATCHDOG_PATH)) {
    throw new Error(`找不到 watchdog：${WATCHDOG_PATH}`);
  }
  // /f overwrites an existing registration, so re-running this is how you update it.
  const result = await run('schtasks.exe', [
    '/create', '/tn', TASK_NAME,
    '/tr', buildCommand(),
    '/sc', 'minute', '/mo', '5',
    '/it', '/f',
  ]);
  if (result.code !== 0) {
    throw new Error(`注册失败：${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
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

const command = process.argv[2] ?? 'status';

try {
  if (command === 'install') {
    process.stdout.write(`${await install()}\n`);
  } else if (command === 'remove') {
    process.stdout.write(`${await remove()}\n`);
  } else if (command === 'status') {
    const info = await status();
    process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
  } else if (command === 'test') {
    const result = await run(process.execPath, [WATCHDOG_PATH, '--data-dir', DATA_DIR]);
    process.stdout.write(`${result.stdout}${result.stderr}\n`);
  } else {
    process.stderr.write(`未知命令：${command}\n可用：install / remove / status / test\n`);
    process.exit(2);
  }
} catch (error) {
  process.stderr.write(`${error?.message ?? error}\n`);
  process.exit(1);
}
