/**
 * Re-arming the watchdog's own scheduled task.
 *
 * Why the task re-arms itself
 * ---------------------------
 * The watchdog used to be a fixed five-minute timer. A timer that fires every five
 * minutes cannot be made to fire "when the answer might have changed" — so the task
 * was replaced by a **one-shot** trigger, and each run schedules the next one for the
 * moment it actually wants to look again.
 *
 * The self-rearm is the delicate part, and it is delicate for one reason: **the task
 * that is running right now is the task being replaced.** Windows is happy with that
 * (`schtasks /create /f` overwrites the registration while the current instance keeps
 * running to completion), but it means a failed rearm leaves a task with no future
 * run — the watchdog would go silent, and silently is the one thing this whole system
 * is built to avoid.
 *
 * So the rearm is written to fail *loudly and safely*:
 *
 * 1. It never throws. A rearm failure must not turn a successful tick into a failed
 *    one, and it must not stop the watchdog from writing its state or delivering its
 *    alert.
 * 2. It falls back to the old fixed interval, so the task keeps waking up even when
 *    the clever path does not work.
 * 3. It reports what it did, and the caller writes that down.
 *
 * The fallback is not a theoretical concern: the rearm needs a writable temp directory
 * and a working `schtasks.exe`, and neither is guaranteed on every machine.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The scheduled task this module re-arms. */
export const TASK_NAME = 'MimicTear-DutyWatchdog';

/**
 * The interval the task falls back to when the smart rearm cannot be applied.
 *
 * Five minutes is the old behaviour. It is deliberately conservative: a fallback that
 * fires *more* often than the smart schedule is wasteful but harmless, while one that
 * fires less often could miss an outage.
 */
export const FALLBACK_INTERVAL_MINUTES = 5;

/**
 * Run a command and capture its output.
 *
 * @param {string} file
 * @param {string[]} args
 * @param {number} [timeoutMs]
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
function exec(file, args, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: timeoutMs }, (error, stdout, stderr) => {
      resolve({
        code: error?.code ?? 0,
        stdout: String(stdout),
        stderr: String(stderr),
      });
    });
  });
}

/**
 * Escape text for an XML attribute value.
 *
 * @param {string} value
 * @returns {string}
 */
function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Format a moment the way the task scheduler wants it: local time, no timezone.
 *
 * The scheduler reads `StartBoundary` in the machine's local time, so the value has to
 * be written that way — a UTC timestamp would land hours away from the intended moment.
 *
 * @param {number} timestamp epoch ms
 * @returns {string} `YYYY-MM-DDTHH:MM:SS`
 */
export function formatLocalBoundary(timestamp) {
  const date = new Date(timestamp);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * Build the task XML for a one-shot run at a given moment.
 *
 * The one thing this XML must get right: `<Command>` is the **executable**, and
 * `<Arguments>` is everything else. Anything else in `<Command>` makes Windows treat
 * the whole string as a file path — including a `//B` switch — and the task then fails
 * in a way that looks like "the program silently did nothing" (or, worse, opens the
 * "pick an app" dialog). The exit code still reads 0, so the failure is invisible
 * from the scheduler's side.
 *
 * @param {{startBoundary:string, command:string, arguments:string, userId?:string,
 *          repetitionMinutes?:number|null}} input
 * @returns {string}
 */
export function buildRearmXml(input) {
  const userId = escapeXml(input.userId ?? '');
  // A repetition is optional: the self-rearming task is a one-shot, and the fixed
  // fallback is the same task with a repetition attached.
  const repetition = Number(input.repetitionMinutes) > 0
    ? `      <Repetition><Interval>PT${Number(input.repetitionMinutes)}M</Interval>`
      + '<StopAtDurationEnd>false</StopAtDurationEnd></Repetition>\r\n'
    : '';
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    '    <Description>Mimic Tear duty watchdog (self-rearming)</Description>',
    '  </RegistrationInfo>',
    '  <Triggers>',
    '    <TimeTrigger>',
    `      <StartBoundary>${escapeXml(input.startBoundary)}</StartBoundary>`,
    '      <Enabled>true</Enabled>',
    repetition,
    '    </TimeTrigger>',
    '  </Triggers>',
    '  <Principals>',
    '    <Principal id="Author">',
    `      <UserId>${userId}</UserId>`,
    '      <LogonType>InteractiveToken</LogonType>',
    '      <RunLevel>LeastPrivilege</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <StartWhenAvailable>true</StartWhenAvailable>',
    '    <Enabled>true</Enabled>',
    '    <Hidden>false</Hidden>',
    '    <IdleSettings>',
    '      <StopOnIdleEnd>false</StopOnIdleEnd>',
    '      <RestartOnIdle>false</RestartOnIdle>',
    '    </IdleSettings>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    `      <Command>${escapeXml(input.command)}</Command>`,
    `      <Arguments>${escapeXml(input.arguments)}</Arguments>`,
    '    </Exec>',
    '  </Actions>',
    '</Task>',
  ].join('\r\n');
}

