/**
 * 上下文组织：把有限的窗口当 **Cache** 管。
 *
 * 文章 §3.3 的两个基本操作：
 *
 * - **Inline** —— 把近期很可能用到的信息**直接内联**进上下文，省掉一次工具往返。
 * - **Spill** —— 把超出窗口预算或低频使用的完整信息**留在窗口之外**，只留引用或摘要，
 *   模型需要时再读回来。
 *
 * 文章那句最该抄的是：**「浪费上下文窗口，就是浪费模型的智能。」**
 *
 * ## 为什么召回按 ID，而不是按「搜一下」
 *
 * 上下文里保留的是**引用**，不是内容。模型要拿全文时，按 ID 取回——这跟「重新搜一遍」是
 * 两件事：搜要重新读一堆不相干的东西，ID 取回是精确的一跳。文章 §3.3 的链式召回就是
 * 这个意思：**每次召回的对象本身也内联下一跳的 ID**，于是模型能顺着引用关系一���跳一跳地展开。
 *
 * ## 一条硬约束：Spill 出去的东西不能丢
 *
 * 摘要**代替**原文是允许的；原文**没了**不允许。所以每个被截断的对象都必须能用 ID 原样取回，
 * 而 `planRecall` 的每一跳都必须带得回自己的摘要。**「省下来的不是内容，是位置。」**
 */

/**
 * 内联文本的上限（字符）。
 *
 * 够读懂一件事，够记住它是什么，但不够读完一整段报告。要全文就按 ID 取回。
 */
export const SPILL_LIMIT = 160;

/**
 * 一次召回最多展开几跳。
 *
 * 三跳够从「一条结论」走到「它所在的线」再走到「那条线上别的结论」——而再多跳就变成
 * 把整个仓库读一遍了，那不是召回，是重扫。
 */
export const DEFAULT_MAX_HOPS = 3;

/**
 * @typedef {{summary:string, length:number, spilled:boolean}} InlineText
 */

/**
 * 把一段长文本内联成摘要，长出来的部分 Spill 出去。
 *
 * @param {any} text
 * @param {number} [limit]
 * @returns {InlineText}
 */
export function inlineText(text, limit = SPILL_LIMIT) {
  const value = typeof text === 'string' ? text : '';
  if (!value) return { summary: '', length: 0, spilled: false };
  if (value.length <= limit) return { summary: value, length: value.length, spilled: false };
  // 截在空白边界上，别把词切一半——半截词比长句子更难读。
  const cut = value.slice(0, limit);
  const space = cut.lastIndexOf(' ');
  const head = space > limit * 0.6 ? cut.slice(0, space) : cut;
  return {
    summary: `${head}…（共 ${value.length} 字，按 ID 取全文）`,
    length: value.length,
    spilled: true,
  };
}

/**
 * 对整个负载做 Spill：**任何**过长的字符串都被换成摘要，并记下它被 Spill 到了哪里。
 *
 * ## 为什么用「通用遍历」而不是逐字段改
 *
 * 逐字段改会有几十处，而**每多一处就多一个漏改的机会**——漏掉的那一处会静默地继续占窗口。
 * 通用遍历一次覆盖全部；代价是要有一份**例外清单**（下面那些不该被截断的字段）。
 *
 * ## 例外清单是必须的，不是可选的
 *
 * 有些字符串**不能**截断：
 *
 * - `managed[].reason` —— 那是**大老板的原话**，是授权的理由。截了它，授权就说不清了。
 * - `duty.*` / `scope` —— 那是判定口径与边界，写一半等于没说。
 * - `paths.*` —— 路径，截了就找不到了。
 *
 * @param {any} value
 * @param {{limit?:number, exclude?:string[], path?:string}} [options]
 * @returns {{value:any, spills:Array<{path:string, length:number}>}}
 */
