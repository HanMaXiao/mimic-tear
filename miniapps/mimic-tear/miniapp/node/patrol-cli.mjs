#!/usr/bin/env node
/**
 * Command line entry for the boss.
 *
 * The Mini App's Node service is `on-demand`: it only runs while the board is open. The boss
 * has to keep duty when the board is closed, so the same read model is exposed here as a CLI
 * the boss can call from a scheduled task.
 *
 * Commands:
 *   facts            print the fact sheet (projects, decisions, questionnaires, goals, plan)
 *   report <file>    merge findings / answered questions / recovery notes into the board
 *   archive "<why>"  move the ledger's conclusions into the archive file (nothing is deleted)
 *   archive          print the archive's metadata (when / who / why / how many)
 *   gap              print the handover sheet: how long the duty chain was broken, how many
 *                    rounds count as missed duty, how many are still owed
 *   gap reset "<why>" clear the "already covered" marker so the next tick re-covers the gap
 *   paths            print the paths the boss writes to
 *
 * Options:
 *   --data-dir <dir>   where the board keeps its state (default: the published board's dir)
 *   --db <file>        runtime state database (default: ~/.minimax/v2/sqlite/runtime-state.sqlite)
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RuntimeStore } from './runtime-store.mjs';
import { readPlan } from './plan-store.mjs';
import { buildDutyStatus, buildInbox, buildOrgTree, buildPatrolBrief, buildProjectCards, computeDutyEvidence, dutyStaleAfterMinutes, projectName, withDutyCards } from './view-model.mjs';
import { PatrolStore } from './patrol-store.mjs';
import { Persistence } from './persistence.mjs';
import { ManagedProjects, matchManagedProject, resolveManagedEntries } from './managed-projects.mjs';
import { DutyIntent } from './duty-intent.mjs';
import { selectTriggers } from './trigger.mjs';
import { detectTriggers, TRIGGER_WHITELIST } from './trigger-source.mjs';
import { ThreadSubscriptions } from './thread-subscriptions.mjs';
import { DUTY_CRON_SEED, readDutyChain } from './duty-chain.mjs';
import { applySpill, buildFactRefGraph } from './recall.mjs';
import { resolveCardState } from './questionnaire-rules.mjs';

const args = process.argv.slice(2);
const command = args.find((arg) => !arg.startsWith('--')) ?? 'facts';
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};

/**
 * All the values of a flag that may appear more than once.
 *
 * @param {string} name
 * @returns {string[]}
 */
const allFlags = (name) => args
  .reduce((values, arg, index) => {
    if (arg === `--${name}` && args[index + 1]) values.push(args[index + 1]);
    return values;
  }, [])
  .filter(Boolean);

const dataDir = resolve(flag('data-dir', join(homedir(), '.minimax', 'v2', 'plugin-data', 'liveboards', 'mimic-tear')));
const dbPath = resolve(flag('db', process.env.MIMIC_RUNTIME_DB
  ?? join(homedir(), '.minimax', 'v2', 'sqlite', 'runtime-state.sqlite')));

/** Flags that take a value; the value must not be mistaken for a positional argument. */
const VALUE_FLAGS = new Set([
  '--data-dir', '--db', '--file', '--scope',
  '--answer', '--rationale', '--session-id', '--option-id',
]);

/**
 * The positional arguments only.
 *
 * "Does not start with `--`" is not enough: the *value* of `--data-dir` is a path, and a
 * path does not start with `--` either. Without this, a flag value silently becomes part of
 * the command's arguments.
 */
function positionalArgs() {
  return args.filter((arg, index) => {
    if (arg.startsWith('--')) return false;
    return !VALUE_FLAGS.has(args[index - 1]);
  });
}

const store = RuntimeStore.open(dbPath);
const patrol = new PatrolStore(dataDir);
const managed = new ManagedProjects(dataDir);
const dutyIntent = new DutyIntent(dataDir);

if (command === 'paths') {
  print({
    dataDir,
    dbPath,
    // 结论账、已答项、归档账、巡检配置都在板面状态的**单一 store** 里。
    state: patrol.state.path,
    managed: managed.path,
    dutyIntent: dutyIntent.path,
  });
  store.close();
  process.exit(0);
}

if (command === 'manage') {
  const action = positionalArgs()[1] ?? 'list';
  const name = positionalArgs()[2] ?? '';
  const reason = positionalArgs().slice(3).join(' ');
  try {
    if (action === 'list') {
      print({ managed: await managedList() });
    } else if (action === 'add') {
      const resolution = matchManagedProject(name, store.listProjects());
      if (!resolution.project) {
        // A grant that names nothing governs nothing, and the boss would never find out:
        // it would just report "当前无管辖项目" every round. Refuse, and say what does exist.
        const known = [...new Set(store.listProjects().map((project) => projectName(project.workspaceDir)))];
        const hint = resolution.candidates.length
          ? `名字像是这些：${resolution.candidates.join(' / ')}`
          : `当前的项目名有：${known.join(' / ')}`;
        throw new Error(`没有叫「${name}」的项目，这份授权会落空。${hint}`);
      }
      const list = await managed.add(name, reason, {
        projectId: resolution.project.id,
        path: resolution.project.path,
      });
      print({ ok: true, granted: resolution.project.name, path: resolution.project.path, managed: list });
    } else if (action === 'remove') {
      const before = await managed.list();
      const onList = before.some((entry) => entry.name === String(name ?? '').trim());
      const list = await managed.remove(name, reason);
      // Revoking by a name that is not on the list changes nothing. That is idempotent, but
      // it is also how a typo leaves the jurisdiction in place — so say it out loud.
      print({
        ok: true,
        removed: onList,
        managed: list,
        warning: onList ? null : `名单里没有「${name}」，什么都没变——核对项目名是否逐字一致`,
      });
    } else {
      process.stderr.write('用法：manage list | manage add <项目名> "<大老板的原话>" | manage remove <项目名> "<理由>"\n');
      store.close();
      process.exit(2);
    }
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n`);
    store.close();
    process.exit(2);
  }
  store.close();
  process.exit(0);
}

if (command === 'duty-cron') {
  // The pin that says which cron definition is the duty cron.
  //
  // The node side only reads `dutyCronId`; when the scheduler is re-pointed, the new
  // definition has a new id, and this is the one place that can be updated properly —
  // "remember to hand-edit the board's JSON" is not a procedure anyone keeps.
  const action = positionalArgs()[1] ?? 'show';
  const requestedId = positionalArgs()[2] ?? '';
  try {
    const { resolveDutyChain } = await import('./duty-chain.mjs');
    const config = await patrol.getConfig();
    const definitions = store.listCronDefinitions();
    const chain = resolveDutyChain(definitions, { pinnedCronId: config.dutyCronId ?? null });
    const pinnedDefinition = config.dutyCronId
      ? definitions.find((d) => d.cronId === config.dutyCronId)
      : null;
    const pinnedStale = Boolean(pinnedDefinition?.deletedAt);

    if (action === 'show') {
      print({
        pinnedCronId: config.dutyCronId ?? null,
        chain: {
          name: chain.name,
          cronIds: chain.cronIds,
          activeCronIds: chain.activeCronIds,
          active: chain.active,
          reason: chain.reason,
          targetCronId: chain.targetCronId,
          targetSessionId: chain.targetSessionId,
        },
        hint: pinnedStale
          ? `钉住的 cron 已被删除（${new Date(pinnedDefinition.deletedAt).toISOString()}），请改成 ${chain.targetCronId ?? '（没有活着的同名 cron）'}`
          : (config.dutyCronId
            ? null
            : `还没钉任何 cron；建议钉 ${chain.targetCronId ?? '（没有活着的同名 cron）'}`),
      });
    } else if (action === 'set') {
      const target = String(requestedId ?? '').trim();
      if (!target) throw new Error('用法：duty-cron set <cron-id>');
      const definition = definitions.find((d) => d.cronId === target);
      if (!definition) throw new Error(`没有这个 cron：${target}`);
      if (definition.deletedAt) {
        throw new Error(`这个 cron 已被删除（${new Date(definition.deletedAt).toISOString()}），`
          + '钉它只会让心跳一直报 misconfigured');
      }
      const next = await patrol.setConfig({ dutyCronId: target });
      print({
        ok: true,
        dutyCronId: next.dutyCronId,
        name: definition.name,
        targetSessionId: definition.targetSessionId,
      });
    } else {
      process.stderr.write('用法：duty-cron | duty-cron set <cron-id>\n');
      store.close();
      process.exit(2);
    }
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n`);
    store.close();
    process.exit(2);
  }
  store.close();
  process.exit(0);
}

