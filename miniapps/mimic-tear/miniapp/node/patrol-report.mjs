/**
 * 巡检简报与巡检报告的解析。
 *
 * 大哥巡检跑完会给一段文本回来：结论、条目、派工、待派工。这块解析是**约定**而不是契约，
 * 所以刻意写得宽容——解析不出来的那一段也会变成一条结论，而不是让整轮巡检静默。
 */

/**
 * @typedef {{ conclusion: string, items: { projectName: string, severity: 'high'|'medium'|'low', summary: string }[],
 *             dispatches: { projectName: string, instruction: string }[],
 *             proposals: { projectName: string, sessionId: string|null, instruction: string }[] }} PatrolReport
 */

/**
 * 大哥主动巡检时用来推理的事实清单。
 *
 * 事实归看板，判断归大哥。这个分工保持诚实——Mini App 绝不决定什么重要，它只报告什么是
 * 真的。
 *
 * @param {any} snapshot
 * @returns {string}
 */
export function buildPatrolBrief(snapshot) {
  const cards = snapshot?.cards ?? [];
  const inbox = snapshot?.inbox ?? [];
  const lines = [];

  lines.push('## 项目总览');
  if (cards.length === 0) lines.push('（没有可见项目）');
  for (const card of cards) {
    const active = card.goals.filter((g) => g.status === 'active').length;
    lines.push(
      `- ${card.name} | 状态 ${card.health} | 会话 ${card.sessionCount} | Goal ${active}/${card.goals.length}`
      + ` | 待决策 ${card.pendingQuestions} | 计划任务 ${card.planTasks.length}`,
    );
  }

  lines.push('');
  lines.push('## 待决策项');
  if (inbox.length === 0) lines.push('（没有待决策项）');
  for (const item of inbox) {
    lines.push(`- [${item.severity}] ${item.kind} | ${item.projectName} | ${item.title} | ${item.body}`);
  }

  const planLines = [];
  for (const card of cards) {
    for (const task of card.planTasks) {
      planLines.push(`- ${card.name} | ${task.state} | ${task.title} | 负责 ${task.assignedTo ?? '未指派'}`);
    }
  }
  if (planLines.length > 0) {
    lines.push('');
    lines.push('## 计划任务');
    lines.push(...planLines);
  }

  return lines.join('\n');
}

/**
 * 解析大哥的巡检报告。
 *
 * 格式是约定不是契约，所以解析刻意宽容：认不出来的回复也会变成一条带着原文的结论。
 *
 * @param {string} text
 * @returns {PatrolReport}
 */
export function parsePatrolReport(text) {
  const result = { conclusion: '', items: [], dispatches: [], proposals: [] };
  if (!text) return result;

  let section = 'report';
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    const conclusion = /^巡检结论\s*[:：]\s*(.+)$/.exec(line);
    if (conclusion) {
      result.conclusion = conclusion[1].trim();
      continue;
    }
    if (/^(我已派工|已派工|已投递)\s*[:：]?$/.test(line)) {
      section = 'dispatch';
      continue;
    }
    if (/^(我建议派工|建议派工|待派工)\s*[:：]?$/.test(line)) {
      section = 'proposal';
      continue;
    }
    if (/^(需要大老板决策|待大老板决策|需你决策)\s*[:：]?$/.test(line)) {
      section = 'report';
      continue;
    }

    const item = /^-\s*项目\s*[:：]\s*(.+?)\s*\|\s*级别\s*[:：]\s*(high|medium|low)\s*\|\s*摘要\s*[:：]\s*(.+)$/.exec(line);
    if (item) {
      result.items.push({
        projectName: item[1].trim(),
        severity: /** @type {'high'|'medium'|'low'} */ (item[2]),
        summary: item[3].trim(),
      });
      continue;
    }

    const proposal = /^-\s*项目\s*[:：]\s*(.+?)\s*\|\s*会话\s*[:：]\s*(.+?)\s*\|\s*指令\s*[:：]\s*(.+)$/.exec(line);
    if (proposal) {
      const session = proposal[2].trim();
      result.proposals.push({
        projectName: proposal[1].trim(),
        sessionId: session && session !== '无' && session !== '-' ? session : null,
        instruction: proposal[3].trim(),
      });
      continue;
    }

    if (section === 'dispatch') {
      const dispatch = /^-\s*(.+?)\s*[:：]\s*(.+)$/.exec(line);
      if (dispatch) {
        result.dispatches.push({ projectName: dispatch[1].trim(), instruction: dispatch[2].trim() });
      }
    }
  }

  return result;
}