/**
 * Write the XML with the byte order mark the scheduler insists on.
 *
 * `schtasks /xml` rejects a UTF-16 file without a BOM as malformed, and Node's
 * 'utf16le' encoding does not write one.
 *
 * @param {string} path
 * @param {string} xml
 * @returns {Promise<void>}
 */
async function writeTaskXml(path, xml) {
  const body = Buffer.from(xml, 'utf16le');
  await writeFile(path, Buffer.concat([Buffer.from([0xff, 0xfe]), body]));
}

/**
 * Re-arm the watchdog task for one run at a given moment.
 *
 * Never throws: a failure here must not turn a good tick into a bad one.
 *
 * @param {{nextCheckAt:number, command:string, arguments:string, userId?:string,
 *          taskName?:string, now?:number}} input
 * @returns {Promise<{ok:boolean, mode:'oneshot'|'fallback'|'skipped', nextCheckAt:number|null,
 *                    boundary?:string, error?:string}>}
 */
export async function rearmWatchdogTask(input) {
  const taskName = input?.taskName ?? TASK_NAME;
  const now = Number.isFinite(input?.now) ? input.now : Date.now();
  const nextCheckAt = Number(input?.nextCheckAt);

  if (!Number.isFinite(nextCheckAt) || nextCheckAt <= now) {
    return { ok: false, mode: 'skipped', nextCheckAt: null, error: '下一次检查时刻无效' };
  }

  // The boundary must be in the future by a comfortable margin: a boundary that is a
  // second away can be missed, and a missed rearm means a silent watchdog.
  const boundaryTime = nextCheckAt + 10_000;
  const boundary = formatLocalBoundary(boundaryTime);

  const xml = buildRearmXml({
    startBoundary: boundary,
    command: input.command,
    arguments: input.arguments,
    userId: input.userId,
  });

  const xmlPath = join(tmpdir(), `mimic-tear-watchdog-rearm-${process.pid}.xml`);
  try {
    await writeTaskXml(xmlPath, xml);
  } catch (error) {
    return {
      ok: false,
      mode: 'skipped',
      nextCheckAt: null,
      error: `写入 XML 失败：${error?.message ?? error}`,
    };
  }

  try {
    const result = await exec('schtasks.exe', ['/create', '/tn', taskName, '/xml', xmlPath, '/f']);
    if (result.code !== 0) {
      return {
        ok: false,
        mode: 'skipped',
        nextCheckAt: null,
        error: `注册失败：${result.stderr || result.stdout}`,
      };
    }
    return { ok: true, mode: 'oneshot', nextCheckAt: boundaryTime, boundary };
  } catch (error) {
    return {
      ok: false,
      mode: 'skipped',
      nextCheckAt: null,
      error: `注册异常：${error?.message ?? error}`,
    };
  } finally {
    await rm(xmlPath, { force: true }).catch(() => undefined);
  }
}

