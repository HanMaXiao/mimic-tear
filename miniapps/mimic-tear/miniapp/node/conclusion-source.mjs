/**
 * 结论来源的唯一归一口径。
 *
 * 一条结论只有两种出处：大哥的 cron 值班交班（`duty`），或看板自己的巡检循环（`board`）。
 * 过去这两种分不开：客户端一律标成「大哥巡检」，值班行的「N 条结论待你过目」把两种一起数，
 * 于是看板自己巡检出来的数字，看起来像是大哥那边攒了更多话要说。
 *
 * 字段出现之前写的结论根本没有来源。它**不会被丢掉**，而是默认归到 `board`——那是没有值班
 * 交班在背后时产出结论的那一侧。
 *
 * 派工记录用的是同一套来源标记（看板派工 `board`、值班投递 `duty`），所以这条规则住在
 * 自己的模块里：收件箱、值班状态、派工账三处都从这儿取，不再各写各的。
 */

/**
 * @typedef {'duty'|'board'} ConclusionSource
 */

/**
 * 把结论（或派工）的来源归一。
 *
 * @param {any} value
 * @param {ConclusionSource} [fallback] 未知或缺失的来源在这里算什么
 * @returns {ConclusionSource}
 */
export function normalizeConclusionSource(value, fallback = 'board') {
  if (value === 'duty' || value === 'board') return value;
  return fallback;
}
