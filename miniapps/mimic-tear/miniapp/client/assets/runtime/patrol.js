/**
 * 巡检。
 *
 * 「大哥在岗」开关与「立即巡检」按钮：大哥自己按节奏巡检，开关只管他要不要歇着。
 */

import { el, toast } from '../shared/dom.js';
import { request } from '../shared/http.js';
import { API } from '../shared/api.js';
import { refresh } from './router.js';

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
 */
export function runPatrolNow() {
  const button = el('patrol-run-button');
  button.disabled = true;
  button.textContent = '巡检中…';
  request(API.patrolRun, { method: 'POST' })
    .then((outcome) => {
      toast(outcome.error ? `巡检失败：${outcome.error}` : '巡检完成');
      void refresh();
    })
    .catch((error) => toast(error.message, 'error'))
    .finally(() => {
      button.disabled = false;
      button.textContent = '巡检';
    });
}
