/**
 * 巡检。
 *
 * 「大哥在岗」开关与「立即巡检」按钮：大哥自己按节奏巡检，开关只管他要不要歇着。
 *
 * 按钮有两种状态：**巡检**（没有轮次在跑）与 **叫停**（有一轮正在跑）。轮次是后台的，
 * 所以「巡检」点下去立刻就回来了；要停下来得有一个专门的入口——不然「能异步起」就只剩
 * 「起完了没法收」这一半。
 */

import { el, toast } from '../shared/dom.js';
import { request } from '../shared/http.js';
import { API } from '../shared/api.js';
import { refresh } from './router.js';

/** 正在跑的那一轮的 id。null = 没有轮次在跑。 */
let runningRoundId = null;

/**
 * The button says what it will do next: 巡检 when nothing is running, 叫停 when a round
 * is in flight.
 *
 * @returns {void}
 */
function paintPatrolButton() {
  const button = el('patrol-run-button');
  if (!button) return;
  if (runningRoundId) {
    button.textContent = '叫停';
    button.disabled = false;
    button.setAttribute('aria-label', '叫停这一轮巡检');
  } else {
    button.textContent = '巡检';
    button.disabled = false;
    button.setAttribute('aria-label', '立即巡检一次');
  }
}

/**
 * Remember (or forget) the round that is running.
 *
 * @param {string|null} roundId
 * @returns {void}
 */
export function setRunningRound(roundId) {
  runningRoundId = roundId || null;
  paintPatrolButton();
}

/**
 * Read the patrol switch from the server.
 */
export async function loadPatrolConfig() {
  try {
    const payload = await request(API.patrol);
    el('patrol-enabled').checked = Boolean(payload.config?.enabled);
  } catch {
    // The patrol is optional; a board without it still works.
  }
}

/**
 * 页面重新打开时，把「有没有一轮在跑」读回来。
 *
 * 不读回来，按钮就回到「巡检」，而那一轮其实还在跑——**叫停的入口就没了**。
 */
export async function loadRunningRound() {
  try {
    const payload = await request(API.patrolRound);
    const running = (payload?.rounds ?? []).find((round) => round.status === 'running');
    setRunningRound(running?.id ?? null);
  } catch {
    // 读不到就当没有轮次在跑：按钮回到「巡检」，点了也只是多起一轮（会被槽位挡下）。
  }
}

/**
 * Save the patrol switch.
 */
export async function savePatrolConfig() {
  try {
    await request(API.patrolConfig, {
      method: 'POST',
      body: JSON.stringify({
        enabled: el('patrol-enabled').checked,
      }),
    });
    toast('巡检设置已保存');
  } catch (error) {
    toast(error.message, 'error');
  }
}

/**
 * Run one patrol round right now.
 *
 * 轮次是后台的：接口立刻就回来了，结论随 SSE 送到。
 */
export function runPatrolNow() {
  request(API.patrolRun, { method: 'POST' })
    .then((outcome) => {
      if (outcome.status === 'skipped') {
        toast('已经有一轮巡检在跑了');
        return;
      }
      setRunningRound(outcome.roundId ?? null);
      toast('巡检开始了');
    })
    .catch((error) => toast(error.message, 'error'));
}

/**
 * Stop the patrol round that is running.
 *
 * 被叫停的轮次不算结论——它没跑完，产出不可信。但它留痕：轮次状态是 `aborted`。
 */
export function stopPatrolRound() {
  const roundId = runningRoundId;
  if (!roundId) {
    paintPatrolButton();
    return;
  }
  request(API.patrolRoundStop(roundId), { method: 'POST' })
    .then(() => {
      toast('这一轮巡检被叫停了');
      setRunningRound(null);
    })
    .catch((error) => toast(error.message, 'error'));
}

/**
 * 按钮只有一个：跑着的时候它是「叫停」，闲的时候它是「巡检」。
 */
export function togglePatrolRound() {
  if (runningRoundId) stopPatrolRound();
  else runPatrolNow();
}
