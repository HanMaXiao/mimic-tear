import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const LAUNCHER = fileURLToPath(new URL(
  '../miniapps/mimic-tear/miniapp/node/run-watchdog-hidden.vbs',
  import.meta.url,
));

const WSHELL = process.env.SystemRoot
  ? `${process.env.SystemRoot}\\System32\\cscript.exe`
  : 'C:\\Windows\\System32\\cscript.exe';

test('the hidden launcher is a valid script that cannot fail silently', async (t) => {
  await t.test('it parses (a syntax error here is invisible under wscript)', () => {
    // Arrange / Act: cscript reports script errors on stderr; wscript swallows them.
    let output = '';
    let failed = false;
    try {
      output = execFileSync(WSHELL, ['//Nologo', LAUNCHER], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      failed = true;
      output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    }

    // Assert: the only acceptable outcome is the "not enough arguments" code.
    assert.doesNotMatch(
      output,
      /Microsoft VBScript/,
      `the launcher must not have a runtime error:\n${output}`,
    );
    assert.equal(
      failed,
      true,
      'running it with no arguments must fail with the "not enough arguments" code',
    );
  });

  await t.test('it exits with a distinct code when given no arguments', () => {
    // Arrange / Act
    let code = 0;
    try {
      execFileSync(WSHELL, ['//Nologo', LAUNCHER], { stdio: 'ignore' });
    } catch (error) {
      code = error.status ?? -1;
    }

    // Assert
    assert.equal(code, 98, '98 = not enough arguments');
  });

  await t.test('every variable it uses is declared (Option Explicit would stop it)', () => {
    // Arrange
    const source = readFileSync(LAUNCHER, 'utf8');

    // Act
    const declared = (source.match(/^Dim\s+(.+)$/m)?.[1] ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean);

    // Assert: the loop variable is the one that bit us before.
    for (const name of ['i', 'nodeExe', 'watchdogPath', 'tail', 'command', 'exitCode']) {
      assert.ok(
        declared.includes(name),
        `"${name}" is used but not declared — Option Explicit would abort the script`,
      );
    }
  });

  await t.test('it refuses to start when the inputs do not exist', () => {
    // Arrange
    const source = readFileSync(LAUNCHER, 'utf8');

    // Act / Assert
    assert.match(source, /FileExists\(nodeExe\)/, 'a missing node.exe must be refused');
    assert.match(source, /FileExists\(watchdogPath\)/, 'a missing watchdog must be refused');
  });

  await t.test('it waits for the child so the exit code can be relayed', () => {
    // Arrange
    const source = readFileSync(LAUNCHER, 'utf8');

    // Act / Assert
    assert.match(
      source,
      /shell\.Run\([^)]*,\s*0\s*,\s*True\)/,
      'the launcher must wait, or a crash looks like success to the scheduler',
    );
    assert.match(source, /WScript\.Quit\s+exitCode/, 'the child exit code must reach the scheduler');
  });
});
