/**
 * 后端接口路径表。
 *
 * 客户端只认这一张表：视图模块与运行时模块都从这里取路径，不再各自拼字符串。
 */

export const API = {
  overview: '/api/overview',
  inbox: '/api/inbox',
  projects: '/api/projects',
  project: (id) => `/api/projects/${id}`,
  skills: '/api/skills',
  skillLibrary: '/api/skill-library',
  dispatch: '/api/dispatch',
  // The dispatch record read back by its id. This is how a dispatch that was still in
  // flight when the page was closed finds its result.
  dispatchStatus: (id) => `/api/dispatch/${id}`,
  ack: '/api/inbox/ack',
  permission: (requestId) => `/api/permissions/${requestId}`,
  patrol: '/api/patrol',
  patrolConfig: '/api/patrol/config',
  patrolRun: '/api/patrol/run',
  // The watchdog's alert log: every alert it ever raised, delivered or not.
  watchdogAlerts: '/api/watchdog/alerts',
  chat: '/api/chat',
  chatAnswer: '/api/chat/answer',
  chatSession: '/api/chat/session',
  chatDuty: '/api/chat/duty',
  chatHistory: '/api/chat/history',
  // The conversations that are waiting for an answer, read from the runtime. This is
  // the durable truth behind the "等回答" mark; the Host's event stream only covers
  // asks raised after the page subscribed.
  sessionPendingAsks: '/api/sessions/pending-asks',
  stream: '/api/stream',
};
