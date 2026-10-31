/**
 * 侧栏折叠。
 *
 * 侧栏能收成一条仪表刻度带：只剩工位号和当前项。收起是**看**的问题，
 * 不是功能的问题——屏宽的时候收起来，把横向空间让给表格和对话。
 *
 * 两件不能弄错的事：
 *
 * 1. **折叠状态要记住。** 否则每次开板面都要重新收一遍，那不叫折叠，叫折磨。
 *    存在 `localStorage`，但它不一定存在（沙箱框、测试桩），所以每一次访问都要包着。
 * 2. **折叠不能吃掉信息。** 收起来的是眼睛，不是屏幕阅读器：文字在折叠态下
 *    仍然留在无障碍树里，导航项读出来还是「决策收件箱」，不是「03」。
 */

import { el } from '../shared/dom.js';

const RAIL_KEY = 'mimic-tear:rail-collapsed';

let storeCache;

/**
 * The store the collapsed state is remembered in.
 *
 * @returns {Storage|null}
 */
function railStore() {
  if (storeCache === undefined) {
    try {
      storeCache = globalThis.localStorage ?? null;
    } catch {
      storeCache = null;
    }
  }
  return storeCache;
}

/**
 * @param {boolean} collapsed
 */
function apply(shell, button, collapsed) {
  shell.dataset.rail = collapsed ? 'collapsed' : 'expanded';
  const label = collapsed ? '展开侧栏' : '收起侧栏';
  button.setAttribute('aria-expanded', String(!collapsed));
  button.setAttribute('aria-label', label);
  button.title = label;
}

/**
 * Bind the collapse switch.
 */
export function initRail() {
  const shell = el('app-shell');
  const button = el('rail-toggle');
  if (!shell || !button) return;

  let collapsed = false;
  try {
    collapsed = railStore()?.getItem(RAIL_KEY) === '1';
  } catch {
    collapsed = false;
  }
  apply(shell, button, collapsed);

  button.addEventListener('click', () => {
    collapsed = shell.dataset.rail !== 'collapsed';
    apply(shell, button, collapsed);
    try {
      railStore()?.setItem(RAIL_KEY, collapsed ? '1' : '0');
    } catch {
      // 记不住就记不住：这一轮还是能收能放。
    }
  });
}