if (command === 'gap') {
  // 断档的账：断了多久、断了几轮、其中多少算漏班、还欠几轮。
  //
  // 这是「大哥上岗」的那张单子。值班链断了之后，空槽会一直堆着——堆了多少、断多久、
  // 哪些该补，必须有一个地方能一眼看到，而不是让人去翻调度器的运行记录。
  //
  // `reset` 是**显式**动作：把「已经补到哪里」的标记清掉，让下一跳重新覆盖整段空档。
  // 它必须带理由，因为「解除锁死」是一次决定，不是一个自动行为——自动解除就等于把
  // 「自动补位会出事」那个坑重新打开。
  const action = positionalArgs()[1] ?? 'show';
  const reason = positionalArgs().slice(2).join(' ').trim();
  try {
    const { getDutyHeartbeatStatus, writeHeartbeatState, readHeartbeatState } =
      await import('./duty-heartbeat.mjs');
    const { buildDutyHandoverSummary } = await import('./duty-gap.mjs');

    if (action === 'reset') {
      if (!reason) {
        throw new Error('用法：gap reset "<大老板的原话>"——解除覆盖标记是一次决定，必须有理由');
      }
      const before = await readHeartbeatState(dataDir);
      const cleared = before.coveredThroughSlot ?? null;
      await writeHeartbeatState(dataDir, {
        ...before,
        coveredThroughSlot: null,
        coveredAt: null,
        resetAt: Date.now(),
        resetReason: reason,
      });
      print({
        ok: true,
        action: 'reset',
        clearedThroughSlot: cleared,
        reason,
        note: cleared === null
          ? '本来就没有覆盖标记——已经补过的段落会被重新补一遍'
          : `覆盖标记已清到第 ${cleared} 槽之前；下一跳会重新覆盖整段空档`,
      });
    } else if (action === 'show') {
      const now = Date.now();
      const status = await getDutyHeartbeatStatus({ dataDir, store, now });
      const managedEntries = await managedList();
      const findings = await patrol.list();
      const summary = buildDutyHandoverSummary(status.gap, {
        now,
        managedCount: managedEntries.filter((entry) => entry.matched).length,
        pendingDecisions: findings.filter((finding) => !finding.acknowledged).length,
      });
      print({
        gap: status.gap,
        reason: status.reason,
        mode: status.mode,
        coveredThroughSlot: status.coveredThroughSlot,
        summary,
      });
    } else {
      process.stderr.write('用法：gap | gap reset "<理由>"\n');
      store.close();
      process.exit(2);
    }
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n`);
    store.close();
    process.exit(2);
  }
  store.close();
  process.exit(0);
}

if (command === 'thread') {
  // 订阅表：哪条线有投递口、负责会话是谁。
  //
  // 「事件该投给谁」必须是可查的状态，不是每轮现推——现推的话那个决定一飘，事件就投错人，
  // 而投错人比不投更糟。
  const action = positionalArgs()[1] ?? 'list';
  try {
    const subscriptions = new ThreadSubscriptions(dataDir);
    if (action === 'list') {
      print({ threads: await subscriptions.list() });
    } else if (action === 'add') {
      const name = positionalArgs()[2] ?? '';
      const ownerSessionId = positionalArgs()[3] ?? '';
      const reason = positionalArgs().slice(4).join(' ').trim();
      if (!reason) throw new Error('用法：thread add <项目名> <会话id> "<理由>"——开投递口是一次决定，必须有理由');
      // 会话必须真的存在。**落空的投递口是查不出来的**：订阅表里躺着一条，
      // 看起来一切正常，事件却投不出去——所以在这里就拒绝。
      const sessions = store.listSessions();
      const target = sessions.find((session) => session.id === ownerSessionId);
      if (!target) {
        throw new Error(`没有这个会话：${ownerSessionId}。这条订阅会落空——事件投不出去。`);
      }
      const project = store.listProjects().find((p) => projectName(p.workspaceDir) === name);
      const list = await subscriptions.add(name, ownerSessionId, reason, {
        projectId: project?.id ?? null,
      });
      print({
        ok: true,
        thread: name,
        ownerSessionId,
        sessionTitle: target.title ?? null,
        threads: list,
      });
    } else if (action === 'remove') {
      const name = positionalArgs()[2] ?? '';
      const reason = positionalArgs().slice(3).join(' ').trim();
      if (!reason) throw new Error('用法：thread remove <项目名> "<理由>"');
      const before = await subscriptions.list();
      const onList = before.some((entry) => entry.projectName === String(name ?? '').trim());
      const list = await subscriptions.remove(name, reason);
      print({
        ok: true,
        removed: onList,
        threads: list,
        warning: onList ? null : `订阅表里没有「${name}」，什么都没变——核对项目名是否逐字一致`,
      });
    } else {
      process.stderr.write('用法：thread list | thread add <项目名> <会话id> "<理由>" | thread remove <项目名> "<理由>"\n');
      store.close();
      process.exit(2);
    }
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n`);
    store.close();
    process.exit(2);
  }
  store.close();
  process.exit(0);
}

