/**
 * 结论的纪律：带宽上限、同类合并、桌面名额。
 *
 * 这三条以前散在三个地方（CLI 的写盘、收件箱的严重度口径、事实表的裁剪），于是每加一条
 * 结论都要在三个地方各判一次。现在只有这一份实现，谁要用都从这里取。
 *
 * 纯函数：不碰 IO、不读时钟、不改入参。
 */

/** 桌面上「需要你拍板」的结论条数上界。 */
export const DEFAULT_DESK_LIMIT = 20;

/** 单条结论的带宽上限（词）。 */
export const CONCLUSION_WORD_LIMIT = 100;

/**
 * 一条东西是否「需要你拍板」。
 *
 * 口径：不是 low，而且还没被确认。与收件箱的 `selectAttentionItems` 同一份判定——
 * 两处口径一旦分叉，徽标上的数字就会和列表里的条数对不上。
 *
 * @param {{ severity?:string, acknowledged?:boolean }} item
 * @returns {boolean}
 */
export function isAttentionItem(item) {
  return item?.severity !== 'low' && !item?.acknowledged;
}

/**
 * 汉字（含扩展区与兼容区）。
 *
 * 中文按字计数，所以一个汉字就是一「词」。标点不是字，不计。
 */
const CJK_CHAR = /[㐀-䶿一-鿿豈-﫿]/g;

/**
 * 数一个字符串有多少「词」。
 *
 * 中文按字，英文按空白分词，两者相加。纯标点的片段不算词。
 *
 * @param {string} text
 * @returns {number}
 */
export function countWords(text) {
  const value = String(text ?? '');
  if (!value) return 0;
  const chinese = value.match(CJK_CHAR)?.length ?? 0;
  const rest = value
    .replace(CJK_CHAR, ' ')
    .split(/\s+/)
    .filter((token) => /[\p{L}\p{N}]/u.test(token));
  return chinese + rest.length;
}

/**
 * 一条结论占多少词。
 *
 * 只量**正文**：标题是摘要标签（两条写路径各自截断，CLI 截到 120 字、巡检截到 60 字），
 * 把它算进预算，等于让一条 60 字的摘要把额度吃掉两遍。
 *
 * @param {{ body?:string }} finding
 * @returns {number}
 */
export function conclusionWords(finding) {
  return countWords(finding?.body);
}

/**
 * 带宽守卫：一条结论超过上限就拒绝入账。
 *
 * 抛错而不是截断——截断会把大哥的话改掉，而大哥需要知道自己写超了。
 *
 * @param {{ body?:string }} finding
 * @param {number} [limit]
 * @returns {number} 实际词数
 */
export function assertConclusionBandwidth(finding, limit = CONCLUSION_WORD_LIMIT) {
  const words = conclusionWords(finding);
  if (words <= limit) return words;
  throw new Error(`结论太长：${words} 词，超出上限 ${limit} 词（超了 ${words - limit} 词）`);
}

/**
 * 同类合并的键。
 *
 * 同一个项目、同一个严重度 = 同一类问题。大哥重复报同一件事时，不该在收件箱里占两条。
 *
 * 两边都要归一：`null` 与 `undefined` 都表示「没有项目」，如果一个记成 `null`、另一个记成
 * `undefined`，同一个问题就会算出两个键，合并就漏了。
 *
 * @param {{ projectName?:string|null, projectId?:number|null, severity?:string }} finding
 * @returns {string}
 */
export function mergeKey(finding) {
  const project = finding?.projectName ?? finding?.projectId ?? '';
  return `${project}:${finding?.severity ?? ''}`;
}

/**
 * 把新结论并进已有那条。
 *
 * 身份（id / createdAt / 来源）留着——它是「这条结论什么时候、由谁冒出来的」；
 * 内容（标题 / 正文 / 备注 / 更新时刻）换成新的。
 *
 * 备注只在新的那条**真的写了备注**时才换：空备注是「这次没说」，不是「把之前的备注抹掉」。
 *
 * @param {any} existing 已有那条结论
 * @param {any} incoming 新报上来的那条
 * @param {number} [now]
 * @returns {any}
 */
export function mergeConclusion(existing, incoming, now = Date.now()) {
  const note = typeof incoming?.note === 'string' && incoming.note
    ? incoming.note
    : existing?.note;
  return {
    ...existing,
    title: incoming?.title ?? existing.title,
    body: incoming?.body ?? existing.body,
    note,
    updatedAt: now,
  };
}

/**
 * 从配置里读出桌面名额。
 *
 * @param {any} config
 * @returns {number}
 */
export function deskLimitFrom(config) {
  const raw = Number(config?.deskLimit);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_DESK_LIMIT;
  return Math.min(500, Math.floor(raw));
}

/**
 * 给账上的结论分桌面位。
 *
 * 名额**先来先服务**：排队顺序就是到达顺序（先来的先占位），后来的排到流水里。
 * 所以超上界时新结论不会占桌面——它只是被记下来、标成「不在桌面」，等前面的处理完再上位。
 * 不需要你拍板的（low / 已确认）不占名额，但仍然在桌面上显示。
 *
 * @param {any[]} findings 账上的结论，新的在前
 * @param {number} [limit]
 * @returns {any[]} 带 `onDesk` 标记的结论
 */
export function assignDesk(findings, limit = DEFAULT_DESK_LIMIT) {
  const list = Array.isArray(findings) ? findings : [];
  const bound = Math.min(500, Math.max(1, Math.floor(Number(limit) || DEFAULT_DESK_LIMIT)));

  // 到达顺序：账上是新的在前，所以下标大的到得更早。同一毫秒写入的按这条排。
  const queue = list
    .map((finding, index) => ({ finding, index }))
    .filter(({ finding }) => isAttentionItem(finding))
    .sort((a, b) => (a.finding.createdAt ?? 0) - (b.finding.createdAt ?? 0) || b.index - a.index);

  const admitted = new Set(queue.slice(0, bound).map(({ finding }) => finding.id));

  return list.map((finding) => ({
    ...finding,
    onDesk: !isAttentionItem(finding) || admitted.has(finding.id),
  }));
}
