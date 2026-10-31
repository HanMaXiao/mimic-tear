/**
 * 重绘签名守卫。
 *
 * 运行时会推来更新，只要任何会话有动静就来一次。朴素的重绘会把整张表换掉，
 * 每几秒一次——元素在光标底下被换掉，点击落空。所以只在可见内容真的变了时才重绘。
 */

let overviewSignature = '';
let inboxSignature = '';

/**
 * Has the overview actually changed?
 *
 * @param {any} overview
 * @returns {boolean}
 */
export function overviewChanged(overview) {
  const signature = JSON.stringify([
    overview?.kpi,
    overview?.projects,
    overview?.attention,
    // 线视图也是总览的一部分：它不在签名里的话，线一变就不会重绘。
    overview?.lines,
    overview?.internalProjectCount,
  ]);
  if (signature === overviewSignature) return false;
  overviewSignature = signature;
  return true;
}

/**
 * Has the inbox actually changed?
 *
 * @param {Array<any>} items
 * @returns {boolean}
 */
export function inboxChanged(items) {
  const signature = JSON.stringify(items);
  if (signature === inboxSignature) return false;
  inboxSignature = signature;
  return true;
}