if (command === 'recall') {
  // 按 ID 取回完整内容 —— 被 Spill 出去的那部分的**续读入口**。
  //
  // 「省下来的不是内容，是位置」：摘要代替原文是允许的，**原文没了不允许**。
  // 所以这一条必须能**原样**取回：取回来的正文要和原文逐字一致。
  //
  // 顺带给出**链式召回**：从��个 ID 出发，顺着引用关系一跳一跳地展开——
  // 这就是基线规格 §3.1「连续」那条判据的机器形态：同一件事换个入口继续讨论，
  // 大哥能接上上下文，不要求用户复述。
  const id = positionalArgs()[1] ?? '';
  if (!id) {
    process.stderr.write('用法：recall <id>\n');
    store.close();
    process.exit(2);
  }
  try {
    const { planRecall } = await import('./recall.mjs');
    const projects = store.listProjects();
    const visibleIds = new Set(projects.map((p) => p.id));
    const sessions = store.listSessions().filter((s) => visibleIds.has(s.projectId));
    const questionnaires = store.listQuestionnaires(true);
    const goals = store.listGoals();
    // 归档过的结论照样能取回：归档是搬家，不是销毁。
    const findings = [...await patrol.list(), ...await patrol.listArchivedFindings()];
    const managedEntries = await managedList();
    const managedNames = new Set(
      managedEntries.filter((entry) => entry.matched).map((entry) => entry.projectName ?? entry.name),
    );
    const inScope = (projectName) => !projectName || managedNames.has(projectName);

    const projectById = new Map(projects.map((p) => [p.id, p]));
    const nameOf = (projectId) => {
      const project = projectById.get(projectId);
      return project ? project.workspaceDir.split(/[\\/]/).pop() : null;
    };

    // 这条线上的结论 id：项目节点的第二跳（「同项目的其它结论」）。
    //
    // **只有 `recall` 入口带它** —— `facts` 入口不传，因为引用图住在系统里、不进负载
    // （把全部结论 id 内联进候选视图会让它从 59,265 涨到 80,638 字节）。召回是按需查图，
    // 那里可以查全。
    const conclusionIdsByProject = new Map();
    for (const finding of findings) {
      const projectName = finding?.projectName;
      if (!projectName || !inScope(projectName)) continue;
      const ids = conclusionIdsByProject.get(projectName) ?? [];
      ids.push(String(finding.id));
      conclusionIdsByProject.set(projectName, ids);
    }

    // 负责会话也要在图里：项目节点的下一跳指向它——图里没有目标节点，那一跳就是断的。
    const ownerSessionsInScope = projects
      .filter((p) => inScope(p.workspaceDir.split(/[\\/]/).pop()))
      .map((p) => ownerSessionIdFor(sessions, p.id))
      .filter(Boolean)
      .map((id) => sessions.find((s) => s.id === id))
      .filter(Boolean);

    const graph = buildFactRefGraph({
      findings: findings.filter((f) => inScope(f.projectName)),
      projects: projects
        .filter((p) => inScope(p.workspaceDir.split(/[\\/]/).pop()))
        .map((p) => {
          const name = p.workspaceDir.split(/[\\/]/).pop();
          return {
            name,
            ownerSessionId: ownerSessionIdFor(sessions, p.id),
            conclusionIds: conclusionIdsByProject.get(name) ?? [],
          };
        }),
      sessions: [
        ...sessions
          .filter((s) => ['error', 'interrupted', 'aborted'].includes(s.status))
          .filter((s) => inScope(nameOf(s.projectId)))
          .map((s) => ({ id: s.id, projectName: nameOf(s.projectId), title: s.title })),
        ...ownerSessionsInScope.map((s) => ({ id: s.id, projectName: nameOf(s.projectId), title: s.title })),
      ],
      questionnaires: questionnaires.map((q) => ({ requestId: q.id, sessionId: q.sessionId, question: null })),
      goals: goals
        .map((g) => {
          const owner = sessions.find((s) => s.id === g.sessionId);
          return {
            goalId: g.goalId,
            sessionId: g.sessionId,
            objective: g.objective,
            projectName: nameOf(owner?.projectId),
          };
        })
        .filter((g) => inScope(g.projectName))
        .map((g) => ({ goalId: g.goalId, sessionId: g.sessionId, objective: g.objective })),
      planTasks: [],
      triggers: [],
    });

    // 全文：按 id 找回原对象。
    const finding = findings.find((f) => f.id === id);
    const session = sessions.find((s) => s.id === id);
    const project = projects.find((p) => p.workspaceDir.split(/[\\/]/).pop() === id);
    const questionnaire = questionnaires.find((q) => q.id === id);
    const goal = goals.find((g) => g.id === id);

    let record = null;
    if (finding) record = { kind: 'conclusion', value: finding };
    else if (session) record = { kind: 'session', value: session };
    else if (project) record = { kind: 'project', value: project };
    else if (questionnaire) record = { kind: 'questionnaire', value: questionnaire };
    else if (goal) record = { kind: 'goal', value: goal };
    else if (id.includes(':')) {
      // 计划任务的主键是 `<项目名>:<任务 id>`。
      const [projectName, taskId] = [id.slice(0, id.lastIndexOf(':')), id.slice(id.lastIndexOf(':') + 1)];
      const owner = projects.find((p) => p.workspaceDir.split(/[\\/]/).pop() === projectName);
      if (owner) {
        try {
          const plan = await readPlan(owner.workspaceDir);
          const task = (plan?.tasks ?? []).find((t) => String(t.id) === taskId);
          if (task) record = { kind: 'plan-task', value: { projectName, ...task } };
        } catch {
          record = null;
        }
      }
    }

    print({
      id,
      found: record !== null,
      record,
      chain: planRecall(id, graph),
    });
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n`);
    store.close();
    process.exit(2);
  }
  store.close();
  process.exit(0);
}

if (command === 'facts') {
  const projects = store.listProjects();
  const visibleIds = new Set(projects.map((p) => p.id));
  const sessions = store.listSessions().filter((s) => visibleIds.has(s.projectId));
  const goals = store.listGoals();
  const questionnaires = store.listQuestionnaires(true);
  const tasks = store.listActiveTasks();

  const plans = new Map();
  await Promise.all(projects.map(async (project) => {
    try {
      plans.set(project.id, await readPlan(project.workspaceDir));
    } catch {
      plans.set(project.id, null);
    }
  }));

  const cards = buildProjectCards({ projects, sessions, goals, questionnaires, tasks, plans });
  // **已排除的条目**（大哥查实是旧残骸的那些）。板面那条路径传了 dismissed，CLI 这条路径
  // 没传：于是 `duty.dismissed` 恒为 0、已排除的条目还以「未处理」的样子躺在待办里——
  // 模型读表会以为「从没排除过任何东西」，可能把排除过的事再报一遍。
  // 同一个词（「已处理」）不该有两套口径（2026-11-01 13:37 那一轮查出来的）。
  const dismissedRecords = await new Persistence(dataDir).listDismissed();
  const dismissedById = new Map(dismissedRecords.map((entry) => [entry.id, entry.reason ?? '']));
  const runtimeItems = buildInbox({ projects, sessions, goals, questionnaires, plans }, new Set(), dismissedById);
  const answered = await patrol.listAnswered();
  // 大哥给过的建议，按 requestId 索引。
  const suggestionById = new Map(answered.map((item) => [item.requestId, item]));
  // 宿主那边每张卡的开合状态。**运行时是唯一权威**——板面账只说明「大哥给没给建议」。
  // 少了这张索引，「记了建议」和「卡翻了」就会又变成同一个词（2026-11-01 13:07 轮查出）。
  const cardById = new Map(store.listQuestionnaires(false).map((card) => [card.id, card]));
  const previousFindings = await patrol.list();
  // 归档过的结论：不在账本上了，但**仍然是大哥报过的事**。去重账要看得见它们，
  // 否则同一件事会被再报一遍。
  const archivedFindings = await patrol.listArchivedFindings();
  const archive = await patrol.listArchive();

  // The jurisdiction list, each entry resolved against the live project set. A grant whose
  // name no longer points at a project is shown as `matched: false` — the boss has to be
  // able to see that its authority is empty without guessing.
  const managedEntries = await managedList();
  const managedNames = new Set(
    managedEntries.filter((entry) => entry.matched).map((entry) => entry.projectName ?? entry.name),
  );

  // What the boss was told to do next. "Resting" is an explicit decision with a timestamp
  // and a reason, so it travels with the facts: a boss that was told to rest must know it
  // is off duty before it decides what is worth reporting this round.
  const dutyIntentState = await dutyIntent.read();

  // The sessions the boss may talk to. Without these a grant is just a name on a list:
  // the boss would have to dig through the runtime to find out who to send a message to.
  const goalBySession = new Map(goals.map((goal) => [goal.sessionId, goal]));
  const ownerSessionsByProject = new Map();
  for (const card of cards) {
    ownerSessionsByProject.set(
      card.id,
      sessions
        .filter((session) => session.projectId === card.id)
        .map((session) => {
          const goal = goalBySession.get(session.id);
          return {
            id: session.id,
            title: session.title,
            agentName: session.agentName,
            status: session.status,
            updatedAt: session.updatedAt,
            isRoot: session.parentSessionId == null,
            visibility: session.visibility,
            goalId: goal?.id ?? null,
            goalStatus: goal?.status ?? null,
            goalObjective: goal ? String(goal.objective).slice(0, 100) : null,
          };
        }),
    );
  }

  const sessionById = new Map(sessions.map((s) => [s.id, s]));
  const projectById = new Map(projects.map((p) => [p.id, p]));

  // 宿主还开着的卡，**一张都不许少**——哪怕大哥已经给过建议。
  //
  // 以前这里按「账上记过了」把卡剔掉，于是大哥记完建议就看不见这张卡了，而宿主那边
  // 它照样开着、那个会话照样卡着：卡着的事从此没人再管（2026-11-01 13:07 轮查出）。
  // 「卡开没开」只有一个权威：运行时。板面账只负责另一个问题——「大哥给没给建议」。
  const openQuestionnaires = questionnaires
    .map((q) => {
      const session = sessionById.get(q.sessionId);
      const project = projectById.get(session?.projectId);
      const suggestion = suggestionById.get(q.id) ?? null;
      return {
        requestId: q.id,
        sessionId: q.sessionId,
        sessionTitle: session?.title ?? null,
        projectId: session?.projectId ?? null,
        projectName: project ? project.workspaceDir.split(/[\\/]/).pop() : null,
        createdAt: q.createdAt,
        question: extractQuestion(q.requestJson),
        stepIds: extractSteps(q.requestJson),
        options: extractOptions(q.requestJson),
        // 大哥已经表过态的卡也要把建议带着：大哥得看见「这张我答过了，等大老板点头」。
        bossSuggestion: suggestion
          ? {
              answer: suggestion.answer ?? '',
              rationale: suggestion.rationale ?? '',
              optionIds: suggestion.optionIds ?? [],
              decidedAt: suggestion.answeredAt ?? null,
            }
          : null,
      };
    });

  // A session that errored, was interrupted or was aborted is work that stopped. The boss can
  // restart it by sending a message; it cannot be resumed by the runtime on its own.
  const recoverable = sessions
    .filter((s) => s.status === 'error' || s.status === 'interrupted' || s.status === 'aborted')
    .map((s) => {
      const project = projectById.get(s.projectId);
      return {
        sessionId: s.id,
        sessionTitle: s.title,
        agentName: s.agentName,
        status: s.status,
        projectId: s.projectId ?? null,
        projectName: project ? project.workspaceDir.split(/[\\/]/).pop() : null,
        error: s.errorMessage ?? null,
        updatedAt: s.updatedAt,
      };
    });

  const goalRows = goals.map((goal) => {
    const session = sessionById.get(goal.sessionId);
    const project = projectById.get(session?.projectId);
    return {
      goalId: goal.id,
      sessionId: goal.sessionId,
      projectName: project ? project.workspaceDir.split(/[\\/]/).pop() : null,
      objective: goal.objective,
      status: goal.status,
      statusReason: goal.statusReason,
      tokensUsed: goal.tokensUsed,
      timeUsedSeconds: goal.timeUsedSeconds,
    };
  });

  const planRows = [];
  for (const card of cards) {
    for (const task of card.planTasks) {
      planRows.push({
        projectName: card.name,
        projectId: card.id,
        id: task.id,
        title: task.title,
        state: task.state,
        assignedTo: task.assignedTo,
        stateAgeDays: card.planUpdatedAt ? Math.floor((Date.now() - card.planUpdatedAt) / 86_400_000) : null,
      });
    }
  }

  // The boss's own duty state. `missedRounds` is how the boss learns that its previous
  // round never landed — the board can see a stale duty line, but only the boss can
  // report what it was in the middle of doing when it dropped.
  //
  // `mode` is the decision that was made, `watching` is the jurisdiction list. Together
  // they answer "what am I here to do", which no timestamp can answer.
  //
  // **`missedRounds` 用权威口径**（调度记录为准，休息期不算漏班）：纯算术的口径会把
  // 休息期也数成漏班，上岗验收时它给出 97、权威口径是 0——模型每轮读表都被那个 97 误导
  // （2026-11-01 上岗轮大哥查出来的）。纯算术的值另放在 `missedRoundsByAge`，
  // **同一个词不许有两种意思**。
  const dutyConfig = await patrol.getConfig();
  const dutyIntervalMinutes = dutyConfig.dutyIntervalMinutes ?? 30;
  const dutyChain = readDutyChain(store, {
    pinnedCronId: typeof dutyConfig.dutyCronId === 'string' ? dutyConfig.dutyCronId : null,
    seedCronId: DUTY_CRON_SEED,
  });
  const dutyEvidence = dutyChain.runs.length
    ? computeDutyEvidence({
      runs: dutyChain.runs,
      periodMs: dutyIntervalMinutes * 60_000,
      evidenceWindowMs: dutyStaleAfterMinutes(dutyIntervalMinutes) * 60_000,
      // 上岗分界线：**只数在岗时漏的班次**。上岗之前的洞是「还没上岗」，不是「漏班」。
      // 这跟 gap 摘要是同一条分界线、同一套归属规则。
      boundary: Number.isFinite(Number(dutyIntentState?.since)) ? Number(dutyIntentState.since) : null,
      onDuty: (dutyIntentState?.mode ?? 'on-duty') !== 'resting',
      now: Date.now(),
    })
    : null;
  const duty = {
    ...buildDutyStatus({
      config: dutyConfig,
      findings: previousFindings,
      // 大哥排除过的原始项——板面那边数它们，CLI 这边也得数同一个。
      dismissed: dismissedRecords,
      intent: dutyIntentState,
      evidence: dutyEvidence,
      now: Date.now(),
    }),
    watching: [...managedNames],
  };

  // 事实表的两种视图。
  //
  // 默认给模型的是**候选**：管辖区内的、这一轮真的变了的。`raw` 是诊断用的——它要全量，
  // 所以它必须**显式要**，而且这份负载里会写明「这次要了全量」，免得下次看到的人分不清
  // 「这就是全部」和「这是筛过的」。
  const scope = String(flag('scope', 'candidates')).trim().toLowerCase();
  if (!['candidates', 'raw'].includes(scope)) {
    process.stderr.write(`未知的 scope「${scope}」：可用 candidates（默认，给模型）/ raw（全量，诊断用）\n`);
    store.close();
    process.exit(2);
  }
  const wantRaw = scope === 'raw';

  // 管辖闸：有名有姓的项目，不在名单里就不进候选视图。
  // **没有项目归属的行一律保留**——无法证明它在管辖范围外，就不该当成范围外。
  const withinJurisdiction = (projectName) => (
    wantRaw || !projectName || managedNames.has(projectName)
  );

  const visibleCards = wantRaw ? cards : cards.filter((card) => managedNames.has(card.name));
  const visibleItems = runtimeItems.filter((item) => withinJurisdiction(item.projectName));
  const visibleQuestionnaires = openQuestionnaires.filter((q) => withinJurisdiction(q.projectName));
  const visibleRecoverable = recoverable.filter((r) => withinJurisdiction(r.projectName));
  const visibleGoals = goalRows.filter((g) => withinJurisdiction(g.projectName));
  const visiblePlanTasks = planRows.filter((t) => withinJurisdiction(t.projectName));
  // `alreadyReported` **不按管辖过滤**：这是大哥自己报过的账。忘了报过的事，就会再报一遍——
  // 而「重复报同一件事」正是收件箱堆到 93 条的原因之一。它是账本，不是环境状态。
  // 归档过的结论也算数：它们退场了，但「报过了」这件事没变。
  const visibleReported = [...previousFindings, ...archivedFindings];

  // 这一轮真的发生了什么。
  //
  // 事件从**全量**行里认——不先筛——然后交给第一道闸（`selectTriggers`）去筛。这样「筛掉
  // 了多少」才是真的数字，而不是自己筛完自己报「一个没筛掉」。
  //
  // 水位线是**交班戳**：上一轮交班之后发生的事，就是这一轮的事件。没有新状态文件。
  const rawTriggers = detectTriggers({
    projects: cards.map((card) => ({
      id: card.id,
      name: card.name,
      latestActivityAt: card.lastActivityAt,
    })),
    sessions: recoverable.map((r) => ({
      id: r.sessionId,
      status: r.status,
      title: r.sessionTitle,
      updatedAt: r.updatedAt,
      projectName: r.projectName,
    })),
    questionnaires: openQuestionnaires.map((q) => ({
      id: q.requestId,
      createdAt: q.createdAt,
      question: q.question,
      sessionId: q.sessionId,
      projectName: q.projectName,
    })),
    watermark: dutyConfig.lastRunAt ?? 0,
    now: Date.now(),
  });
  const selected = selectTriggers(rawTriggers, {
    managedNames: managedNames,
    allowTypes: TRIGGER_WHITELIST,
  });

  // `delivered` 标记：这条事件**已经由程序直投给了那条线的负责人会话**（订阅表里的
  // 「已投出」账）。带这个标记的不归大哥管——**别再派一次工、别再报一次**。
  //
  // 它记的是「已投出」，**不是「已执行」**：目标会话在跑 goal 链时消息会排队，
  // 排队中的那一轮还没跑。
  const subscriptions = await new ThreadSubscriptions(dataDir).list();
  const deliveredIds = new Set(subscriptions.flatMap((entry) => entry.delivered ?? []));
  const markedCandidates = selected.kept.map((trigger) => ({
    ...trigger,
    delivered: deliveredIds.has(trigger.id),
  }));

  const rawPayload = {
    generatedAt: Date.now(),
    // Which view this is. `candidates` is what the model gets by default; `raw` means the
    // caller explicitly asked for everything — and the payload says so, so that whoever
    // reads it later can tell "this is all of it" from "this was filtered".
    scope,
    fullScopeRequested: wantRaw,
    paths: {
      // 结论账、已答项、归档账、巡检配置都在板面状态的**单一 store** 里
      // （`board-state.json`）。老文件只在第一次访问时被读一次，之后不再被读。
      state: patrol.state.path,
      db: dbPath,
    },
    // Which projects the boss is allowed to manage. The user grants this explicitly; the
    // boss never widens it on its own. Anything not on this list is out of bounds, however
    // broken or long-idle it looks.
    managed: managedEntries,
    // 订阅表：哪些线有投递口、负责会话是谁。没有投递口的事件投不出去——所以这一段
    // 不是「可选信息」，是「哪些线还能收到东西」的答案。
    threads: (await new ThreadSubscriptions(dataDir).list()).map((entry) => ({
      projectName: entry.projectName,
      projectId: entry.projectId ?? null,
      ownerSessionId: entry.ownerSessionId ?? null,
      active: entry.active !== false,
      deliveredCount: (entry.delivered ?? []).length,
      reason: entry.reason ?? '',
    })),
    // What the boss already filed in earlier runs. Without this it would re-report the
    // same stuck project on every tick.
    alreadyReported: visibleReported.map((finding) => ({
      id: finding.id,
      projectId: finding.projectId,
      projectName: finding.projectName,
      severity: finding.severity,
      title: finding.title,
      createdAt: finding.createdAt,
      acknowledged: finding.acknowledged,
      // 'user' = 大老板已确认；'boss' = 大哥自己撤回（结论已不适用）。
      acknowledgedBy: finding.acknowledgedBy ?? null,
      note: finding.note ?? '',
    })),
    // The boss's own duty state — see above.
    duty,
    // 归档账的元数据：退场了多少条、为什么、什么时候、谁退的。
    archive: {
      total: archive.total,
      batches: archive.batches.length,
      reason: archive.batches[0]?.reason ?? null,
      archivedAt: archive.batches[0]?.archivedAt ?? null,
      archivedBy: archive.batches[0]?.archivedBy ?? null,
    },
    // 大哥记过的每一条建议，都带上宿主那边的状态：**「记了建议」不等于「卡翻了」**。
    // 少了这一段，大哥只看得见「我答过」，看不见「哪张还卡着」。
    alreadyAnswered: answered.map((item) => ({
      requestId: item.requestId,
      sessionId: item.sessionId,
      answeredAt: item.answeredAt,
      answer: item.answer,
      ...resolveCardState(cardById.get(item.requestId)),
    })),
    // 这一轮的事件。`candidates` 是过了第一道闸的；`dropped` 说清筛掉了多少、为什么。
    triggers: {
      watermark: dutyConfig.lastRunAt ?? null,
      allowedTypes: [...TRIGGER_WHITELIST],
      candidates: markedCandidates,
      dropped: selected.dropped,
    },
    // 筛掉了多少。数字留着，人就知道「还有多少我没看见」——而不是以为那就是全部。
    excluded: {
      projects: cards.length - visibleCards.length,
      decisions: runtimeItems.length - visibleItems.length,
      openQuestionnaires: openQuestionnaires.length - visibleQuestionnaires.length,
      recoverable: recoverable.length - visibleRecoverable.length,
      goals: goalRows.length - visibleGoals.length,
      planTasks: planRows.length - visiblePlanTasks.length,
    },
    projects: withDutyCards(visibleCards, duty, managedNames).map((card) => {
      const inScope = managedNames.has(card.name);
      const ownerSessions = ownerSessionsByProject.get(card.id) ?? [];
      // The default target: the most recently active root session. The boss still judges
      // which one is the right one — this is a starting point, not an answer.
      const ownerSessionId = ownerSessions.find((session) => session.isRoot)?.id ?? null;
      return {
        id: card.id,
        name: card.name,
        path: card.path,
        health: card.health,
        sessions: card.sessionCount,
        pendingQuestions: card.pendingQuestions,
        erroredSessions: card.erroredSessions,
        lastActivityAt: card.lastActivityAt,
        // Is this project inside the boss's jurisdiction?
        managed: inScope,
        // The boss's duty state and whether it watches this project at all.
        duty: card.duty,
        ...(inScope
          ? {
            ownerSessionId,
            // The sessions the boss may talk to. Only in-scope projects carry them — a grant
            // outside the jurisdiction is not something to act on.
            ownerSessions,
          }
          : {}),
      };
    }),
    decisions: visibleItems.map((item) => ({
      id: item.id,
      kind: item.kind,
      severity: item.severity,
      projectId: item.projectId,
      projectName: item.projectName,
      sessionId: item.sessionId,
      title: item.title,
      body: item.body,
      createdAt: item.createdAt,
      // **排除不等于删除**：条目还在清单里，但必须标出「已经处理过了、为什么」。
      // 不标，大哥就会把排除过的事再报一遍（2026-11-01 13:37 那一轮查出来的）。
      acknowledged: item.acknowledged === true,
      handledBy: item.handledBy ?? null,
      handledReason: item.handledReason ?? '',
    })),
    openQuestionnaires: visibleQuestionnaires,
    recoverable: visibleRecoverable,
    goals: visibleGoals,
    planTasks: visiblePlanTasks,
    brief: buildPatrolBrief({
      cards: visibleCards,
      inbox: visibleItems,
    }),
  };

  // Spill：过长的文本换成摘要 + 续读入口。**省下来的是位置，不是内容**——
  // 每一段被 Spill 掉的原文都能按 ID 原样取回（`patrol-cli recall <id>`）。
  //
  // 例外清单是必须的：`managed[].reason` 是**大老板的原话**（授权的理由，截了它授权就说不清），
  // `scope` / `paths` 是判定口径与边界（写一半等于没说）。
  const spilled = applySpill(rawPayload, {
    exclude: ['managed[].reason', 'scope', 'fullScopeRequested', 'paths'],
  });

  // 引用图：每个内容项内联**下一跳的 ID**，模型可以顺着它一跳一跳地展开（链式召回）。
  //
  // 项目节点的下一跳只有一条：**负责会话**。「同项目的其它结论」那一跳**不在这里内联**
  // ——引用图住在系统里、不在负载里（全部结论 id 内联进来会让候选视图从 59,265 涨到
  // 80,638 字节）。召回那边按需建完整的图。
  const graph = buildFactRefGraph({
    findings: [...previousFindings, ...archivedFindings],
    projects: visibleCards.map((card) => ({
      name: card.name,
      ownerSessionId: ownerSessionIdFor(sessions, card.id),
    })),
    sessions: visibleRecoverable.map((r) => ({
      id: r.sessionId, projectName: r.projectName, title: r.sessionTitle,
    })),
    questionnaires: visibleQuestionnaires.map((q) => ({
      requestId: q.requestId, sessionId: q.sessionId, question: q.question,
    })),
    goals: visibleGoals.map((g) => ({
      goalId: g.goalId, sessionId: g.sessionId, objective: g.objective,
    })),
    planTasks: visiblePlanTasks.map((t) => ({
      projectName: t.projectName, id: t.id, title: t.title,
    })),
    triggers: selected.kept,
  });

  print({
    ...spilled.value,
    // 被 Spill 掉了什么、在哪 —— 不然「省下来的」就变成了「丢掉的」。
    spills: spilled.spills,
    // 这份事实表里有几个对象可以按 ID 取回（图住在系统里，不在这里）。
    recallable: graph.size,
    // **引用图不在这里。** 文章 §3.3 的设计是：图住在系统里，上下文里只内联**下一跳的 ID**。
    // 把整张图塞进负载，等于把「按需召回」变成「一次性全读」——那正是 Spill 要治的病。
    // 要走链，用 `patrol-cli recall <id>`（它按需重建这张图）。
  });
  store.close();
  process.exit(0);
}

if (command === 'report') {
  const fileIndex = args.indexOf('--file');
  const file = fileIndex !== -1
    ? args[fileIndex + 1]
    : positionalArgs().find((arg) => arg.endsWith('.json'));
  if (!file) {
    process.stderr.write('report 需要一个 JSON 文件参数（--file <路径> 或直接给 .json 路径）\n');
    process.exit(2);
  }
  const payload = JSON.parse(await readFile(resolve(file), 'utf8'));

  const written = [];
  // 入账被拒的结论（正文超了带宽上限）要单独报出来：大哥得知道自己写的东西没进来，
  // 而不是以为已经报上去了。
  const rejected = [];
  for (const finding of payload.findings ?? []) {
    try {
      written.push(await patrol.add({
        projectId: finding.projectId ?? null,
        projectName: finding.projectName ?? null,
        severity: finding.severity ?? 'medium',
        title: String(finding.title ?? '大哥巡检结论').slice(0, 120),
        body: String(finding.body ?? ''),
      }));
    } catch (error) {
      rejected.push({
        projectName: finding.projectName ?? null,
        severity: finding.severity ?? 'medium',
        title: String(finding.title ?? '大哥巡检结论').slice(0, 120),
        error: error?.message ?? String(error),
      });
    }
  }

  // 代答（记录大哥的建议）也走同一条核对：**查无此卡不入账**，宿主还开着的卡单独报出来。
  // 报告是批量动作，所以不因一条错就整体失败——错的单独报，和结论被拒一个待遇。
  const answeredRejected = [];
  let answeredAwaitingUser = 0;
  const cardById = new Map(store.listQuestionnaires(false).map((card) => [card.id, card]));
  for (const entry of payload.answered ?? []) {
    const cardState = resolveCardState(cardById.get(entry.requestId));
    if (!cardState.known) {
      answeredRejected.push({
        requestId: entry.requestId,
        reason: '运行时库里没有这张卡',
      });
      continue;
    }
    if (cardState.awaitingUser) answeredAwaitingUser += 1;
    await patrol.markAnswered({
      requestId: entry.requestId,
      sessionId: entry.sessionId ?? '',
      answer: entry.answer ?? '',
      rationale: entry.rationale ?? '',
      optionIds: entry.optionIds ?? [],
    });
  }

  // The handover stamp is the duty boss's, and only the duty boss's. A report from any
  // other line must not refresh it: the lamp exists to notice that the duty boss went
  // quiet, and a stranger's report feeding it is how a real dropout stays invisible.
  // The duty chain passes `--duty-stamp`; everybody else's report leaves it alone.
  const dutyStamp = args.includes('--duty-stamp');

  // A handover is proof that the host application is alive — it is running inside it.
  // The watchdog stops itself when the host is gone (there is nothing to watch and
  // nobody to tell), so a handover is also the moment to wake it back up. The gap that
  // accumulated while it slept is still in the scheduler's run log, and the watchdog
  // reports it on this wake-up.
  //
  // Best-effort, and deliberately so: a handover that failed because the watchdog
  // could not be re-enabled would be a catastrophic trade — the duty boss would stop
  // reporting to keep a watchdog quiet.
  let watchdog = null;
  if (dutyStamp) {
    try {
      const { wakeWatchdog, watchdogTaskExists, launcherPresent } = await import('./watchdog-wake.mjs');
      const launcherPath = join(dirname(fileURLToPath(import.meta.url)), 'run-watchdog-hidden.vbs');
      if (launcherPresent(launcherPath) && await watchdogTaskExists()) {
        watchdog = await wakeWatchdog();
      } else {
        watchdog = { ok: true, enabled: false, ran: false, error: null, reason: 'not_installed' };
      }
    } catch (error) {
      watchdog = { ok: false, enabled: false, ran: false, error: error?.message ?? String(error) };
    }
  }

  if (dutyStamp) await patrol.setConfig({ lastRunAt: Date.now() });

  print({
    ok: true,
    findings: written.length,
    rejected,
    answered: (payload.answered ?? []).length - answeredRejected.length,
    // 宿主还开着的那几张：大哥记了建议，但卡没翻、那个会话还卡着。
    answeredAwaitingUser,
    // 查无此卡的那些：没入账，得让大哥知道少记了什么。
    answeredRejected,
    dutyStamp,
    // Whether the watchdog was woken up. It is reported, not enforced: the handover
    // above already went through either way.
    watchdog: watchdog ? { ok: watchdog.ok, enabled: watchdog.enabled, ran: watchdog.ran } : null,
  });
  store.close();
  process.exit(0);
}

if (command === 'withdraw') {
  // The boss retracting a conclusion of its own that turned out to be wrong — a stale fact, a
  // duplicate, an alarm that was not real. The reason is mandatory on purpose: a retraction
  // without a reason is just a quieter kind of noise.
  const positional = positionalArgs();
  const [, id, ...reasonParts] = positional;
  const reason = reasonParts.join(' ').trim();
  if (!id || !reason) {
    process.stderr.write('用法：withdraw <结论id> <撤回理由>\n');
    store.close();
    process.exit(2);
  }
  const ok = await patrol.withdraw(id, reason);
  print({ ok, id, reason, acknowledgedBy: 'boss' });
  store.close();
  process.exit(ok ? 0 : 1);
}

if (command === 'dismiss') {
  // The boss ruling out a RAW runtime item it has proved is not a problem — a session error
  // that is actually a 122-day-old leftover, a plan task that is not really blocked. The
  // reason is mandatory: excluding something without saying why is just quieter noise.
  const positional = positionalArgs();
  const [, id, ...reasonParts] = positional;
  const reason = reasonParts.join(' ').trim();
  if (!id || !reason) {
    process.stderr.write('用法：dismiss <收件箱条目id> <排除理由>\n');
    store.close();
    process.exit(2);
  }
  const persistence = new Persistence(dataDir);
  const dismissed = await persistence.addDismissed(id, reason);
  print({ ok: true, id, reason, dismissed: dismissed.length });
  store.close();
  process.exit(0);
}

if (command === 'archive') {
  // 归档：把账上的结论搬进归档账，然后清空账本。
  //
  // **一条都不删**——退场的结论连同原文搬进 `patrol-archive.json`，附上这次归档的元数据
  // （什么时候、谁、为什么、多少条）。理由是必填的：以后有人问「这条为什么退场了」，
  // 答案只能在那儿。
  //
  // 不带理由时是**只读**：把归档账打出来。
  const reason = positionalArgs().slice(1).join(' ').trim();
  try {
    if (!reason) {
      const archive = await patrol.listArchive();
      print({
        ok: true,
        archived: archive.total,
        batches: archive.batches.map((batch) => ({
          archivedAt: batch.archivedAt,
          archivedBy: batch.archivedBy,
          reason: batch.reason,
          count: batch.count,
        })),
      });
    } else {
      const result = await patrol.archive({ reason, by: 'boss' });
      print({
        ok: true,
        archived: result.archived,
        reason: result.reason,
        archivedBy: result.archivedBy,
        archivedAt: result.archivedAt,
      });
    }
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n`);
    store.close();
    process.exit(2);
  }
  store.close();
  process.exit(0);
}