export function applySpill(value, options = {}) {
  const limit = Number.isFinite(Number(options?.limit)) && Number(options.limit) > 0
    ? Number(options.limit)
    : SPILL_LIMIT;
  // 例外清单按**路径片段前缀**匹配，且数组下标被归一化成 `[]`——
  // 所以 `managed[].reason` 能盖住任意一条 managed 项的 reason。
  const excludes = (options?.exclude ?? []).map((pattern) =>
    String(pattern).split('.').filter(Boolean));
  // 路径里的数组下标要归一化成 `[]`，否则 `managed[].reason` 盖不住 `managed[0].reason`。
  const segmentsOf = (path) => path
    .split('.')
    .filter(Boolean)
    .map((part) => part.replace(/\[\d+\]/g, '[]'));
  const excluded = (path) => {
    const segments = segmentsOf(path);
    return excludes.some((pattern) => pattern.every((part, index) => segments[index] === part));
  };
  const spills = [];

  const walk = (node, path) => {
    if (typeof node === 'string') {
      if (excluded(path)) return node;
      const inlined = inlineText(node, limit);
      if (inlined.spilled) spills.push({ path, length: inlined.length });
      return inlined.summary;
    }
    if (Array.isArray(node)) {
      return node.map((item, index) => walk(item, `${path}[${index}]`));
    }
    if (node && typeof node === 'object') {
      const out = {};
      for (const [key, child] of Object.entries(node)) {
        out[key] = walk(child, path ? `${path}.${key}` : key);
      }
      return out;
    }
    return node;
  };

  return { value: walk(value, options?.path ?? ''), spills };
}

/**
 * 从事实表的原始数组建引用图。
 *
 * **纯函数**：只认传入的数组，不碰 IO。所以 `facts` 与 `recall` 两个入口算出来的图
 * 一定是同一张——这很重要，因为「板面说能召回、召回却找不到」是最难查的那类不一致。
 *
 * 节点 id 就是对象自己的 id（不同类型不在同一命名空间，见 `buildRefGraph` 的说明）。
 *
 * @param {{
 *   findings?:Array<{id?:string, projectName?:string|null, title?:string|null}>,
 *   projects?:Array<{name?:string, ownerSessionId?:string|null}>,
 *   sessions?:Array<{id?:string, projectName?:string|null, title?:string|null}>,
 *   questionnaires?:Array<{requestId?:string, sessionId?:string|null, question?:string|null}>,
 *   goals?:Array<{goalId?:string, sessionId?:string|null, objective?:string|null}>,
 *   planTasks?:Array<{projectName?:string, id?:string, title?:string|null}>,
 *   triggers?:Array<{id?:string, type?:string, summary?:string, refs?:string[]}>,
 * }} input
 * @returns {Map<string, RefNode>}
 */
export function buildFactRefGraph(input = {}) {
  const entries = [];

  for (const finding of input?.findings ?? []) {
    if (!finding?.id) continue;
    entries.push({
      id: String(finding.id),
      kind: 'conclusion',
      summary: String(finding.title ?? finding.id),
      refs: finding.projectName ? [String(finding.projectName)] : [],
    });
  }
  for (const project of input?.projects ?? []) {
    if (!project?.name) continue;
    entries.push({
      id: String(project.name),
      kind: 'project',
      summary: `项目 ${project.name}`,
      refs: project.ownerSessionId ? [String(project.ownerSessionId)] : [],
    });
  }
  for (const session of input?.sessions ?? []) {
    if (!session?.id) continue;
    entries.push({
      id: String(session.id),
      kind: 'session',
      summary: String(session.title ?? session.id),
      refs: session.projectName ? [String(session.projectName)] : [],
    });
  }
  for (const questionnaire of input?.questionnaires ?? []) {
    if (!questionnaire?.requestId) continue;
    entries.push({
      id: String(questionnaire.requestId),
      kind: 'questionnaire',
      summary: String(questionnaire.question ?? questionnaire.requestId),
      refs: questionnaire.sessionId ? [String(questionnaire.sessionId)] : [],
    });
  }
  for (const goal of input?.goals ?? []) {
    if (!goal?.goalId) continue;
    entries.push({
      id: String(goal.goalId),
      kind: 'goal',
      summary: String(goal.objective ?? goal.goalId),
      refs: goal.sessionId ? [String(goal.sessionId)] : [],
    });
  }
  for (const task of input?.planTasks ?? []) {
    if (!task?.id) continue;
    const projectName = task.projectName ? String(task.projectName) : '';
    entries.push({
      id: `${projectName}:${task.id}`,
      kind: 'plan-task',
      summary: String(task.title ?? task.id),
      refs: projectName ? [projectName] : [],
    });
  }
  for (const trigger of input?.triggers ?? []) {
    if (!trigger?.id) continue;
    entries.push({
      id: String(trigger.id),
      kind: 'trigger',
      summary: String(trigger.summary ?? trigger.id),
      refs: Array.isArray(trigger.refs) ? trigger.refs.map((ref) => String(ref)) : [],
    });
  }

  return buildRefGraph(entries);
}

