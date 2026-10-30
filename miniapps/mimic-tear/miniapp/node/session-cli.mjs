#!/usr/bin/env node
/**
 * Command line entry for the boss: the live session ledger.
 *
 * 派工之前先读会话——这是大哥自己的那一份「会话实况」。
 * 板面那一页读的是宿主的桥接（页面够得着、agent 够不着），这里读的是运行时库
 * （agent 够得着、页面那份清单够不着），**两边同一口径**（见 `session-ledger.mjs`）。
 *
 * 它回答三个问题，每个都是派工前必须知道的：
 * - **现在谁在跑** —— 别把活派给一个正在忙的会话；
 * - **谁在等回答** —— 有人卡在提问上，先解卡再派新的活；
 * - **每个会话最后说了什么** —— 判断「这个活是不是已经在做、做到哪了」。
 *
 * Commands:
 *   list          the session table (who is running, who is waiting)
 *   show <id>     one session with its last reply
 *   waiting       only the sessions waiting for an answer
 *
 * Options:
 *   --db <file>        runtime state database (default: ~/.minimax/v2/sqlite/runtime-state.sqlite)
 *   --status <s>       running | waiting | error | idle | all
 *   --project <name>   keep sessions of one project
 *   --keyword <text>   keep sessions whose title or id contains the text
 *   --limit <n>        keep at most n sessions
 *   --replies          read the last reply of every listed session (slow: one query each)
 *   --json             print the whole structure instead of the table
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { RuntimeStore } from './runtime-store.mjs';
import { readSessionLedger } from './session-ledger.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const hasFlag = (name) => args.includes(`--${name}`);

const VALUE_FLAGS = new Set(['--db', '--status', '--project', '--keyword', '--limit']);

/**
 * The positional arguments only.
 *
 * A flag value does not start with `--` either, so "not a flag" is not enough:
 * `--limit 10` would otherwise make `10` a positional argument.
 */
function positionalArgs() {
  return args.filter((arg, index) => {
    if (arg.startsWith('--')) return false;
    return !VALUE_FLAGS.has(args[index - 1]);
  });
}

// The command is the first positional; the rest are its arguments.
const positional = positionalArgs();
const command = positional[0] ?? 'list';

const dbPath = resolve(flag('db', process.env.MIMIC_RUNTIME_DB
  ?? join(homedir(), '.minimax', 'v2', 'sqlite', 'runtime-state.sqlite')));

const STATUS_LABEL = {
  running: '进行中',
  idle: '空闲',
  error: '出错',
  aborted: '已中止',
};

/**
 * A moment, in words.
 *
 * @param {number} ms
 * @returns {string}
 */
function relativeTime(ms) {
  const value = Number(ms) || 0;
  if (!value) return '未知';
  const delta = Date.now() - value;
  if (delta < 60_000) return '刚刚';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  const date = new Date(value);
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return `${date.getMonth() + 1}-${String(date.getDate()).padStart(2, '0')} ${time}`;
}

/**
 * One line per session.
 *
 * @param {any} row
 * @returns {string}
 */
function line(row) {
  const status = STATUS_LABEL[row.status] ?? row.status;
  const waiting = row.needsAnswer ? '★' : ' ';
  const project = row.projectName ?? '—';
  return [
    status.padEnd(4, '　'),
    waiting,
    relativeTime(row.updatedAt).padEnd(12, ' '),
    row.id,
    (row.agentName ?? '—').padEnd(8, ' '),
    project.padEnd(18, ' '),
    row.title,
  ].join(' ');
}

/**
 * The table, plus a header line that says what the numbers are.
 *
 * The counts describe the whole ledger; the rows may be a filtered slice. When they
 * are, the header says so — otherwise "48 个会话" next to three rows reads as a bug.
 *
 * @param {any} ledger
 * @param {any[]} rows
 * @param {string} [filterLabel]
 * @returns {string}
 */
function table(ledger, rows, filterLabel = '') {
  const counts = ledger.counts;
  const header = `会话实况 · ${counts.total} 个会话 · ${counts.running} 个在跑 · ${counts.waiting} 个在等回答 · ${counts.error} 个出错`
    + (filterLabel ? `（筛出 ${rows.length} 条：${filterLabel}）` : '');
  const body = rows.map((row) => line(row));
  return [header, ...body].join('\n');
}

const store = RuntimeStore.open(dbPath);
if (!store) {
  console.error(`读不到运行时库：${dbPath}`);
  process.exit(1);
}

try {
  const projectFilter = flag('project', null);
  const keyword = flag('keyword', null);
  const statusFilter = flag('status', command === 'waiting' ? 'waiting' : 'all');
  const limit = Number(flag('limit', 0)) || 0;

  // The project name is what the boss dispatches by, so it is always resolved —
  // not only when the caller filters by it.
  const names = new Map();
  for (const project of store.listProjects()) {
    names.set(project.id, project.workspaceDir.split(/[\\/]/).pop());
  }

  const ledger = readSessionLedger(store, {
    includeReplies: hasFlag('replies') || command === 'show',
    projectNames: names,
  });

  let rows = ledger.sessions;

  if (statusFilter && statusFilter !== 'all') {
    rows = rows.filter((row) => (statusFilter === 'waiting' ? row.needsAnswer : row.status === statusFilter));
  }
  if (projectFilter) {
    const needle = projectFilter.toLowerCase();
    rows = rows.filter((row) => (row.projectName ?? '').toLowerCase().includes(needle)
      || (row.title ?? '').toLowerCase().includes(needle));
  }
  if (keyword) {
    const needle = keyword.toLowerCase();
    rows = rows.filter((row) => (row.title ?? '').toLowerCase().includes(needle)
      || row.id.toLowerCase().includes(needle));
  }
  if (limit > 0) rows = rows.slice(0, limit);

  if (command === 'show') {
    const id = positional[1];
    if (!id) {
      console.error('用法：session-cli.mjs show <sessionId>');
      process.exit(1);
    }
    const row = ledger.sessions.find((entry) => entry.id === id);
    if (!row) {
      console.error(`账本里没有这个会话：${id}`);
      process.exit(1);
    }
    if (hasFlag('json')) {
      console.log(JSON.stringify(row, null, 2));
    } else {
      console.log([
        `标题：${row.title}`,
        `会话：${row.id}`,
        `agent：${row.agentName ?? '—'}　项目：${row.projectName ?? '—'}`,
        `状态：${STATUS_LABEL[row.status] ?? row.status}　更新时间：${relativeTime(row.updatedAt)}`,
        row.needsAnswer ? `等回答：${row.waitingRequestIds.join('、')}` : '等回答：无',
        row.error ? `错误：${row.error}` : null,
        '',
        '最后回复：',
        row.lastReply ?? '（这个会话还没有助手回复）',
      ].filter((part) => part !== null).join('\n'));
    }
    process.exit(0);
  }

  if (hasFlag('json')) {
    console.log(JSON.stringify({ generatedAt: ledger.generatedAt, counts: ledger.counts, sessions: rows }, null, 2));
  } else {
    const labels = [];
    if (statusFilter && statusFilter !== 'all') labels.push(statusFilter);
    if (projectFilter) labels.push(`项目 ${projectFilter}`);
    if (keyword) labels.push(`关键词 ${keyword}`);
    console.log(table(ledger, rows, labels.join(' / ')));
  }
  process.exit(0);
} finally {
  store.close();
}