if (command === 'answer') {
  // 大哥替大老板**表态**一张待答的卡。
  //
  // **这条命令存在的理由是「大哥不再手写账」。** 在它之前，代答是往
  // `patrol-answered.json` 里手写 JSON——那个文件一旦被收进板面状态 store，大哥再手写，
  // 板面就再也读不到了（代答会**静默失效**：大老板以为有人替他答了，其实没有）。
  // 给它一条命令，手和账就脱钩了。
  //
  // **只记答案**：不写结论、**不打交班戳**。交班戳是值班大哥的（见 `report` 里的说明），
  // 代答一张卡不是交班。
  //
  // **它记的是「大哥的建议」，不是「这张卡已经翻了」。** CLI 没有宿主的投递口——
  // Mini App 只能续自己拥有的会话（宿主所有权闸），而 CLI 连 Mini App 运行时都不在。
  // 所以这条命令翻不了宿主那张卡。以前它回一句 `ok: true`，看着像答了，其实没答：
  // 宿主卡照样 `status='pending'`、那个会话照样卡着（2026-11-01 13:07 轮查出来的）。
  // 现在它先直读运行时核对这张卡，再如实报出宿主状态。
  //
  // 幂等：同一个 `requestId` 记过一次就不再记（`markAnswered` 自己判）。
  const positional = positionalArgs();
  const [, requestId] = positional;
  const answer = flag('answer', '');
  const rationale = flag('rationale', '');
  const sessionId = flag('session-id', '');
  const optionIds = allFlags('option-id');
  if (!requestId || !answer) {
    process.stderr.write('用法：answer <requestId> --answer "<选项>" [--rationale "<理由>"] [--session-id <会话id>] [--option-id <id>]\n');
    store.close();
    process.exit(2);
  }
  // **查无此卡就不入账**：给一张不存在的卡记一笔「已答」，是造一笔谁也查不到底的假账。
  const card = store.listQuestionnaires(false).find((item) => item.id === requestId);
  const cardState = resolveCardState(card);
  if (!cardState.known) {
    process.stderr.write(`运行时库里没有这张卡（${requestId}）——没有入账。核对 requestId 是否逐字一致。\n`);
    store.close();
    process.exit(2);
  }
  const answered = await patrol.markAnswered({
    requestId,
    sessionId,
    answer,
    rationale,
    optionIds,
  });
  print({
    ok: true,
    requestId,
    sessionId,
    answer,
    rationale,
    optionIds,
    answered: answered.length,
    // 宿主那边这张卡开没开。**这是两件事，不是一件事**。
    known: cardState.known,
    hostStatus: cardState.hostStatus,
    awaitingUser: cardState.awaitingUser,
    note: cardState.awaitingUser
      ? '宿主卡仍开着：这条只记了大哥的建议，没有翻转宿主卡，那个会话还卡着。'
        + '真正解锁要由大老板在板面点「按大哥的建议回复」。'
      : null,
  });
  store.close();
  process.exit(0);
}

