import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  buildCommand,
  buildTaskAction,
  buildTaskXml,
  DATA_DIR,
  LAUNCHER_PATH,
  TASK_NAME,
  WATCHDOG_PATH,
  WSCRIPT_PATH,
} from '../miniapps/mimic-tear/miniapp/node/install-watchdog-task.mjs';
import { buildRearmXml } from '../miniapps/mimic-tear/miniapp/node/watchdog-rearm.mjs';

const NODE_DIR = fileURLToPath(new URL('../miniapps/mimic-tear/miniapp/node/', import.meta.url));

test('watchdog scheduled task is registered without a visible console window', async (t) => {
  await t.test('the launcher file ships next to the watchdog', () => {
    // Arrange / Act
    const exists = existsSync(LAUNCHER_PATH);

    // Assert
    assert.equal(exists, true, 'the hidden launcher must exist in the published plugin dir');
    assert.equal(
      LAUNCHER_PATH.endsWith('run-watchdog-hidden.vbs'),
      true,
      'the launcher must be the VBS file, not something else',
    );
  });

  await t.test('the task action launches wscript, not node directly', () => {
    // Arrange / Act
    const action = buildTaskAction();

    // Assert
    assert.match(
      action.command,
      /wscript\.exe/i,
      'the task must start through wscript.exe: it is a GUI app and allocates no console',
    );
    assert.match(
      action.arguments,
      /run-watchdog-hidden\.vbs/,
      'the task must go through the hidden launcher',
    );
    assert.doesNotMatch(
      action.command,
      /node\.exe/i,
      'node.exe must not be the task action itself: a console app makes Windows start a console host',
    );
  });

  await t.test('the command is the executable alone; the rest is arguments', () => {
    // Arrange / Act
    const action = buildTaskAction();

    // Assert: the scheduler treats <Command> as the executable and <Arguments> as the
    // rest. A switch or a script path inside <Command> makes Windows try to *open*
    // the whole string as a file — the task then fails while still reporting success.
    assert.doesNotMatch(
      action.command,
      /\/\/B|\.vbs|"/,
      '<Command> must be the bare executable path',
    );
    assert.match(action.arguments, /^\/\/B "/, 'the //B switch belongs in the arguments');
  });

  await t.test('the launcher receives the watchdog command as arguments', () => {
    // Arrange / Act
    const action = buildTaskAction();

    // Assert
    assert.match(action.arguments, /watchdog\.mjs/, 'the launcher must be told which script to run');
    assert.match(action.arguments, /--data-dir/, 'the data dir must be passed through');
    assert.match(
      action.arguments,
      new RegExp(DATA_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      'the data dir must reach the watchdog',
    );
    assert.match(
      action.arguments,
      /"[^"]*watchdog\.mjs"/,
      'paths must stay quoted: a scheduled task does not tolerate unquoted spaces',
    );
  });

  await t.test('the launcher waits for the child so the exit code survives', () => {
    // Arrange
    const launcher = readFileSync(LAUNCHER_PATH, 'utf8');

    // Act
    const waits = /shell\.Run\([^)]*,\s*0\s*,\s*True\)/.test(launcher);
    const relays = /WScript\.Quit\s+exitCode/.test(launcher);

    // Assert
    assert.equal(waits, true, 'the launcher must wait for the child, or the exit code is lost');
    assert.equal(
      relays,
      true,
      'the launcher must relay the child exit code to the scheduler, or a crash looks like success',
    );
  });

  await t.test('the launcher hides the child window', () => {
    // Arrange
    const launcher = readFileSync(LAUNCHER_PATH, 'utf8');

    // Act
    const hidden = /shell\.Run\([^)]*,\s*0\s*,/.test(launcher);

    // Assert
    assert.equal(hidden, true, 'window style 0 (hidden) is what keeps a console off the screen');
  });

  await t.test('the task xml keeps the quotes the command needs', () => {
    // Arrange / Act
    const xml = buildTaskXml();

    // Assert
    assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/, 'a toast needs an interactive session');
    assert.match(
      xml,
      /<Command>[^<]*[\\/]wscript\.exe<\/Command>/,
      'the command must be the bare executable, with its path intact',
    );
    assert.doesNotMatch(
      xml,
      /<Command>[^<]*&quot;/,
      'the command must not be quoted: Windows treats a quoted <Command> as a file path',
    );
    assert.match(
      xml,
      /<Arguments>[^<]*&quot;[^<]*watchdog\.mjs[^<]*<\/Arguments>/,
      'the arguments must keep their quotes: a path with a space needs them',
    );
  });

  await t.test('the task is a one-shot, because the watchdog re-arms it', () => {
    // Arrange / Act
    const xml = buildTaskXml();

    // Assert
    assert.doesNotMatch(
      xml,
      /<Repetition>/,
      'a fixed repetition would fight the watchdog\'s own schedule',
    );
    assert.match(xml, /<StartBoundary>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}<\/StartBoundary>/);
  });

  await t.test('the old direct-node command is still available for comparison', () => {
    // Arrange / Act
    const command = buildCommand();

    // Assert
    assert.match(command, /node\.exe/, 'the direct command still exists');
    assert.match(command, /watchdog\.mjs/, 'and still points at the watchdog');
  });

  await t.test('the installer and the self-rearm share one task definition', () => {
    // Arrange / Act
    const installed = buildTaskXml();
    const rearmed = buildRearmXml({
      startBoundary: '2026-10-26T14:30:00',
      command: buildTaskAction().command,
      arguments: buildTaskAction().arguments,
      userId: '12391',
    });

    // Assert: the two must not be able to drift apart.
    const settingsOf = (xml) => xml.slice(xml.indexOf('<Settings>'));
    assert.equal(
      settingsOf(installed),
      settingsOf(rearmed),
      'the installer and the self-rearm must define the task identically',
    );
  });

  await t.test('the task name and the watchdog path are unchanged', () => {
    // Assert
    assert.equal(TASK_NAME, 'MimicTear-DutyWatchdog');
    assert.equal(WATCHDOG_PATH.endsWith('watchdog.mjs'), true);
    assert.equal(
      WSCRIPT_PATH.endsWith('wscript.exe'),
      true,
      'wscript must be an absolute path: a scheduled task does not inherit PATH',
    );
  });
});
