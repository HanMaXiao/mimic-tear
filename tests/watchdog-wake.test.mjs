import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  launcherPresent,
  wakeWatchdog,
  watchdogTaskExists,
  WATCHDOG_TASK_NAME,
} from '../miniapps/mimic-tear/miniapp/node/watchdog-wake.mjs';

const CLI = fileURLToPath(new URL('../miniapps/mimic-tear/miniapp/node/patrol-cli.mjs', import.meta.url));
const NODE = process.execPath;

test('the watchdog is woken by the duty handover', async (t) => {
  await t.test('it names the task the installer registers', () => {
    // Assert
    assert.equal(WATCHDOG_TASK_NAME, 'MimicTear-DutyWatchdog');
  });

  await t.test('a missing launcher means there is nothing worth waking', () => {
    // Assert
    assert.equal(launcherPresent('C:\\definitely\\not\\here.vbs'), false);
    assert.equal(launcherPresent(''), false);
  });
});

test('a handover is never broken by a watchdog that cannot be woken', async (t) => {
  await t.test('the duty report succeeds even when the watchdog cannot be enabled', () => {
    // Arrange: a real report against an isolated board directory.
    const dir = mkdtempSync(join(tmpdir(), 'mimic-handover-'));
    try {
      const payload = join(dir, 'report.json');
      writeFileSync(payload, JSON.stringify({ findings: [], answered: [] }), 'utf8');

      // Act: the duty chain's own report (the one that refreshes the handover stamp).
      const output = execFileSync(NODE, [
        CLI,
        'report',
        '--file',
        payload,
        '--duty-stamp',
        '--data-dir',
        dir,
      ], { encoding: 'utf8' });

      // Assert: the handover went through, whatever happened to the watchdog.
      const result = JSON.parse(output);
      assert.equal(result.ok, true, 'the handover must succeed');
      assert.equal(result.dutyStamp, true, 'the handover stamp must be refreshed');
      assert.ok('watchdog' in result, 'the watchdog outcome must be reported');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test('a report WITHOUT the duty stamp does not touch the watchdog', () => {
    // Arrange
    const dir = mkdtempSync(join(tmpdir(), 'mimic-handover-'));
    try {
      const payload = join(dir, 'report.json');
      writeFileSync(payload, JSON.stringify({ findings: [], answered: [] }), 'utf8');

      // Act: another line's report — not the duty chain's.
      const output = execFileSync(NODE, [
        CLI,
        'report',
        '--file',
        payload,
        '--data-dir',
        dir,
      ], { encoding: 'utf8' });

      // Assert
      const result = JSON.parse(output);
      assert.equal(result.dutyStamp, false);
      assert.equal(result.watchdog, null, 'a stranger must not wake the watchdog');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('waking the watchdog is best-effort and says what it did', async (t) => {
  await t.test('on this machine the task either exists or reports why', async () => {
    // Arrange / Act
    const exists = await watchdogTaskExists();

    // Assert: no exception, and a boolean either way.
    assert.equal(typeof exists, 'boolean');
  });

  await t.test('waking a task that does not exist fails without throwing', async () => {
    // Arrange / Act
    const result = await wakeWatchdog({ taskName: 'MimicTear-DefinitelyNotATask' });

    // Assert
    assert.equal(result.ok, false);
    assert.equal(result.enabled, false);
    assert.equal(result.ran, false);
    assert.ok(result.error, 'a failure must carry a reason');
  });
});
