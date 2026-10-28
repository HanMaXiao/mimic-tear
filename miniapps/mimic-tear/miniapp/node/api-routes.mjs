import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

import { withSecurityHeaders } from './security.mjs';

/**
 * 板面的路由表。
 *
 * 路由是**声明式**的：每一条只说清楚「什么方法、什么路径、怎么处理、会广播什么」，
 * 具体怎么做放在 handler 里。`server.mjs` 只负责装配——把依赖塞进来、把路由挂上去，
 * 自己不再写 `if (pathname === ...)` 的长链。
 *
 * 路径模板里 `:name` 是路径参数，其余按字面量匹配。参数吃到模板末尾为止，
 * 和原来 `pathname.slice(prefix.length)` 的切法完全一致——`/api/projects/1/2`
 * 切出来还是 `1/2`，还是那个 400。
 */

/** 静态资源的类型表。 */
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

/**
 * 处理一条路由时能拿到的东西。
 *
 * @typedef {object} RouteContext
 * @property {any} service 领域服务（看板数据、派工、对话）
 * @property {any} persistence 落盘层（大哥会话 id 等）
 * @property {any} logger 结构化日志
 * @property {string} clientDir 客户端目录
 * @property {URL} url 解析后的请求 URL（要用查询参数时取它）
 * @property {import('node:http').IncomingMessage} request
 * @property {import('node:http').ServerResponse} response
 * @property {Record<string, string>} params 路径参数
 * @property {(status:number, payload:unknown)=>void} sendJson 回一个 JSON
 * @property {(event:string, data:unknown)=>void} broadcast 往 SSE 通道广播
 * @property {(event:any)=>void} broadcastChatEvent 把一轮对话的流式事件转发给页面
 * @property {(request:import('node:http').IncomingMessage)=>Promise<any>} readBody 读 JSON 请求体
 * @property {Set<import('node:http').ServerResponse>} streams 当前的 SSE 连接
 * @property {(requestId:string, decision:'allowOnce'|'deny')=>boolean} resolvePermission 交还给页面的权限决定
 */

/**
 * 一条路由会广播什么。
 *
 * `when` 说清楚广播的时机：`inline` 是请求处理当中广播（响应已经发出去了），
 * `background` 是后台那一摊做完才广播。
 *
 * @typedef {object} BroadcastSpec
 * @property {string} event SSE 事件名
 * @property {'inline'|'background'} when
 */

/**
 * 一条路由。
 *
 * @typedef {object} Route
 * @property {'GET'|'POST'} method
 * @property {string} path 路径模板（`:name` 是路径参数）
 * @property {'api'|'static'} kind
 * @property {(ctx: RouteContext) => Promise<void>} handler
 * @property {BroadcastSpec[]} broadcast 这条路由会广播的事件
 */

/**
 * 静态客户端的两条路由。
 *
 * 首页和资源文件都在这里：客户端是单页应用，路由在 hash 上，服务端只需要把
 * 入口文件和 `/assets/*` 递出去。
 *
 * @type {Route[]}
 */
const STATIC_ROUTES = [
  {
    method: 'GET',
    path: '/',
    kind: 'static',
    broadcast: [],
    handler: serveIndex,
  },
  {
    method: 'GET',
    path: '/index.html',
    kind: 'static',
    broadcast: [],
    handler: serveIndex,
  },
  {
    method: 'GET',
    path: '/assets/:file',
    kind: 'static',
    broadcast: [],
    async handler(ctx) {
      await serveAsset(ctx.response, join(ctx.clientDir, 'assets'), ctx.params.file);
    },
  },
];

/**
 * API 路由表。
 *
 * 21 条，一条都不能少：其中 `GET /api/dispatch/:id`、`POST /api/duty/intent`、
 * `GET /api/watchdog/alerts` 客户端目前没调用，但它们是真实存在的契约。
 *
 * @type {Route[]}
 */
