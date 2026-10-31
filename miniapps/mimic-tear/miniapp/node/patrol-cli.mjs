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
import { buildDutyStatus, buildInbox, buildOrgTree, buildPatrolBrief, buildProjectCards, projectName, withDutyCards } from './view-model.mjs';
import { PatrolStore } from './patrol-store.mjs';
import { Persistence } from './persistence.mjs';
import { ManagedProjects } from './managed-projects.mjs';
import { DutyIntent } from './duty-intent.mjs';
import { selectTriggers } from './trigger.mjs';
import { detectTriggers, TRIGGER_WHITELIST } from './trigger-source.mjs';
import { ThreadSubscriptions } from './thread-subscriptions.mjs';

const args = process.argv.slice(2);
const command = args.find((arg) => !arg.startsWith('--')) ?? 'facts';
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};

const dataDir = resolve(flag('data-dir', join(homedir(), '.minimax', 'v2', 'plugin-data', 'liveboards', 'mimic-tear')));
const dbPath = resolve(flag('db', process.env.MIMIC_RUNTIME_DB
  ?? join(homedir(), '.minimax', 'v2', 'sqlite', 'runtime-state.sqlite')));

/** Flags that take a value; the value must not be mistaken for a positional argument. */
const VALUE_FLAGS = new Set(['--data-dir', '--db', '--file', '--scope']);

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
    findings: patrol.findingsPath,
    answered: patrol.answeredPath,
    config: patrol.configPath,
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
      const resolution = resolveProject(name, store.listProjects());
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
  const runtimeItems = buildInbox({ projects, sessions, goals, questionnaires, plans }, new Set());
  const answered = await patrol.listAnswered();
  const answeredIds = new Set(answered.map((item) => item.requestId));
  const previousFindings = await patrol.list();

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

  const openQuestionnaires = questionnaires
    .filter((q) => !answeredIds.has(q.id))
    .map((q) => {
      const session = sessionById.get(q.sessionId);
      const project = projectById.get(session?.projectId);
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
  const duty = {
    ...buildDutyStatus({
      config: await patrol.getConfig(),
      findings: previousFindings,
      intent: dutyIntentState,
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
  const visibleReported = previousFindings;

  // 这一轮真的发生了什么。
  //
  // 事件从**全量**行里认——不先筛——然后交给第一道闸（`selectTriggers`）去筛。这样「筛掉
  // 了多少」才是真的数字，而不是自己筛完自己报「一个没筛掉」。
  //
  // 水位线是**交班戳**：上一轮交班之后发生的事，就是这一轮的事件。没有新状态文件。
  const dutyConfig = await patrol.getConfig();
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

  print({
    generatedAt: Date.now(),
    // Which view this is. `candidates` is what the model gets by default; `raw` means the
    // caller explicitly asked for everything — and the payload says so, so that whoever
    // reads it later can tell "this is all of it" from "this was filtered".
    scope,
    fullScopeRequested: wantRaw,
    paths: {
      report: join(dataDir, 'patrol.json'),
      answered: join(dataDir, 'patrol-answered.json'),
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
    alreadyAnswered: answered.map((item) => ({
      requestId: item.requestId,
      sessionId: item.sessionId,
      answeredAt: item.answeredAt,
      answer: item.answer,
    })),
    // 这一轮的事件。`candidates` 是过了第一道闸的；`dropped` 说清筛掉了多少、为什么。
    triggers: {
      watermark: dutyConfig.lastRunAt ?? null,
      allowedTypes: [...TRIGGER_WHITELIST],
      candidates: selected.kept,
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
    })),
    openQuestionnaires: visibleQuestionnaires,
    recoverable: visibleRecoverable,
    goals: visibleGoals,
    planTasks: visiblePlanTasks,
    brief: buildPatrolBrief({
      cards: visibleCards,
      inbox: visibleItems,
    }),
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
  for (const finding of payload.findings ?? []) {
    written.push(await patrol.add({
      projectId: finding.projectId ?? null,
      projectName: finding.projectName ?? null,
      severity: finding.severity ?? 'medium',
      title: String(finding.title ?? '大哥巡检结论').slice(0, 120),
      body: String(finding.body ?? ''),
    }));
  }

  for (const entry of payload.answered ?? []) {
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
    answered: (payload.answered ?? []).length,
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

process.stderr.write(`未知命令：${command}\n可用：facts / report / withdraw / dismiss / gap / manage / duty-cron / paths\n`);
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
 * @param {string} name
 * @param {Array<{ id:number, workspaceDir:string }>} projects
 * @returns {{ project: { id:number, name:string, path:string }|null, candidates: string[] }}
 */
function resolveProject(name, projects) {
  const wanted = String(name ?? '').trim();
  const rows = (projects ?? []).map((project) => ({
    id: project.id,
    name: projectName(project.workspaceDir),
    path: project.workspaceDir,
  }));
  const exact = rows.find((row) => row.name === wanted) ?? null;
  if (exact) return { project: exact, candidates: [] };

  // Only useful when the name is close but not right: same letters, different case, or one
  // name inside the other. A wild guess is worse than none.
  const needle = wanted.toLowerCase();
  const candidates = rows
    .map((row) => row.name)
    .filter((candidate) => {
      const lower = candidate.toLowerCase();
      return lower === needle || lower.includes(needle) || needle.includes(lower);
    });
  return { project: null, candidates: [...new Set(candidates)] };
}

/**
 * The jurisdiction list, each entry resolved against the live project set.
 *
 * `matched: false` means the grant names something that is not a project — the boss has
 * authority over nothing there, and must say so instead of quietly doing nothing.
 *
 * @returns {Promise<Array<object>>}
 */
async function managedList() {
  const entries = await managed.list();
  const projects = store.listProjects();
  return entries.map((entry) => {
    const resolved = resolveProject(entry.name, projects);
    return {
      ...entry,
      matched: resolved.project !== null,
      projectId: resolved.project?.id ?? entry.projectId ?? null,
      projectName: resolved.project?.name ?? null,
      path: resolved.project?.path ?? entry.path ?? null,
    };
  });
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