if (command === 'export-legacy') {
  // 把 store 的内容**显式**写回老文件。
  //
  // 过渡期的保险：万一这套收口后来被否掉了、或者镜像写失败过、或者 store 文件丢了，
  // 老代码（它只读老文件）得能读到**最新的**数据，而不是迁移那一刻的快照。
  //
  // **回退是显式动作，不是自愈**——所以它是一条命令，不是一个后台任务。
  const { BoardStateStore } = await import('./board-state.mjs');
  const result = await new BoardStateStore(dataDir).exportLegacy();
  print({ ok: result.failed.length === 0, written: result.written, failed: result.failed });
  store.close();
  process.exit(result.failed.length === 0 ? 0 : 1);
}

process.stderr.write(`未知命令：${command}\n可用：facts / report / answer / withdraw / dismiss / archive / gap / manage / duty-cron / paths / export-legacy\n`);
store.close();
process.exit(2);

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Resolve a project name the way the board names it: the last path segment of the workspace.
 *
 * The jurisdiction list matches on that name, so a name that resolves to nothing is a grant
 * that silently governs nothing — the boss would dutifully report "当前无管辖项目" every round
 * without ever learning that the name was the problem. So the CLI refuses such a grant
 * instead of accepting it.
 *
 * **实现在 `managed-projects.mjs`（`matchManagedProject`）**——解析只有这一份，板面侧
 * 直通用的是同一个函数。曾经 CLI 自己留了一份，板面侧没有，两边口径分叉。
 *
 * @param {string} name
 * @param {Array<{ id:number, workspaceDir:string }>} projects
 * @returns {{ project: { id:number, name:string, path:string }|null, candidates: string[] }}
 */
