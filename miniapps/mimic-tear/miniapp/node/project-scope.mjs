/**
 * 项目这个「东西」的可见性与命名。
 *
 * 两条规则都关于「这是不是用户自己的项目」：运行时内部工作区要滤掉，用户项目的显示名要
 * 从路径末段取出来。它们以前分别住在 view-model 与 project-service 里，现在住在一起，
 * 因为看的是同一件事。
 */

/**
 * 运行时内部工作区。
 *
 * 运行时给每个 agent 的默认目录、以及每个装好的 Mini App 都注册了一个 workspace。那些是
 * 管道的 plumbing，不是用户的项目，把它们当成「workspace」行列出来会让看板看起来像坏了。
 * 它们被滤掉并计数，好让页面说清楚藏了多少，而不是悄悄消失。
 */
const INTERNAL_WORKSPACE = /[\\/]\.(?:minimax|mavis)[\\/](?:agents[\\/][^\\/]+[\\/](?:workspace|miniapps)|workspace)([\\/]|$)/i;

/**
 * 这条路径是不是运行时自己的内部工作区。
 *
 * @param {string} workspaceDir
 * @returns {boolean}
 */
export function isInternalWorkspace(workspaceDir) {
  return Boolean(workspaceDir) && INTERNAL_WORKSPACE.test(workspaceDir);
}

/**
 * 把项目行分成「用户看得见的」与「运行时内部的」。
 *
 * 内部项目被滤掉，但数量要留着：页面得说清楚藏了多少，而不是悄悄消失。
 *
 * @param {any[]} projects
 * @returns {{ visible: any[], internalCount: number }}
 */
export function splitVisibleProjects(projects) {
  const all = projects ?? [];
  const visible = all.filter((project) => !isInternalWorkspace(project.workspaceDir));
  return { visible, internalCount: all.length - visible.length };
}

/**
 * 项目的显示名：路径的最后一段。
 *
 * @param {string} workspaceDir
 * @returns {string}
 */
export function projectName(workspaceDir) {
  if (!workspaceDir) return '未知项目';
  const normalized = workspaceDir.replace(/[\\/]+$/, '');
  const segments = normalized.split(/[\\/]/);
  return segments[segments.length - 1] || normalized;
}
