/**
 * 桌面窗口。
 *
 * 宿主允许把这个 Mini App 从侧栏「弹」成自己的窗口。这个窗口的行为由清单里的
 * `surface.window` 决定——宽度、是否置顶、是否进任务栏都在那儿声明，这里只负责切换。
 *
 * 两个必须记住的坑：
 *
 * 1. 切换模式必须在用户手势里同步发出。`update({mode})` 会先检查
 *    `navigator.userActivation.isActive`，异步之后再调就被拒（`not_permitted`）。
 * 2. 清单里声明了 `frame: false`，窗口就没有系统标题栏，也就没有系统自带的拖动区。
 *    拖动条得由页面自己画（CSS 的 `-webkit-app-region: drag`），否则窗口挪不动。
 */

import { toast } from '../shared/dom.js';

/** 桌面窗口的默认尺寸。 */
const DESK_SIZE = Object.freeze({ width: 420, height: 640 });

/**
 * 宿主给的窗口句柄。
 *
 * @returns {any}
 */
function hostWindow() {
  return globalThis.window?.mcode?.miniapp?.window ?? null;
}

/**
 * 现在是内嵌还是独立窗口。
 *
 * @returns {Promise<'inline'|'window'|null>}
 */
export async function deskMode() {
  const handle = hostWindow();
  if (!handle || typeof handle.getState !== 'function') return null;
  try {
    const current = await handle.getState();
    return current?.mode ?? null;
  } catch {
    return null;
  }
}

/**
 * 弹成桌面窗口。
 *
 * 必须在用户手势里同步调用，所以这个函数不做任何 await 之前的事。
 */
export function popOutToDesk() {
  const handle = hostWindow();
  if (!handle || typeof handle.update !== 'function') {
    toast('这个宿主版本不支持独立窗口', 'error');
    return;
  }
  const request = handle.update({ mode: 'window', ...DESK_SIZE });
  Promise.resolve(request).then(
    () => toast('已弹到桌面'),
    (error) => toast(`弹到桌面失败：${error?.message ?? error}`, 'error'),
  );
}

/**
 * 收回侧栏。
 */
export function returnToPanel() {
  const handle = hostWindow();
  if (!handle || typeof handle.update !== 'function') {
    toast('这个宿主版本不支持独立窗口', 'error');
    return;
  }
  const request = handle.update({ mode: 'inline' });
  Promise.resolve(request).then(
    () => toast('已收回侧栏'),
    (error) => toast(`收回侧栏失败：${error?.message ?? error}`, 'error'),
  );
}

/**
 * 把窗口状态标到页面上：独立窗口时页面用紧凑布局，并且要有一个拖动条。
 *
 * @param {string} mode
 */
export function applyDeskMode(mode) {
  const root = globalThis.document?.documentElement;
  if (root) root.dataset.deskMode = mode === 'window' ? 'window' : 'inline';
  const toggle = globalThis.document?.getElementById('desk-toggle');
  if (toggle) {
    toggle.textContent = mode === 'window' ? '收回侧栏' : '放到桌面';
  }
}

/**
 * 监听窗口模式的变化：用户在宿主里关掉窗口，页面也要跟着变回去。
 */
export function initDeskWindow() {
  const handle = hostWindow();
  if (!handle || typeof handle.onDidChangeState !== 'function') return;

  void deskMode().then((mode) => applyDeskMode(mode));

  const subscription = handle.onDidChangeState((next) => {
    applyDeskMode(next?.mode ?? 'inline');
  });
  globalThis.addEventListener?.('pagehide', () => {
    try {
      subscription?.dispose?.();
    } catch {
      // 页面正在关掉，订阅释放失败不影响任何事。
    }
  });
}