function resolveProject(name, projects) {
  return matchManagedProject(name, projects);
}

/**
 * The jurisdiction list, each entry resolved against the live project set.
 *
 * `matched: false` means the grant names something that is not a project — the boss has
 * authority over nothing there, and must say so instead of quietly doing nothing.
 *
 * **解析只有这一份实现**（`managed-projects.mjs` 的 `resolveManagedEntries`）：板面侧
 * 直通用的是同一份。曾经两边各算各的，板面那份拿到的是**没解析过的原始条目**，
 * 于是管辖名单算成空的，直通一条也投不出去（2026-11-01 上岗验收时真机抓到）。
 *
 * @returns {Promise<Array<object>>}
 */
async function managedList() {
  return resolveManagedEntries(await managed.list(), store.listProjects());
}

/**
 * 这条线的负责会话：**项目的根会话**（`parentSessionId == null`）。
 *
 * **两个入口必须用同一份算法** —— `facts`（给模型看的引用图）和 `recall`（按 ID 取回的
 * 链式展开）都要用它。分叉过一次：2026-11-01 上岗验收时 `recall` 入口把
 * `ownerSessionId` 写死成 `null`，于是事实表内联的那一跳说「结论 → 项目 → 会话」能走通，
 * 召回却只到项目为止——最难查的那类不一致，而且两边都不报错。
 *
 * 多个根会话时取**最近活跃**的那个（`listSessions` 已按 `updated_at_ms` 降序排）。
 * 项目可能开过好几条根会话，派工要发给还活着的那条。
 *
 * @param {any[]} sessions 运行时会话
 * @param {number|string} projectId
 * @returns {string|null}
 */