const API_ROUTES = [
  {
    method: 'GET',
    path: '/api/stream',
    kind: 'api',
    broadcast: [],
    async handler(ctx) {
      const { response, request, service, streams } = ctx;
      // SSE 的长连接靠「不设 Content-Length、也不主动关连接」撑着，
      // 安全响应头是加在头部的，不影响这一点。
      response.writeHead(200, withSecurityHeaders({
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      }));
      streams.add(response);
      response.write(': connected\n\n');

      const overview = await service.getOverview();
      response.write(`event: snapshot\ndata: ${JSON.stringify(overview)}\n\n`);

      request.on('close', () => streams.delete(response));
    },
  },
  {
    method: 'GET',
    path: '/api/overview',
    kind: 'api',
    broadcast: [],
    async handler(ctx) {
      ctx.sendJson(200, await ctx.service.getOverview());
    },
  },
  {
    method: 'GET',
    path: '/api/inbox',
    kind: 'api',
    broadcast: [],
    async handler(ctx) {
      ctx.sendJson(200, await ctx.service.getInbox());
    },
  },
  {
    method: 'GET',
    path: '/api/projects',
    kind: 'api',
    broadcast: [],
    async handler(ctx) {
      ctx.sendJson(200, await ctx.service.getProjects());
    },
  },
  {
    method: 'GET',
    path: '/api/skills',
    kind: 'api',
    broadcast: [],
    async handler(ctx) {
      ctx.sendJson(200, await ctx.service.getSkills());
    },
  },
  {
    // The reusable-skill registry: the skills the boss packages and dispatches from.
    // Separate from /api/skills, which is a scan of what is installed on the machine.
    method: 'GET',
    path: '/api/skill-library',
    kind: 'api',
    broadcast: [],
    async handler(ctx) {
      ctx.sendJson(200, await ctx.service.getSkillLibrary());
    },
  },
  {
    method: 'GET',
    path: '/api/projects/:id',
    kind: 'api',
    broadcast: [],
    async handler(ctx) {
      const id = Number(ctx.params.id);
      if (!Number.isFinite(id)) {
        ctx.sendJson(400, { error: 'invalid_project_id' });
        return;
      }
      const detail = await ctx.service.getProject(id);
      if (!detail) {
        ctx.sendJson(404, { error: 'not_found' });
        return;
      }
      ctx.sendJson(200, detail);
    },
  },
  {
    method: 'GET',
    path: '/api/dispatch/:id',
    kind: 'api',
    broadcast: [],
    async handler(ctx) {
      const record = await ctx.service.getDispatch(ctx.params.id);
      if (!record) {
        ctx.sendJson(404, { error: 'not_found' });
        return;
      }
      ctx.sendJson(200, record);
    },
  },
  {
    method: 'POST',
    path: '/api/dispatch',
    kind: 'api',
    broadcast: [{ event: 'dispatch', when: 'background' }],
    async handler(ctx) {
      const body = await ctx.readBody(ctx.request);
      const { record, duplicate } = await ctx.service.prepareDispatch(body);

      if (duplicate) {
        ctx.sendJson(200, {
          dispatchId: record.id,
          status: record.status,
          duplicate: true,
          delivered: record.status === 'done',
          text: record.text,
          error: record.error,
        });
        return;
      }

      ctx.sendJson(202, { dispatchId: record.id, status: 'queued', duplicate: false });

      // The agent turn runs in the background; the page watches it over SSE.
      void ctx.service.runDispatch(record).then((outcome) => {
        ctx.broadcast('dispatch', {
          dispatchId: outcome.dispatchId,
          status: outcome.status,
          delivered: outcome.delivered,
          text: outcome.text,
          error: outcome.error,
        });
      }).catch((error) => {
        ctx.broadcast('dispatch', {
          dispatchId: record.id,
          status: 'error',
          delivered: false,
          text: '',
          error: error?.message ?? String(error),
        });
      });
    },
  },
  {
    method: 'POST',
    path: '/api/inbox/ack',
    kind: 'api',
    broadcast: [],
    async handler(ctx) {
      const body = await ctx.readBody(ctx.request);
      ctx.sendJson(200, await ctx.service.ack(body?.id));
    },
  },
  {
    method: 'GET',
    path: '/api/patrol',
    kind: 'api',
    broadcast: [],
    async handler(ctx) {
      ctx.sendJson(200, {
        config: await ctx.service.getPatrolConfig(),
        findings: ctx.service.patrol ? await ctx.service.patrol.list() : [],
      });
    },
  },
  {
    method: 'POST',
    path: '/api/patrol/config',
    kind: 'api',
    broadcast: [],
    async handler(ctx) {
      const body = await ctx.readBody(ctx.request);
      const config = await ctx.service.setPatrolConfig({
        enabled: body?.enabled,
        intervalMinutes: body?.intervalMinutes,
      });
      ctx.sendJson(200, config);
    },
  },
  {
    method: 'POST',
    path: '/api/duty/intent',
    kind: 'api',
    broadcast: [{ event: 'update', when: 'inline' }],
    async handler(ctx) {
      // Tell the boss whether it is on duty or resting. The decision is recorded with
      // who asked and why, and the board is refreshed right away — the duty state is
      // not part of the runtime revision, so nothing else would move the page.
      const body = await ctx.readBody(ctx.request);
      const result = await ctx.service.setDutyIntent({
        mode: body?.mode,
        requestedBy: body?.requestedBy,
        note: body?.note,
      });
      ctx.sendJson(200, result);
      // The board refreshes from the SSE stream. That refresh is best effort: the intent
      // is already written, so a failure here must not turn a completed write into an
      // error the caller sees.
      try {
        ctx.broadcast('update', await ctx.service.getOverview());
      } catch (error) {
        ctx.logger.warn('mimic-tear.duty.refresh.failed', { message: error?.message });
      }
    },
  },
  {
    method: 'POST',
    path: '/api/patrol/run',
    kind: 'api',
    broadcast: [
      { event: 'patrol', when: 'background' },
      { event: 'update', when: 'background' },
    ],
    async handler(ctx) {
      // A patrol turn can take minutes, so it must not hold the HTTP request open.
      ctx.sendJson(202, { status: 'started' });
      void ctx.service.runPatrol()
        .then((outcome) => {
          ctx.broadcast('patrol', outcome);
          return ctx.service.getOverview();
        })
        .then((overview) => ctx.broadcast('update', overview))
        .catch((error) => {
          ctx.broadcast('patrol', { error: error?.message ?? String(error), findings: [] });
        });
    },
  },
  {
    method: 'GET',
    path: '/api/watchdog/alerts',
    kind: 'api',
    broadcast: [],
    async handler(ctx) {
      // The alert log. It is the watchdog's primary channel: every alert is written down
      // whether or not the notification landed, so the board can show what happened while
      // it was closed. Only a new field and a new read route — the client is untouched.
      const limit = Number(ctx.url.searchParams.get('limit')) || 20;
      ctx.sendJson(200, await ctx.service.getWatchdogAlerts({ limit }));
    },
  },
  {
    method: 'GET',
    path: '/api/chat/duty',
    kind: 'api',
    broadcast: [],
    async handler(ctx) {
      // The duty rounds, grouped. The Host chat side panel shows one session, so it
      // never shows the rounds — and the rounds are the user seeing the boss work.
      const rounds = await ctx.service.getDutyRounds();
      ctx.sendJson(200, { rounds });
    },
  },
  {
    method: 'GET',
    path: '/api/chat/history',
    kind: 'api',
    broadcast: [],
    async handler(ctx) {
      // The transcript lives in the runtime, not in the Mini App. Reading it back is what
      // lets the page show what was said in the Host chat side panel — and what makes the
      // conversation survive a reload.
      const messages = await ctx.service.getChatHistory();
      ctx.sendJson(200, { messages });
    },
  },
  {
    method: 'GET',
    path: '/api/chat/session',
    kind: 'api',
    broadcast: [],
    async handler(ctx) {
      // The Host side panel needs the boss's session id, and the page must be able to ask for
      // it before the first message is ever sent.
      const stored = ctx.persistence ? await ctx.persistence.getBossSession() : null;
      ctx.sendJson(200, { bossSessionId: stored?.sessionId ?? null, agent: stored?.agent ?? null });
    },
  },
  {
    method: 'POST',
    path: '/api/chat',
    kind: 'api',
    broadcast: [
      { event: 'chat.delta', when: 'background' },
      { event: 'chat.message', when: 'background' },
      { event: 'chat.tool', when: 'background' },
      { event: 'chat.question', when: 'background' },
      { event: 'chat.done', when: 'background' },
      { event: 'update', when: 'background' },
    ],
    async handler(ctx) {
      const body = await ctx.readBody(ctx.request);
      const text = String(body?.text ?? '').trim();
      if (!text) {
        ctx.sendJson(400, { error: 'empty_message' });
        return;
      }
      // The boss's session id goes out with the acknowledgement: the page needs it to offer
      // "open this conversation in the Host chat side panel" (the Host renders agent turns
      // far better than a Mini App can re-implement them).
      const stored = ctx.persistence ? await ctx.persistence.getBossSession() : null;
      // A conversation turn can take minutes, so it must not hold the HTTP request open.
      ctx.sendJson(202, { status: 'started', bossSessionId: stored?.sessionId ?? null });
      void ctx.service.chat(text, ctx.broadcastChatEvent)
        .then((outcome) => {
          ctx.broadcast('chat.done', {
            status: outcome.status,
            text: outcome.text ?? '',
            error: outcome.error ?? null,
            request: outcome.request ?? null,
          });
          return ctx.service.getOverview();
        })
        .then((overview) => ctx.broadcast('update', overview))
        .catch((error) => {
          ctx.broadcast('chat.done', { status: 'error', text: '', error: error?.message ?? String(error) });
        });
    },
  },
  {
    method: 'POST',
    path: '/api/chat/answer',
    kind: 'api',
    broadcast: [
      { event: 'chat.delta', when: 'background' },
      { event: 'chat.message', when: 'background' },
      { event: 'chat.tool', when: 'background' },
      { event: 'chat.question', when: 'background' },
      { event: 'chat.done', when: 'background' },
    ],
    async handler(ctx) {
      const body = await ctx.readBody(ctx.request);
      const requestId = String(body?.requestId ?? '');
      if (!requestId) {
        ctx.sendJson(400, { error: 'missing_request_id' });
        return;
      }
      ctx.sendJson(202, { status: 'started' });
      void ctx.service.answerChatQuestion(
        { requestId, answers: body?.answers ?? [] },
        ctx.broadcastChatEvent,
      )
        .then((outcome) => {
          ctx.broadcast('chat.done', {
            status: outcome.status,
            text: outcome.text ?? '',
            error: outcome.error ?? null,
            request: outcome.request ?? null,
          });
        })
        .catch((error) => {
          ctx.broadcast('chat.done', { status: 'error', text: '', error: error?.message ?? String(error) });
        });
    },
  },
  {
    method: 'POST',
    path: '/api/permissions/:requestId',
    kind: 'api',
    broadcast: [],
    async handler(ctx) {
      const body = await ctx.readBody(ctx.request);
      const decision = body?.decision === 'allowOnce' ? 'allowOnce' : 'deny';
      ctx.resolvePermission(ctx.params.requestId, decision);
      ctx.sendJson(200, { ok: true });
    },
  },
];

