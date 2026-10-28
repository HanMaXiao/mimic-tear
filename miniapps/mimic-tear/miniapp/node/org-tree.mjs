/**
 * 组织树的还原。
 *
 * 运行时会话之间有父子关系（负责人 → 下属），看板要按这层关系把会话排成树。
 */

/**
 * @typedef {{ id:string, agentName:string, title:string, workspaceDir:string,
 *             purpose:string|null, purposeKind:string|null, parentSessionId:string|null,
 *             sessionType:string, visibility:string, createdAt:number, updatedAt:number,
 *             errorCode:number|null, errorMessage:string|null, projectId:number|null }} SessionRow
 * @typedef {{ id:string, agentName:string, title:string, status:string,
 *             role:'lead'|'member', purpose:string|null, error:string|null,
 *             children:OrgNode[] }} OrgNode
 */

/**
 * 按运行时的父子链接还原组织树。
 *
 * 父会话不在这一组里（被删了，或者住在别的项目）的会话会被提升为根，这样一个节点都不会
 * 丢。
 *
 * @param {SessionRow[]} sessions
 * @returns {OrgNode[]}
 */
export function buildOrgTree(sessions) {
  const list = sessions ?? [];
  const byId = new Map(list.map((s) => [s.id, s]));

  /** @type {Map<string, OrgNode[]>} */
  const childrenOf = new Map();
  /** @type {OrgNode[]} */
  const roots = [];

  for (const session of list) {
    const node = {
      id: session.id,
      agentName: session.agentName,
      title: session.title || session.id,
      status: session.status,
      role: 'member',
      purpose: session.purpose,
      error: session.errorMessage || (session.errorCode != null ? `错误码 ${session.errorCode}` : null),
      children: [],
    };

    const parentId = session.parentSessionId;
    if (parentId && byId.has(parentId) && parentId !== session.id) {
      if (!childrenOf.has(parentId)) childrenOf.set(parentId, []);
      childrenOf.get(parentId).push(node);
    } else {
      node.role = 'lead';
      roots.push(node);
    }
  }

  const attach = (node) => {
    const children = childrenOf.get(node.id) ?? [];
    node.children = children;
    for (const child of children) attach(child);
  };
  for (const root of roots) attach(root);

  // Sessions that are their own parent's descendant but whose parent vanished are already
  // roots; guard against cycles so a malformed link cannot hang the page.
  const visited = new Set();
  const walk = (node) => {
    if (visited.has(node.id)) {
      node.children = [];
      return;
    }
    visited.add(node.id);
    for (const child of node.children) walk(child);
  };
  for (const root of roots) walk(root);

  return roots;
}