function ownerSessionIdFor(sessions, projectId) {
  const roots = (sessions ?? [])
    .filter((session) => session.projectId === projectId && session.parentSessionId == null)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return roots[0]?.id ?? null;
}

function extractQuestion(requestJson) {
  try {
    const parsed = JSON.parse(requestJson);
    const steps = Array.isArray(parsed?.steps) ? parsed.steps : [];
    const questions = steps
      .map((step) => (typeof step?.question === 'string' ? step.question : ''))
      .filter(Boolean);
    return questions.join(' / ') || (typeof parsed?.title === 'string' ? parsed.title : '');
  } catch {
    return '';
  }
}

function extractSteps(requestJson) {
  try {
    const parsed = JSON.parse(requestJson);
    const steps = Array.isArray(parsed?.steps) ? parsed.steps : [];
    return steps.map((step) => step?.id).filter((id) => typeof id === 'string');
  } catch {
    return [];
  }
}

function extractOptions(requestJson) {  try {
    const parsed = JSON.parse(requestJson);
    const steps = Array.isArray(parsed?.steps) ? parsed.steps : [];
    return steps.flatMap((step) => (Array.isArray(step?.options) ? step.options : []))
      .map((option) => ({
        id: option?.id ?? '',
        label: option?.label ?? '',
        // The payload marks the recommended option; the boss should prefer it.
        recommended: option?.recommended === true,
      }))
      .filter((option) => option.id);
  } catch {
    return [];
  }
}
