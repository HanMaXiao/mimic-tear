import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PatrolStore } from '../miniapps/mimic-tear/miniapp/node/patrol-store.mjs';
import { makeRuntimeDb, tmpDir, cleanupDir } from './helpers/fixture.mjs';

const CLI = fileURLToPath(new URL('../miniapps/mimic-tear/miniapp/node/patrol-cli.mjs', import.meta.url));

/**
 * The handover stamp belongs to the duty chain alone.
 *
 * The lamp exists to notice that the duty boss went quiet. While any report could refresh
 * the stamp, a stranger's report fed it and a real dropout stayed invisible — on
 * 2026-10-22 that is exactly what happened: the duty boss's 07:37 round never handed over,
 * and another line's report stamped it for him.
 */
test('交班戳只能由大哥那条线写', async () => {
  const dir = tmpDir();
  try {
    const dataDir = join(dir, 'data');
    const dbPath = makeRuntimeDb(dir);
    const patrol = new PatrolStore(dataDir);
    const payload = join(dir, 'report.json');
    writeFileSync(
      payload,
      JSON.stringify({ findings: [{ title: '一条结论', body: '正文', severity: 'low' }] }),
      'utf8',
    );

    // A known stamp, so "did it move?" is a fact and not a guess.
    await patrol.setConfig({ lastRunAt: 123456 });

    // Another line reports: the stamp must not move.
    execFileSync(
      process.execPath,
      [CLI, 'report', '--file', payload, '--data-dir', dataDir, '--db', dbPath],
      { encoding: 'utf8' },
    );
    const afterOther = (await patrol.getConfig()).lastRunAt;
    assert.equal(afterOther, 123456, '别的线 report 之后交班戳不许动');

    // The duty chain reports: the stamp moves.
    execFileSync(
      process.execPath,
      [CLI, 'report', '--file', payload, '--duty-stamp', '--data-dir', dataDir, '--db', dbPath],
      { encoding: 'utf8' },
    );
    const afterDuty = (await patrol.getConfig()).lastRunAt;
    assert.ok(afterDuty > 123456, '大哥的 report 之后交班戳要前进');

    // The report itself is not lost — only the stamp is now gated.
    const findings = await patrol.list();
    assert.equal(findings.length, 2, '两条报告都要写进结论池');
  } finally {
    cleanupDir(dir);
  }
});
