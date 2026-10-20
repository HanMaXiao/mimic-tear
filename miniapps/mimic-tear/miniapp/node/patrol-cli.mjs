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
 *   paths            print the paths the boss writes to
 *
 * Options:
 *   --data-dir <dir>   where the board keeps its state (default: the published board's dir)
 *   --db <file>        runtime state database (default: ~/.minimax/v2/sqlite/runtime-state.sqlite)
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { RuntimeStore } from './runtime-store.mjs';
import { readPlan } from './plan-store.mjs';
import { buildInbox, buildOrgTree, buildPatrolBrief, buildProjectCards } from './view-model.mjs';
import { PatrolStore } from './patrol-store.mjs';

const args = process.argv.slice(2);
const command = args.find((arg) => !arg.startsWith('--')) ?? 'facts';
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};

const dataDir = resolve(flag('data-dir', join(homedir(), '.minimax', 'v2', 'plugin-data', 'liveboards', 'mimic-tear')));
const dbPath = resolve(flag('db', process.env.MIMIC_RUNTIME_DB
  ?? join(homedir(), '.minimax', 'v2', 'sqlite', 'runtime-state.sqlite')));

const store = RuntimeStore.open(dbPath);
const patrol = new PatrolStore(dataDir);

if (command === 'paths') {
  print({ dataDir, dbPath, findings: patrol.findingsPath, answered: patrol.answeredPath, config: patrol.configPath });
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

  print({
    generatedAt: Date.now(),
    paths: {
      report: join(dataDir, 'patrol.json'),
      answered: join(dataDir, 'patrol-answered.json'),
      db: dbPath,
    },
    // What the boss already filed in earlier runs. Without this it would re-report the
    // same stuck project on every tick.
    alreadyReported: (await patrol.list()).map((finding) => ({
      id: finding.id,
      projectId: finding.projectId,
      projectName: finding.projectName,
      severity: finding.severity,
      title: finding.title,
      createdAt: finding.createdAt,
      acknowledged: finding.acknowledged,
    })),
    alreadyAnswered: answered.map((item) => ({
      requestId: item.requestId,
      sessionId: item.sessionId,
      answeredAt: item.answeredAt,
      answer: item.answer,
    })),
    projects: cards.map((card) => ({
      id: card.id,
      name: card.name,
      path: card.path,
      health: card.health,
      sessions: card.sessionCount,
      pendingQuestions: card.pendingQuestions,
      erroredSessions: card.erroredSessions,
      lastActivityAt: card.lastActivityAt,
    })),
    decisions: runtimeItems.map((item) => ({
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
    openQuestionnaires,
    recoverable,
    goals: goalRows,
    planTasks: planRows,
    brief: buildPatrolBrief({
      cards,
      inbox: runtimeItems,
    }),
  });
  store.close();
  process.exit(0);
}

if (command === 'report') {
  const fileIndex = args.indexOf('--file');
  const file = fileIndex !== -1
    ? args[fileIndex + 1]
    : args.find((arg) => arg.endsWith('.json'));
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

  await patrol.setConfig({ lastRunAt: Date.now() });

  print({ ok: true, findings: written.length, answered: (payload.answered ?? []).length });
  store.close();
  process.exit(0);
}

process.stderr.write(`未知命令：${command}\n可用：facts / report / paths\n`);
store.close();
process.exit(2);

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
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