/**
 * @typedef {{
 *   id:string,
 *   kind:string,
 *   summary:string,
 *   refs:string[],
 * }} RefNode
 */

/**
 * 建一张引用图。
 *
 * **节点的 id 就是对象自己的 id**——不加前缀。不同类型的 id 本来就不在同一命名空间里
 * （会话是 `mvs_…`、结论是 `session-error:…`、问卷是 `ask_…`、项目是项目名），所以不需要
 * 人为前缀；而**结论的 id 已经被 `dismiss` / `withdraw` 用着**，加前缀会把那条链路打断。
 *
 * @param {Array<{id:string, kind:string, summary?:string, refs?:string[]}>} entries
 * @returns {Map<string, RefNode>}
 */
export function buildRefGraph(entries) {
  const graph = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry.id !== 'string' || !entry.id) continue;
    graph.set(entry.id, {
      id: entry.id,
      kind: String(entry.kind ?? 'unknown'),
      summary: String(entry.summary ?? ''),
      refs: Array.isArray(entry.refs) ? entry.refs.map((ref) => String(ref)).filter(Boolean) : [],
    });
  }
  return graph;
}

/**
 * 链式召回：从一个 id 出发，沿引用关系逐跳展开。
 *
 * **广度优先**——近的先展开。远的那些只会在下一跳里出现（它们是某一跳的 ref），
 * 这正是文章说的「每次召回的对象本身同样内联下一跳的 ID」。
 *
 * @param {string} startId
 * @param {Map<string, RefNode>|Array<any>} graphOrEntries
 * @param {{maxHops?:number}} [options]
 * @returns {{start:string, hops:Array<{id:string,kind:string,summary:string,depth:number}>,
 *            truncated:boolean, missing:string[]}}
 */
export function planRecall(startId, graphOrEntries, options = {}) {
  const id = String(startId ?? '').trim();
  const graph = graphOrEntries instanceof Map
    ? graphOrEntries
    : buildRefGraph(graphOrEntries);
  const maxHops = Number.isFinite(Number(options?.maxHops)) && Number(options.maxHops) > 0
    ? Number(options.maxHops)
    : DEFAULT_MAX_HOPS;

  const hops = [];
  const missing = [];
  const seen = new Set();
  let frontier = id ? [id] : [];
  let depth = 0;
  let truncated = false;

  while (frontier.length > 0) {
    // 跳数上限：展开到 maxHops 层为止。**还有没展开的**才算被截断——
    // 链条正好在上限处结束不算截断（那不是被砍，是刚好走完）。
    if (depth >= maxHops) { truncated = true; break; }
    const next = [];
    for (const current of frontier) {
      if (seen.has(current)) continue;
      seen.add(current);
      const node = graph.get(current);
      if (!node) { missing.push(current); continue; }
      hops.push({ id: node.id, kind: node.kind, summary: node.summary, depth });
      next.push(...node.refs);
    }
    // **走回走过的节点就收尾。** 引用图里是有环的（结论 → 项目 → 会话 → 项目 → …），
    // 不收尾的话链永远走不完，于是每条链都被判成「被截断」——那不是截断，那是绕圈。
    frontier = next.filter((id) => !seen.has(id));
    depth += 1;
  }

  return { start: id, hops, truncated, missing };
}
