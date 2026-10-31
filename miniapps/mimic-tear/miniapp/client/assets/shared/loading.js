/**
 * 加载态。
 *
 * 圆圈只说明「有东西在转」，不说明「在等什么」。骨架屏把形状摆出来——
 * 几行、每行多高，页面在数据到达前就已经是最终布局的高度，数字填进去时页面不跳。
 */

/**
 * @param {string} text 说清楚在等什么
 * @param {number} [rows] 骨架的行数
 * @returns {string}
 */
export function loadingState(text, rows = 3) {
  const bars = Array.from({ length: rows }, () => '<div class="skeleton skeleton--row"></div>').join('');
  return `<div class="state state--loading">
      <p class="state__label">${text}</p>
      ${bars}
    </div>`;
}
