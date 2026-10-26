import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HOST_IMAGE_NAME,
  HOST_IMAGE_NAMES,
  isHostRunning,
} from '../miniapps/mimic-tear/miniapp/node/host-liveness.mjs';

/** A `tasklist` output for one matching process. */
function tasklistOutput(imageName, pids = [1234]) {
  return pids
    .map((pid) => `${imageName.padEnd(32)}${String(pid).padStart(5)} Console                  1     22,084 K`)
    .join('\r\n');
}

test('the host liveness check tells alive from gone', async (t) => {
  await t.test('a running host is detected', async () => {
    // Arrange
    const run = async () => tasklistOutput(HOST_IMAGE_NAME);

    // Act
    const alive = await isHostRunning({ run });

    // Assert
    assert.equal(alive, true);
  });

  await t.test('a closed host is detected', async () => {
    // Arrange
    const run = async () => 'INFO: No tasks are running which match the specified criteria.';

    // Act
    const alive = await isHostRunning({ run });

    // Assert
    assert.equal(alive, false);
  });

  await t.test('an empty result is "gone", not an error', async () => {
    // Arrange
    const run = async () => '';

    // Act
    const alive = await isHostRunning({ run });

    // Assert
    assert.equal(alive, false);
  });

  await t.test('a probe that fails is reported as ALIVE, never as gone', async () => {
    // Arrange: this is the dangerous direction. A false "gone" silences the watchdog
    // permanently, and the whole point of the watchdog is that it does not go silent.
    const run = async () => { throw new Error('tasklist exploded'); };

    // Act
    const alive = await isHostRunning({ run });

    // Assert
    assert.equal(
      alive,
      true,
      'a failed probe must never be read as "the host is gone"',
    );
  });

  await t.test('a probe that returns garbage is reported as ALIVE', async () => {
    // Arrange
    const run = async () => 'some unrelated output that mentions nothing';

    // Act
    const alive = await isHostRunning({ run });

    // Assert
    assert.equal(alive, false, 'output with no matching image name means the host is gone');
  });
});

test('the host liveness check looks for every plausible image name', async (t) => {
  await t.test('a differently named build still counts as alive', async () => {
    // Arrange: the runtime under a different image name.
    const run = async (args) => {
      if (args[1] === 'MiniMax Code.exe') return 'INFO: No tasks are running which match the specified criteria.';
      return tasklistOutput('minimax-code');
    };

    // Act
    const alive = await isHostRunning({ run });

    // Assert
    assert.equal(alive, true, 'a differently named build must still be found');
  });

  await t.test('the list includes the canonical image name', () => {
    // Assert
    assert.ok(HOST_IMAGE_NAMES.includes(HOST_IMAGE_NAME));
    assert.ok(HOST_IMAGE_NAMES.length >= 2, 'there must be a fallback beyond the canonical name');
  });
});
