/**
 * 问卷卡（agent 向大老板确认的那张卡）的规则。
 *
 * 过期问卷的口径曾经散在三处，各说各的：卡片计数一处、收件箱一处、详情页一处。2026-10-22
 * 的事故就是这么来的——一张没人能再点的过期卡把项目钉死在 blocked。这三个地方现在都读
 * `isUnresolvedQuestion` 这一个判定。
 */

/**
 * 一张问卷是不是还在等人回答。
 *
 * 过期卡不是未解决的问题：它的窗口已经关了，谁也点不了，也永远不会有答案。把它算作待答会
 * 把项目永久钉在 `blocked`——2026-10-22 那天仿身泪滴显示 blocked，就是这么来的。
 *
 * @param {string} status
 * @returns {boolean}
 */
export function isUnresolvedQuestion(status) {
  return status !== 'answered' && status !== 'dismissed' && status !== 'expired';
}

/**
 * 一张卡在**宿主那边**开没开 —— 「宿主状态」这个词只有一个口径。
 *
 * 板面账记的是「大哥给没给建议」，运行时记的是「卡开没开」。这两件事一度被同一个词
 * （「已答」）装着：大哥记完建议，卡就从它的待答清单里消失了，而宿主那边它照样开着、
 * 那个会话照样卡着（2026-11-01 13:07 那一轮值班查出来的）。
 *
 * `known` 说的是第三种状态：**查无此卡**。运行时库里没有这张卡，不等于「已答」，
 * 也不等于「还开着」——给一张查无此卡的记一笔，等于造一笔谁也查不到底的假账。
 *
 * @param {{ status?: string }|null|undefined} card 运行时库里的那张卡
 * @returns {{ known: boolean, hostStatus: string, awaitingUser: boolean }}
 */
export function resolveCardState(card) {
  if (!card) {
    return { known: false, hostStatus: 'unknown', awaitingUser: false };
  }
  const hostStatus = String(card.status ?? '');
  return { known: true, hostStatus, awaitingUser: isUnresolvedQuestion(hostStatus) };
}

/**
 * 抽出问卷里可回答的形状：步骤 id、题目文本和选项。
 *
 * 选项带一个 `recommended` 标记，那正是大哥应该优先选的那个「推荐答案」。
 *
 * @param {string} requestJson
 * @returns {{ stepIds: string[], options: { id: string, label: string, recommended: boolean }[] }}
 */
export function questionnaireShape(requestJson) {
  const empty = { stepIds: [], options: [] };
  let parsed;
  try {
    parsed = JSON.parse(requestJson);
  } catch {
    return empty;
  }
  const steps = Array.isArray(parsed?.steps) ? parsed.steps : [];
  const stepIds = steps.map((step) => step?.id).filter((id) => typeof id === 'string');
  const options = steps
    .flatMap((step) => (Array.isArray(step?.options) ? step.options : []))
    .map((option) => ({
      id: option?.id ?? '',
      label: option?.label ?? '',
      recommended: option?.recommended === true,
    }))
    .filter((option) => option.id);
  return { stepIds, options };
}

/**
 * 抽出问卷里给人看的题目文本。
 *
 * 载荷形状在运行时版本之间变过，所以解析失败降级成一句可读的占位文案，而不是抛异常。
 *
 * @param {string} requestJson
 * @returns {string}
 */
export function questionnaireBody(requestJson) {
  const fallback = '无法解析该问卷内容';
  if (!requestJson) return fallback;

  let parsed;
  try {
    parsed = JSON.parse(requestJson);
  } catch {
    return fallback;
  }
  if (!parsed || typeof parsed !== 'object') return fallback;

  const steps = Array.isArray(parsed.steps) ? parsed.steps : null;
  if (!steps || steps.length === 0) {
    const title = typeof parsed.title === 'string' ? parsed.title : '';
    return title || fallback;
  }

  const questions = steps
    .map((step) => (step && typeof step.question === 'string' ? step.question : ''))
    .filter((text) => text.length > 0);
  if (questions.length === 0) return fallback;
  return questions.join(' / ');
}
