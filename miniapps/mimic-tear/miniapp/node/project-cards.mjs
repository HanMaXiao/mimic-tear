/**
 * 看板总览上的项目卡。
 *
 * 一张卡把一个项目的运行时行（会话、Goal、问卷、计划任务）收成一行摘要，并给出健康度。
 * 全部是纯函数：不碰 IO、不读时钟，所以卡片的规则可以直接被测试钉住。
 */

import { groupBy } from './collections.mjs';
import { computeHealth } from './health-rules.mjs';
import { projectName } from './project-scope.mjs';
import { isUnresolvedQuestion } from './questionnaire-rules.mjs';

/**
 * @typedef {{ id:number, kind:string, workspaceDir:string, pinned:boolean, hidden:boolean,
 *             orderIndex:number, recentAt:number|null, latestActivityAt:number|null,
 *             sessionCount:number }} ProjectRow
 * @typedef {{ id:string, sessionId:string, objective:string, status:string, createdAt:number,
 *             updatedAt:number, tokensUsed:number, timeUsedSeconds:number,
 *             statusReason:string|null, lastVerification:string|null,
 *             dismissedAt:number|null }} GoalRow
 * @typedef {{ id:string, sessionId:string, agentName:string, requestJson:string,
 *             status:string, createdAt:number }} QuestionnaireRow
 * @typedef {{ id:string, ownerSessionId:string, kind:string, status:string, createdAt:number,
 *             updatedAt:number, endedAt:number|null }} TaskRow
 * @typedef {{ id:string|null, title:string, state:string, assignedTo:string|null }} PlanTask
 * @typedef {{ source:string, updatedAt:number, tasks:PlanTask[] }} PlanSnapshot
 * @typedef {{ id:number, name:string, path:string, sessionCount:number,
 *             lastActivityAt:number|null, health:import('./health-rules.mjs').Health,
 *             activeSessions:number, erroredSessions:number, pendingQuestions:number,
 *             goals:GoalRow[], planTasks:PlanTask[], planUpdatedAt:number|null }} ProjectCard
 */

/**
 * 构建总览上的项目卡。
 *
 * @param {{ projects: ProjectRow[], sessions: any[], goals: GoalRow[],
 *           questionnaires: QuestionnaireRow[], tasks?: TaskRow[],
 *           plans: Map<number, PlanSnapshot|null> }} input
 * @returns {ProjectCard[]}
 */
export function buildProjectCards(input) {
  const projects = input.projects ?? [];
  const sessions = input.sessions ?? [];
  const goals = input.goals ?? [];
  const questionnaires = input.questionnaires ?? [];
  const tasks = input.tasks ?? [];
  const plans = input.plans ?? new Map();

  const sessionsByProject = groupBy(sessions, (s) => s.projectId);
  const goalsBySession = groupBy(goals, (g) => g.sessionId);
  const questionsBySession = groupBy(questionnaires, (q) => q.sessionId);
  const tasksByOwner = groupBy(tasks, (t) => t.ownerSessionId);

  return projects.map((project) => {
    const projectSessions = sessionsByProject.get(project.id) ?? [];

    const projectGoals = projectSessions.flatMap((s) => goalsBySession.get(s.id) ?? []);
    const projectQuestions = projectSessions.flatMap((s) => questionsBySession.get(s.id) ?? []);
    const pendingQuestions = projectQuestions.filter((q) => isUnresolvedQuestion(q.status));

    const plan = plans.get(project.id) ?? null;
    const planTasks = plan?.tasks ?? [];

    // A running background task is in-flight work even when no session is marked started.
    const runningTasks = projectSessions
      .flatMap((s) => tasksByOwner.get(s.id) ?? [])
      .filter((t) => t.status !== 'succeeded' && t.status !== 'failed' && t.status !== 'canceled').length;

    const activeSessions = projectSessions.filter((s) => s.status === 'started').length;

    return {
      id: project.id,
      name: projectName(project.workspaceDir),
      path: project.workspaceDir,
      // The denormalised `session_count` on the project row counts root sessions only, while
      // the org tree shows every session. Using the real count keeps the two views consistent.
      sessionCount: projectSessions.length,
      lastActivityAt: project.latestActivityAt ?? projectSessions[0]?.updatedAt ?? null,
      health: computeHealth({
        sessions: projectSessions,
        pendingQuestions: pendingQuestions.length,
        goals: projectGoals,
        planTasks,
        activeTasks: runningTasks,
      }),
      activeSessions,
      erroredSessions: projectSessions.filter((s) => s.status === 'error' || s.errorCode != null).length,
      pendingQuestions: pendingQuestions.length,
      goals: projectGoals,
      planTasks,
      // When the plan state was last written. A plan log can be months old, and a task
      // state that old is a historical fact, not a live signal — the board must say so.
      planUpdatedAt: plan?.updatedAt ?? null,
    };
  });
}
