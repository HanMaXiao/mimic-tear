/**
 * DOM 小工具。
 *
 * 客户端的 DOM 操作只有这几种：取元素、切 class、冒一条提示。它们放在共享层，
 * 视图模块与运行时模块共用同一份实现。
 */

/**
 * 按 id 取元素。
 *
 * @param {string} id
 * @returns {any}
 */
export const el = (id) => document.getElementById(id);

/**
 * Add or remove one class.
 *
 * The class list is edited as a string rather than through `classList`, because the DOM
 * shim the client tests run against has a plain `className` and no `classList` — this
 * works the same in both.
 *
 * @param {any} node
 * @param {string} name
 * @param {boolean} on
 */
export function setClass(node, name, on) {
  const classes = new Set(String(node.className || '').split(/\s+/).filter(Boolean));
  if (on) classes.add(name);
  else classes.delete(name);
  node.className = [...classes].join(' ');
}

/**
 * Show a short-lived message in the corner of the page.
 *
 * @param {string} message
 * @param {'info'|'error'} [kind]
 */
export function toast(message, kind = 'info') {
  const host = el('toast-host');
  const node = document.createElement('div');
  node.className = kind === 'error' ? 'toast toast--error' : 'toast';
  node.textContent = message;
  host.appendChild(node);
  setTimeout(() => node.remove(), 4000);
}
