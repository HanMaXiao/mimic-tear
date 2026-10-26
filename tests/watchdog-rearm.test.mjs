import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRearmXml,
  formatLocalBoundary,
  FALLBACK_INTERVAL_MINUTES,
  launcherExists,
  TASK_NAME,
} from '../miniapps/mimic-tear/miniapp/node/watchdog-rearm.mjs';

const ACTION = {
  command: '"C:\\Windows\\System32\\wscript.exe" //B "C:\\path\\run-watchdog-hidden.vbs"',
  arguments: '"C:\\nvm4w\\nodejs\\node.exe" "C:\\path\\watchdog.mjs" --data-dir "C:\\data dir"',
};

test('the watchdog task is re-armed as a one-shot', async (t) => {
  await t.test('a one-shot has no repetition', () => {
    // Arrange / Act
    const xml = buildRearmXml({
      startBoundary: '2026-10-26T14:30:00',
      command: ACTION.command,
      arguments: ACTION.arguments,
      userId: '12391',
    });

    // Assert
    assert.doesNotMatch(xml, /<Repetition>/, 'the self-rearming task must not repeat on its own');
    assert.match(xml, /<StartBoundary>2026-10-26T14:30:00<\/StartBoundary>/);
  });

  await t.test('the fallback schedule does repeat', () => {
    // Arrange / Act
    const xml = buildRearmXml({
      startBoundary: '2026-10-26T14:30:00',
      command: ACTION.command,
      arguments: ACTION.arguments,
      userId: '12391',
      repetitionMinutes: FALLBACK_INTERVAL_MINUTES,
    });

    // Assert
    assert.match(xml, /<Interval>PT5M<\/Interval>/, 'the fallback must keep waking up on a fixed interval');
  });

  await t.test('the quotes in the command survive into the XML', () => {
    // Arrange / Act
    const xml = buildRearmXml({
      startBoundary: '2026-10-26T14:30:00',
      command: ACTION.command,
      arguments: ACTION.arguments,
      userId: '12391',
    });

    // Assert
    assert.match(xml, /&quot;C:\\Windows\\System32\\wscript\.exe&quot;/, 'quotes must be escaped, not dropped');
    assert.match(xml, /&quot;C:\\data dir&quot;/, 'a path with a space must keep its quotes');
  });

  await t.test('the task stays in the interactive session, so the toast can land', () => {
    // Arrange / Act
    const xml = buildRearmXml({
      startBoundary: '2026-10-26T14:30:00',
      command: ACTION.command,
      arguments: ACTION.arguments,
      userId: '12391',
    });

    // Assert
    assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/);
    assert.match(xml, /<StartWhenAvailable>true<\/StartWhenAvailable>/, 'a missed run must still happen later');
  });

  await t.test('<Command> is the executable alone — anything else fails silently', () => {
    // Arrange / Act: this is the shape the task actually uses.
    const xml = buildRearmXml({
      startBoundary: '2026-10-26T14:30:00',
      command: 'C:\\Windows\\System32\\wscript.exe',
      arguments: '//B "C:\\path\\run.vbs" "C:\\node.exe" "C:\\watchdog.mjs"',
      userId: '12391',
    });

    // Assert: the scheduler treats <Command> as the executable and <Arguments> as the
    // rest. A `//B` switch or a script path inside <Command> makes Windows treat the
    // whole string as a file to open — the task then fails while still reporting 0.
    const command = xml.match(/<Command>([^<]*)<\/Command>/)?.[1];
    const args = xml.match(/<Arguments>([^<]*)<\/Arguments>/)?.[1];
    assert.equal(command, 'C:\\Windows\\System32\\wscript.exe', '<Command> must be the executable alone');
    assert.doesNotMatch(command, /\/\/B/, '<Command> must not carry a switch');
    assert.doesNotMatch(command, /\.vbs/, '<Command> must not carry the script path');
    assert.match(args, /^\/\/B &quot;/, 'the switch belongs in <Arguments>');
  });
});

test('the trigger boundary is written in local time', async (t) => {
  await t.test('the format is what the task scheduler expects', () => {
    // Arrange
    const when = new Date(2026, 9, 26, 14, 30, 5);

    // Act
    const boundary = formatLocalBoundary(when.getTime());

    // Assert
    assert.equal(boundary, '2026-10-26T14:30:05');
    assert.match(boundary, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  });

  await t.test('the local time is the local time, not UTC', () => {
    // Arrange: a moment whose UTC and local renderings differ.
    const when = new Date(2026, 0, 1, 0, 30, 0);

    // Act
    const boundary = formatLocalBoundary(when.getTime());

    // Assert
    assert.equal(boundary, '2026-01-01T00:30:00', 'the scheduler reads the boundary in local time');
  });

  await t.test('single digits are padded', () => {
    // Arrange
    const when = new Date(2026, 0, 2, 3, 4, 5);

    // Act
    const boundary = formatLocalBoundary(when.getTime());

    // Assert
    assert.equal(boundary, '2026-01-02T03:04:05');
  });
});

test('the rearm module knows what it is guarding', async (t) => {
  await t.test('the task name is the one the installer registers', () => {
    // Assert
    assert.equal(TASK_NAME, 'MimicTear-DutyWatchdog');
  });

  await t.test('the fallback interval is the old fixed behaviour', () => {
    // Assert
    assert.equal(FALLBACK_INTERVAL_MINUTES, 5);
  });

  await t.test('a missing launcher is detected', () => {
    // Assert
    assert.equal(launcherExists('C:\\definitely\\not\\here.vbs'), false);
    assert.equal(launcherExists(''), false);
  });
});