/** 全部路由：先静态、再 API。静态和 API 的路径前缀不重叠，顺序不影响结果。 */
export const ROUTES = [...STATIC_ROUTES, ...API_ROUTES];

/** 只看 API 路由（21 条）。 */
export { API_ROUTES };

/** API 路由的条数：21 条，少一条就是少了一个契约。 */
export const API_ROUTE_COUNT = API_ROUTES.length;

/**
 * 把路径模板编译成匹配器。
 *
 * `:name` 吃到模板末尾为止（和原来 `slice` 的切法一致），其余按字面量匹配。
 *
 * @param {string} pattern
 * @returns {RegExp}
 */
function compilePath(pattern) {
  const source = pattern
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) return '(.*)';
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return new RegExp(`^${source}$`);
}

/** 编译好的匹配器，按路由缓存。 */
const MATCHERS = new Map(ROUTES.map((route) => [route, compilePath(route.path)]));

/**
 * 找一条路由。
 *
 * @param {string} method
 * @param {string} pathname
 * @param {Route[]} [routes] 只在自定义表里找（测试用）
 * @returns {{ route: Route, params: Record<string, string> } | null}
 */
export function matchRoute(method, pathname, routes = ROUTES) {
  for (const route of routes) {
    if (route.method !== method) continue;
    const regexp = MATCHERS.get(route) ?? compilePath(route.path);
    const matched = regexp.exec(pathname);
    if (!matched) continue;

    // 路径参数按模板里的顺序取：模板只有一个 `:name` 时就是它。
    const params = {};
    const names = route.path.split('/').filter((segment) => segment.startsWith(':'));
    names.forEach((segment, index) => {
      params[segment.slice(1)] = matched[index + 1] ?? '';
    });
    return { route, params };
  }
  return null;
}

