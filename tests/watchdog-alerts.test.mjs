import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PatrolStore } from '../miniapps/mimic-tear/miniapp/node/patrol-store.mjs';
import { ProjectService } from '../miniapps/mimic-tear/miniapp/node/project-service.mjs';
import { readAlerts } from '../miniapps/mimic-tear/miniapp/node/watchdog-alerts.mjs';
import { runWatchdog } from '../miniapps/mimic-tear/miniapp/node/watchdog.mjs';
import { HOST_IMAGE_NAME, isHostRunning } from '../miniapps/mimic-tear/miniapp/node/host-liveness.mjs';
import { TASK_NAME, isWatchdogTaskInstalled, readWatchdogTaskRegistration } from '../miniapps/mimic-tear/miniapp/node/watchdog-rearm.mjs';
import { createApp } from '../miniapps/mimic-tear/miniapp/node/server.mjs';
import { tmpDir, cleanupDir } from './helpers/fixture.mjs';

const MINUTE = 60_000;
const NOW = Date.parse('2026-10-20T12:00:00Z');
const CLI = fileURLToPath(new URL('../miniapps/mimic-tear/miniapp/node/watchdog.mjs', import.meta.url));

/**
 * Start a stand-in for the host application.
 *
 * The liveness probe is a tasklist lookup by image name, so a copy of node.exe under the
 * host's exact name is the cheapest faithful stand-in — the probe finds it the same way it
 * finds the real application, with no production code bending for the test.
 *
 * @returns {{stop: () => void}}
 */
function startHostStandIn() {
  const dir = tmpDir('mimic-fake-host-');
  const exe = join(dir, HOST_IMAGE_NAME);
  copyFileSync(process.execPath, exe);
  const child = spawn(exe, ['-e', 'setTimeout(() => {}, 120000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  return {
    stop() {
      try {
        child.kill();
      } catch {
        /* best effort */
      }
      cleanupDir(dir);
    },
  };
}

/**
 * Wait until the liveness probe sees the host.
 *
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
async function waitForHostSeen(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isHostRunning()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

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

/**
 * Put the task's registration back the way it was.
 *
 * The test below runs the real CLI, and the CLI used to rewrite the production task's
 * registration with whatever directory it was given. Restoring the snapshot keeps a
 * failing test from leaving the machine worse than it found it.
 *
 * @param {{xml?: string} | null} snapshot
 */
function restoreWatchdogTask(snapshot) {
  if (!snapshot?.xml) return;
  const dir = tmpDir('mimic-task-restore-');
  const xmlPath = join(dir, 'task.xml');
  try {
    // `schtasks /create /xml` reads UTF-16LE with a BOM, the same encoding the
    // production writer uses.
    const body = Buffer.from(snapshot.xml, 'utf16le');
    writeFileSync(xmlPath, Buffer.concat([Buffer.from([0xff, 0xfe]), body]));
    execFileSync('schtasks.exe', ['/create', '/tn', TASK_NAME, '/xml', xmlPath, '/f'], { stdio: 'ignore' });
  } catch {
    /* best effort: the task still exists, only its arguments may differ */
  } finally {
    cleanupDir(dir);
  }
}

test('B6：跑一次 watchdog CLI 不得改动生产计划任务的注册', async () => {
  // 回归测试：曾经有一段时间，测试用临时目录跑 CLI，而 CLI 把自己的 --data-dir 写回了
  // 生产计划任务——于是生产看门狗一直对着一个用完即弃的临时目录跑。任务照样报成功，
  // 状态与告警全写进了没人看的地方，板面从那以后再没收到过看门狗的告警。
  const dir = tmpDir();
  const host = startHostStandIn();
  const before = await readWatchdogTaskRegistration();
  try {
    assert.equal(await waitForHostSeen(), true, '宿主替身必须先被探针看见');

    execFileSync(
      process.execPath,
      [CLI, '--data-dir', dir, '--no-notify', '--db', join(dir, 'no-such-db.sqlite')],
      { encoding: 'utf8' },
    );

    const after = await readWatchdogTaskRegistration();
    assert.equal(
      after?.dataDir ?? null,
      before?.dataDir ?? null,
      '一次测试运行不得把生产计划任务指向别的目录',
    );
  } finally {
    host.stop();
    cleanupDir(dir);
    restoreWatchdogTask(before);
  }
});

test('B5：无头可跑——退出码 0 且告警文件被创建', async () => {
  const dir = tmpDir();
  const host = startHostStandIn();
  const taskExisted = await isWatchdogTaskInstalled();
  try {
    // The watchdog only works while the host is open (with the host closed it stops
    // itself — that is the design, see host-liveness.mjs). A CI runner has no
    // MiniMax Code, so the stand-in has to be there before the CLI runs, or the
    // watchdog would correctly decide there is nothing to watch and exit first.
    assert.equal(await waitForHostSeen(), true, '宿主替身必须被探针看见');

    writeStaleConfig(dir);
    // `--no-notify` is the headless mode: the file is the only channel, nothing pops up.
    // `--no-rearm` keeps this test out of the schedule entirely: it is not about when
    // the watchdog looks next, and a test must never rewrite the production task.
    execFileSync(
      process.execPath,
      [CLI, '--data-dir', dir, '--no-notify', '--no-rearm', '--db', join(dir, 'no-such-db.sqlite')],
      { encoding: 'utf8' },
    );

    const raw = readFileSync(join(dir, 'watchdog-alert.log'), 'utf8');
    const rows = raw.trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].delivered, false);
    assert.match(rows[0].note, /no-notify/);
  } finally {
    host.stop();
    cleanupDir(dir);
    // The CLI re-arms the scheduled task as part of its tick. On a machine that did not
    // have one (a CI runner) the test must not leave it behind; on a machine that had
    // one, the real watchdog re-arms it to the published copy on its next tick.
    if (!taskExisted) {
      try {
        execFileSync('schtasks.exe', ['/delete', '/tn', TASK_NAME, '/f'], { stdio: 'ignore' });
      } catch {
        /* nothing to clean up */
      }
    }
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
