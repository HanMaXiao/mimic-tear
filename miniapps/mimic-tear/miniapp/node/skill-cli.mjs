#!/usr/bin/env node
/**
 * Command line for the reusable-skill registry.
 *
 * The board's Node service is on-demand: it only runs while the board is open, and the
 * registry has to be usable when it is closed — the boss dispatches from it, and the boss
 * does not wait for a UI. So the same read/write model is exposed here as a CLI.
 *
 * Commands:
 *   paths                     print the paths this CLI writes to
 *   list [--status <status>]  print the registered skills
 *   add --file <json>         register (or update) skills from a JSON report
 *   match <task text...>      rank the registered skills against a task
 *   validate                  check that every registered skill is still on disk
 *   use <id> [--success|--failure]
 *                             record that a skill was dispatched, and how it went
 *   retire <id> "<reason>"    take a skill out of dispatch (kept as a record)
 *   remove <id>               delete a registry row
 *
 * Options:
 *   --data-dir <dir>   where the board keeps its state (default: the published board's dir)
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { SkillLibraryStore } from './skill-library.mjs';

const args = process.argv.slice(2);
const command = args.find((arg) => !arg.startsWith('--')) ?? 'list';

/** Flags that take a value; the value must not be mistaken for a positional argument. */
const VALUE_FLAGS = new Set(['--data-dir', '--file', '--status', '--limit']);

const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = args[index + 1];
  return value === undefined || value.startsWith('--') ? fallback : value;
};

/**
 * The positional arguments only.
 *
 * A flag value is a path or a task text, and neither starts with `--`, so "does not start
 * with `--`" is not enough to separate them from the command's own arguments.
 */
function positionalArgs() {
  return args.filter((arg, index) => {
    if (arg.startsWith('--')) return false;
    return !VALUE_FLAGS.has(args[index - 1]);
  });
}

const dataDir = resolve(flag('data-dir', join(homedir(), '.minimax', 'v2', 'plugin-data', 'liveboards', 'mimic-tear')));
const library = new SkillLibraryStore(dataDir);

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

if (command === 'paths') {
  print({ dataDir, library: library.path });
  process.exit(0);
}

if (command === 'list') {
  const status = flag('status', 'all');
  const entries = await library.list();
  const filtered = status === 'all' ? entries : entries.filter((entry) => entry.status === status);
  print({
    library: library.path,
    stats: await library.stats(),
    entries: filtered,
  });
  process.exit(0);
}

if (command === 'add') {
  const fileIndex = args.indexOf('--file');
  const file = fileIndex !== -1 ? args[fileIndex + 1] : positionalArgs()[1];
  if (!file) fail('add 需要一个 JSON 文件参数（--file <路径>）');

  let payload;
  try {
    payload = JSON.parse(await readFile(resolve(file), 'utf8'));
  } catch (error) {
    fail(`读不了这个文件：${error?.message ?? error}`);
  }

  // The report comes from an agent, so it may be one entry, a list, or { entries: [...] }.
  const inputs = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.entries)
      ? payload.entries
      : [payload];

  if (inputs.length === 0) fail('这个文件里没有要注册的技能');

  const written = [];
  for (const input of inputs) {
    try {
      written.push(await library.upsert(input));
    } catch (error) {
      fail(`注册失败：${error?.message ?? error}`);
    }
  }

  print({
    ok: true,
    created: written.filter((item) => item.created).length,
    updated: written.filter((item) => !item.created).length,
    entries: written.map((item) => item.entry),
    stats: await library.stats(),
  });
  process.exit(0);
}

if (command === 'match') {
  const text = positionalArgs().slice(1).join(' ');
  if (!text) fail('match 需要任务描述');
  const limit = Number(flag('limit', '5'));
  print({
    query: text,
    matches: await library.match(text, { limit: Number.isFinite(limit) ? limit : 5 }),
  });
  process.exit(0);
}

if (command === 'validate') {
  print({ library: library.path, report: await library.validate() });
  process.exit(0);
}

if (command === 'use') {
  const id = positionalArgs()[1];
  if (!id) fail('use 需要一个注册表条目 id');
  const success = args.includes('--success');
  const failure = args.includes('--failure');
  if (success && failure) fail('--success 与 --failure 只能给一个');
  const entry = await library.recordUse(id, { success });
  if (!entry) fail(`注册表里没有这个 id：${id}`);
  print({ ok: true, entry });
  process.exit(0);
}

if (command === 'retire') {
  const id = positionalArgs()[1];
  const reason = positionalArgs().slice(2).join(' ');
  if (!id) fail('retire 需要一个注册表条目 id');
  if (!reason) fail('retire 需要理由 —— 退役记录是「别再封装一次」的证据');
  const entry = await library.retire(id, reason);
  if (!entry) fail(`注册表里没有这个 id：${id}`);
  print({ ok: true, entry });
  process.exit(0);
}

if (command === 'remove') {
  const id = positionalArgs()[1];
  if (!id) fail('remove 需要一个注册表条目 id');
  const removed = await library.remove(id);
  if (!removed) fail(`注册表里没有这个 id：${id}`);
  print({ ok: true, removed: true, id });
  process.exit(0);
}

fail(`用法：${[
  'paths',
  'list [--status active|stale|retired|all]',
  'add --file <json>',
  'match <任务描述>',
  'validate',
  'use <id> [--success|--failure]',
  'retire <id> "<理由>"',
  'remove <id>',
].join(' | ')}`);
