/**
 * 一轮巡检里的纯计算。
 *
 * 大哥跑完巡检会给一段文本回来，这段文本要变成两样东西：记进结论账的条目，以及要执行的
 * 派工提案。这两步里的「算」都在这儿；执行（投递、落盘）仍然在 ProjectService 里。
 */

/**
 * 把一份巡检报告变成要记进结论账的条目。
 *
 * 一条都没解析出来时，仍然落一条结论，把原文带上去——巡检不能因为格式没认出来就静默。
 *
 * @param {{ conclusion?:string, items?:any[] }} report
 * @param {any[]} cards 看板上的项目卡，用来把项目名换成项目 id
 * @param {string} fallbackBody 没解析出条目时那条结论的正文
 * @returns {any[]}
 */
export function buildPatrolFindings(report, cards, fallbackBody) {
  const findings = [];
  for (const item of report?.items ?? []) {
    const card = (cards ?? []).find((c) => c.name === item.projectName);
    findings.push({
      projectId: card?.id ?? null,
      projectName: item.projectName,
      severity: item.severity,
      title: item.summary.length > 60 ? `${item.summary.slice(0, 60)}…` : item.summary,
      body: item.summary,
    });
  }

  if (findings.length === 0) {
    findings.push({
      projectId: null,
      projectName: null,
      severity: 'medium',
      title: report?.conclusion || '大哥巡检结论',
      body: fallbackBody,
    });
  }

  return findings;
}

/**
 * 把报告里的派工提案解析成「投给哪个项目」的执行清单。
 *
 * 提案里的项目名对不上就当场标成失败，不去投递——大哥报错了名字，指令不能落到别的项目头上。
 *
 * @param {{ proposals?:any[] }} report
 * @param {any[]} cards 看板上的项目卡
 * @returns {Array<{ index:number, proposal:any, card:any|null, error:string|null }>}
 */
export function resolvePatrolProposals(report, cards) {
  return (report?.proposals ?? []).map((proposal, index) => {
    const card = (cards ?? []).find((c) => c.name === proposal.projectName);
    return {
      index,
      proposal,
      card: card ?? null,
      error: card ? null : `找不到项目 ${proposal.projectName}`,
    };
  });
}
