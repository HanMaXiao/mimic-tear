/**
 * 文本、时长与状态文案。
 *
 * 运行时说的是原始状态（`active` / `blocked` / `paused`），看板说的是人话。两者的对照表
 * 与时间格式化都住在这里，各视图模块共用同一份说法。
 */

// `escapeHtml` 的定义留在入口文件 `app.js` 里：仓库里有两个测试直接按源码抠取它来跑
// （`tests/client-skill-library-render.test.mjs`）。这里转出去，视图模块照旧从共享层取。
import { escapeHtml } from '../app.js';

export { escapeHtml };

/**
 * How long ago a moment was, in words.
 *
 * @param {number} timestamp
 * @returns {string}
 */
export function relativeTime(timestamp) {
  if (!timestamp) return '—';
  const diff = Date.now() - timestamp;
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(timestamp).toLocaleDateString('zh-CN');
}

/**
 * Label for how old a plan state snapshot is.
 *
 * A Goal-mode plan log is only rewritten when the plan runs, so a plan can be months old.
 * Showing its age keeps a stale task state from being read as a live signal.
 *
 * @param {number} updatedAt
 * @returns {string}
 */
export function planAgeLabel(updatedAt) {
  if (!updatedAt) return '';
  const days = Math.floor((Date.now() - updatedAt) / 86_400_000);
  if (days <= 0) return '· 状态为今日';
  if (days === 1) return '· 状态为 1 天前';
  if (days < 30) return `· 状态为 ${days} 天前`;
  return `· 状态为 ${Math.floor(days / 30)} 个月前`;
}

/** Human-readable waiting time, so a three-week-old item does not read as "20140 分钟". */
export function waitingLabel(timestamp) {
  if (!timestamp) return '时间未知';
  const minutes = Math.round((Date.now() - timestamp) / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `等待 ${minutes} 分钟`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `等待 ${hours} 小时`;
  return `等待 ${Math.round(hours / 24)} 天`;
}

export const HEALTH_LABEL = {
  active: '推进中',
  idle: '空闲',
  blocked: '有阻塞',
  error: '异常',
};

export const STATE_LABEL = {
  producing: '进行中',
  ready: '待开始',
  blocked: '被阻塞',
  done: '已完成',
  failed: '失败',
  unknown: '未知',
};

export const SEVERITY_LABEL = { high: '高', medium: '中', low: '低' };

/** The runtime speaks in raw states; the board speaks in words. */
export const GOAL_STATUS_LABEL = { active: '进行中', paused: '已暂停', done: '已完成', failed: '失败', unknown: '未知' };

export const QUESTION_STATUS_LABEL = { pending: '待答', answered: '已答', dismissed: '已忽略', unknown: '未知' };

export const KIND_LABEL = {
  questionnaire: '待答问题',
  'goal-paused': 'Goal 暂停',
  'session-error': '会话异常',
  'plan-blocked': '计划阻塞',
  patrol: '大哥巡检',
};