/**
 * 把入口文件递出去。
 *
 * @param {RouteContext} ctx
 */
async function serveIndex(ctx) {
  const html = await readFile(join(ctx.clientDir, 'index.html'));
  ctx.response.writeHead(200, withSecurityHeaders({
    'content-type': CONTENT_TYPES['.html'],
    'cache-control': 'no-store',
  }));
  ctx.response.end(html);
}

/**
 * Serve a static asset from the client directory, refusing anything outside it.
 *
 * @param {import('node:http').ServerResponse} response
 * @param {string} clientDir
 * @param {string} relativePath
 */
async function serveAsset(response, clientDir, relativePath) {
  const root = resolve(clientDir);
  const target = resolve(root, normalize(relativePath).replace(/^([/\\])+/, ''));
  if (target !== root && !target.startsWith(root + sep)) {
    response.writeHead(403, withSecurityHeaders({ 'content-type': 'application/json; charset=utf-8' }));
    response.end(JSON.stringify({ error: 'forbidden' }));
    return;
  }

  try {
    const stats = await stat(target);
    if (!stats.isFile()) throw new Error('not a file');
  } catch {
    response.writeHead(404, withSecurityHeaders({ 'content-type': 'application/json; charset=utf-8' }));
    response.end(JSON.stringify({ error: 'not_found' }));
    return;
  }

  response.writeHead(200, withSecurityHeaders({
    'content-type': CONTENT_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  }));
  createReadStream(target).pipe(response);
}