/**
 * Put the task back on a fixed repeating interval.
 *
 * This is the safety net: if the smart rearm cannot be applied, the watchdog still
 * wakes up regularly, exactly as it used to. A watchdog that stops waking up is
 * worse than a watchdog that wakes up too often.
 *
 * @param {{command:string, arguments:string, userId?:string, taskName?:string,
 *          intervalMinutes?:number}} input
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function restoreFallbackSchedule(input) {
  const taskName = input?.taskName ?? TASK_NAME;
  const interval = Number(input?.intervalMinutes) > 0 ? Number(input.intervalMinutes) : FALLBACK_INTERVAL_MINUTES;

  const boundary = formatLocalBoundary(Date.now() + 60_000);
  const xml = buildRearmXml({
    startBoundary: boundary,
    command: input.command,
    arguments: input.arguments,
    userId: input.userId,
    repetitionMinutes: interval,
  });

  const xmlPath = join(tmpdir(), `mimic-tear-watchdog-fallback-${process.pid}.xml`);
  try {
    await writeTaskXml(xmlPath, xml);
  } catch (error) {
    return { ok: false, error: `写入 XML 失败：${error?.message ?? error}` };
  }

  try {
    const result = await exec('schtasks.exe', ['/create', '/tn', taskName, '/xml', xmlPath, '/f']);
    if (result.code !== 0) {
      return { ok: false, error: `注册失败：${result.stderr || result.stdout}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `注册异常：${error?.message ?? error}` };
  } finally {
    await rm(xmlPath, { force: true }).catch(() => undefined);
  }
}

/**
 * Whether the task is currently registered.
 *
 * @param {string} [taskName]
 * @returns {Promise<boolean>}
 */
export async function isWatchdogTaskInstalled(taskName = TASK_NAME) {
  const result = await exec('schtasks.exe', ['/query', '/tn', taskName]);
  return result.code === 0;
}

/**
 * Stop the task from running: disable it.
 *
 * This is what "the watchdog shuts down properly" means in practice. A disabled task
 * has no next run and no process — nothing is left in the background, which is the
 * whole point.
 *
 * @param {{taskName?:string}} [options]
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function disableWatchdogTask(options = {}) {
  const taskName = options?.taskName ?? TASK_NAME;
  // A task that is not registered cannot run, so the state this function is after is
  // already true. `schtasks` reports that as an error ("the specified task name does not
  // exist"), but on a machine that never had the watchdog — a CI runner, a fresh install,
  // or a task the user deleted by hand — there is nothing left to stop. Reporting that
  // as a failure would be a fault that does not exist: the watchdog would keep saying
  // "stop_failed" forever about a task that is already gone.
  if (!(await isWatchdogTaskInstalled(taskName))) {
    return { ok: true };
  }
  const result = await exec('schtasks.exe', ['/change', '/tn', taskName, '/disable']);
  if (result.code !== 0) {
    return { ok: false, error: `禁用失败：${result.stderr || result.stdout}` };
  }
  return { ok: true };
}

/**
 * Allow the task to run again.
 *
 * Re-registering with `/create /xml /f` also re-enables a disabled task (verified on
 * this machine), so this is only needed when the registration is left in place.
 *
 * @param {{taskName?:string}} [options]
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function enableWatchdogTask(options = {}) {
  const taskName = options?.taskName ?? TASK_NAME;
  const result = await exec('schtasks.exe', ['/change', '/tn', taskName, '/enable']);
  if (result.code !== 0) {
    return { ok: false, error: `启用失败：${result.stderr || result.stdout}` };
  }
  return { ok: true };
}

/**
 * Whether the task is currently enabled.
 *
 * @param {{taskName?:string}} [options]
 * @returns {Promise<boolean>}
 */
export async function isWatchdogTaskEnabled(options = {}) {
  const taskName = options?.taskName ?? TASK_NAME;
  const result = await exec('schtasks.exe', ['/query', '/tn', taskName, '/fo', 'list', '/v']);
  return result.code === 0 && /Scheduled Task State:\s*Enabled/i.test(result.stdout);
}

/**
 * Whether the launcher script exists — the rearm points at it, so a missing file
 * means the task would run and do nothing.
 *
 * @param {string} launcherPath
 * @returns {boolean}
 */
export function launcherExists(launcherPath) {
  return Boolean(launcherPath) && existsSync(launcherPath);
}
