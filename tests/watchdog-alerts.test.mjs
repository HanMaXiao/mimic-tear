import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PatrolStore } from '../miniapps/mimic-tear/miniapp/node/patrol-store.mjs';
import { ProjectService } from '../miniapps/mimic-tear/miniapp/node/project-service.mjs';
import { readAlerts } from '../miniapps/mimic-tear/miniapp/node/watchdog-alerts.mjs';
import { runWatchdog } from '../miniapps/mimic-tear/miniapp/node/watchdog.mjs';
import { createApp } from '../miniapps/mimic-tear/miniapp/node/server.mjs';
import { tmpDir, cleanupDir } from './helpers/fixture.mjs';

const MINUTE = 60_000;
const NOW = Date.parse('2026-10-20T12:00:00Z');
const CLI = fileURLToPath(new URL('../miniapps/mimic-tear/miniapp/node/watchdog.mjs', import.meta.url));

/** A board directory whose duty boss stopped handing over an hour ago. */
function writeStaleConfig(dir) {
  writeFileSync(
    join(dir, 'patrol-config.json'),
    JSON.stringify({ enabled: true, intervalMinutes: 15, dutyIntervalMinutes: 30, lastRunAt: NOW - 60 * MINUTE }),
    'utf8',
  );
}

test('B2：送达成功也要留痕', async () => {
  const dir = tmpDir();
  try {
    writeStaleConfig(dir);
    const result = await runWatchdog({
      dataDir: dir,
      dbPath: join(dir, 'no-such-db.sqlite'),
      now: NOW,
      deliver: async () => ({ ok: true }),
    });

    assert.equal(result.action, 'stale');
    assert.equal(result.delivered, true);

    const alerts = await readAlerts(dir);
    assert.equal(alerts.length, 1, '送达成功了也要写下');
    assert.equal(alerts[0].action, 'stale');
    assert.equal(alerts[0].delivered, true);
    assert.equal(alerts[0].error, null);
    assert.match(alerts[0].title, /掉线/);
  } finally {
    cleanupDir(dir);
  }
});

test('B3：送达失败也要留痕 + 记原因', async () => {
  const dir = tmpDir();
  try {
    writeStaleConfig(dir);
    const result = await runWatchdog({
      dataDir: dir,
      dbPath: join(dir, 'no-such-db.sqlite'),
      now: NOW,
      deliver: async () => {
        throw new Error('模拟投递失败');
      },
    });

    assert.equal(result.delivered, false);

    const alerts = await readAlerts(dir);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].delivered, false);
    assert.match(alerts[0].error, /模拟投递失败/);
    assert.match(alerts[0].body, /分钟没有交班/);
  } finally {
    cleanupDir(dir);
  }
});

test('B4：看板读得到告警', async () => {
  const dir = tmpDir();
  try {
    writeStaleConfig(dir);
    await runWatchdog({
      dataDir: dir,
      dbPath: join(dir, 'no-such-db.sqlite'),
      now: NOW,
      deliver: async () => ({ ok: true }),
    });

    // The service reads the same file the watchdog wrote.
    const service = new ProjectService({
      store: null,
      readPlan: async () => null,
      skills: { skills: [], failures: [] },
      domains: [],
      persistence: null,
      boss: null,
      patrol: new PatrolStore(dir),
    });
    const payload = await service.getWatchdogAlerts({ limit: 5 });
    assert.equal(payload.alerts.length, 1);
    assert.equal(payload.alerts[0].action, 'stale');
    assert.equal(payload.alerts[0].delivered, true);
    assert.equal(typeof payload.alerts[0].at, 'number');
    assert.equal(typeof payload.alerts[0].title, 'string');
    assert.equal(typeof payload.alerts[0].body, 'string');

    // And the route hands it over.
    const app = createApp({
      service: { getWatchdogAlerts: async () => payload },
      clientDir: dir,
    });
    const server = createServer((request, response) => {
      void app.handler(request, response);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address();
      const response = await fetch(`http://127.0.0.1:${port}/api/watchdog/alerts`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.alerts.length, 1);
      assert.equal(body.alerts[0].action, 'stale');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    cleanupDir(dir);
  }
});

test('B5：无头可跑——退出码 0 且告警文件被创建', () => {
  const dir = tmpDir();
  try {
    writeStaleConfig(dir);
    // `--no-notify` is the headless mode: the file is the only channel, nothing pops up.
    execFileSync(
      process.execPath,
      [CLI, '--data-dir', dir, '--no-notify', '--db', join(dir, 'no-such-db.sqlite')],
      { encoding: 'utf8' },
    );

    const raw = readFileSync(join(dir, 'watchdog-alert.log'), 'utf8');
    const rows = raw.trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].delivered, false);
    assert.match(rows[0].note, /no-notify/);
  } finally {
    cleanupDir(dir);
  }
});

test('B6：同一段空档 / 同一次 stale 只写一条', async () => {
  const dir = tmpDir();
  try {
    writeStaleConfig(dir);
    const deliver = async () => ({ ok: true });

    const first = await runWatchdog({
      dataDir: dir,
      dbPath: join(dir, 'no-such-db.sqlite'),
      now: NOW,
      deliver,
    });
    const second = await runWatchdog({
      dataDir: dir,
      dbPath: join(dir, 'no-such-db.sqlite'),
      now: NOW + MINUTE,
      deliver,
    });

    assert.equal(first.action, 'stale');
    assert.equal(second.action, 'none', '同一次掉线不重复报');
    const alerts = await readAlerts(dir);
    assert.equal(alerts.length, 1, '文件里也只有一条');
  } finally {
    cleanupDir(dir);
  }
});

test('告警日志是 JSONL：旧格式的行跳过，不算错', async () => {
  const dir = tmpDir();
  try {
    writeFileSync(
      join(dir, 'watchdog-alert.log'),
      '[2026-10-21T00:00:00.000Z] 大哥掉线（旧格式的纯文本行）\n'
      + '{"at":1,"action":"stale","title":"t","body":"b","delivered":true,"error":null,"note":null,"gapTo":null}\n',
      'utf8',
    );
    const alerts = await readAlerts(dir);
    assert.equal(alerts.length, 1, '旧格式的行被跳过，新的 JSON 行读得出来');
    assert.equal(alerts[0].action, 'stale');
  } finally {
    cleanupDir(dir);
  }
});
