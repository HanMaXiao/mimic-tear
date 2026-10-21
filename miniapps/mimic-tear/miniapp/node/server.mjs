import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

import { boardPatrolAction, isPatrolDue, stampBoardPatrol } from './patrol-scheduler.mjs';
import { dutyAnnouncementNeeded } from './duty-announce.mjs';
import { chatHistoryChanged } from './chat-history.mjs';

/**
 * The Mini App's HTTP surface: a small REST API plus one SSE stream, and the static Client.
 *
 * The Node entry owns the assigned loopback port for as long as the board is available, so
 * `dispose()` has to close the listener, every SSE connection and the poll timer.
 */

const POLL_INTERVAL_MS = 3000;

/** How often the server checks whether the boss's patrol is due. */
const PATROL_CHECK_INTERVAL_MS = 30_000;

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
 * Build the request handler around a domain service.
 *
 * Kept separate from `start()` so the routes can be exercised without a Host context.
 *
 * @param {{ service: any, clientDir: string, logger?: any, persistence?: any }} deps
 */
export function createApp(deps) {
  const { clientDir } = deps;
  // Mutable so `start()` can wire the real service after the app is created: the boss needs
  // the app's permission channel, and the app needs the service.
  let service = deps.service ?? null;
  // The boss session id lives in the persistence layer; the chat routes need it so the page
  // can offer "open this conversation in the Host chat side panel".
  const persistence = deps.persistence ?? null;
  const logger = deps.logger ?? { info() {}, warn() {}, error() {}, debug() {} };

  /** @type {Set<import('node:http').ServerResponse>} */
  const streams = new Set();
  /** @type {Map<string, { resolve: (v:string)=>void }>} */
  const pendingPermissions = new Map();

  const sendJson = (response, status, payload) => {
    const body = JSON.stringify(payload);
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(body);
  };

  const broadcast = (event, data) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const stream of streams) {
      try {
        stream.write(payload);
      } catch {
        streams.delete(stream);
      }
    }
  };

  const readBody = (request) => new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > 256 * 1024) {
        rejectBody(new Error('请求体过大'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolveBody({});
        return;
      }
      try {
        resolveBody(JSON.parse(raw));
      } catch {
        rejectBody(new Error('请求体不是合法 JSON'));
      }
    });
    request.on('error', rejectBody);
  });

  const handler = async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://miniapp.local');
    const { pathname } = url;
    const method = request.method ?? 'GET';

    try {
      // ---- static client -------------------------------------------------
      if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        const html = await readFile(join(clientDir, 'index.html'));
        response.writeHead(200, { 'content-type': CONTENT_TYPES['.html'], 'cache-control': 'no-store' });
        response.end(html);
        return;
      }

      if (method === 'GET' && pathname.startsWith('/assets/')) {
        await serveAsset(response, join(clientDir, 'assets'), pathname.slice('/assets/'.length));
        return;
      }

      // ---- api ------------------------------------------------------------
      if (pathname === '/api/stream' && method === 'GET') {
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        });
        streams.add(response);
        response.write(': connected\n\n');

        const overview = await service.getOverview();
        response.write(`event: snapshot\ndata: ${JSON.stringify(overview)}\n\n`);

        request.on('close', () => streams.delete(response));
        return;
      }

      if (pathname === '/api/overview' && method === 'GET') {
        sendJson(response, 200, await service.getOverview());
        return;
      }

      if (pathname === '/api/inbox' && method === 'GET') {
        sendJson(response, 200, await service.getInbox());
        return;
      }

      if (pathname === '/api/projects' && method === 'GET') {
        sendJson(response, 200, await service.getProjects());
        return;
      }

      if (pathname === '/api/skills' && method === 'GET') {
        sendJson(response, 200, await service.getSkills());
        return;
      }

      if (pathname.startsWith('/api/projects/') && method === 'GET') {
        const id = Number(pathname.slice('/api/projects/'.length));
        if (!Number.isFinite(id)) {
          sendJson(response, 400, { error: 'invalid_project_id' });
          return;
        }
        const detail = await service.getProject(id);
        if (!detail) {
          sendJson(response, 404, { error: 'not_found' });
          return;
        }
        sendJson(response, 200, detail);
        return;
      }

      if (pathname.startsWith('/api/dispatch/') && method === 'GET') {
        const id = pathname.slice('/api/dispatch/'.length);
        const record = await service.getDispatch(id);
        if (!record) {
          sendJson(response, 404, { error: 'not_found' });
          return;
        }
        sendJson(response, 200, record);
        return;
      }

      if (pathname === '/api/dispatch' && method === 'POST') {
        const body = await readBody(request);
        const { record, duplicate } = await service.prepareDispatch(body);

        if (duplicate) {
          sendJson(response, 200, {
            dispatchId: record.id,
            status: record.status,
            duplicate: true,
            delivered: record.status === 'done',
            text: record.text,
            error: record.error,
          });
          return;
        }

        sendJson(response, 202, { dispatchId: record.id, status: 'queued', duplicate: false });

        // The agent turn runs in the background; the page watches it over SSE.
        void service.runDispatch(record).then((outcome) => {
          broadcast('dispatch', {
            dispatchId: outcome.dispatchId,
            status: outcome.status,
            delivered: outcome.delivered,
            text: outcome.text,
            error: outcome.error,
          });
        }).catch((error) => {
          broadcast('dispatch', {
            dispatchId: record.id,
            status: 'error',
            delivered: false,
            text: '',
            error: error?.message ?? String(error),
          });
        });
        return;
      }

      if (pathname === '/api/inbox/ack' && method === 'POST') {
        const body = await readBody(request);
        sendJson(response, 200, await service.ack(body?.id));
        return;
      }

      if (pathname === '/api/patrol' && method === 'GET') {
        sendJson(response, 200, {
          config: await service.getPatrolConfig(),
          findings: service.patrol ? await service.patrol.list() : [],
        });
        return;
      }

      if (pathname === '/api/patrol/config' && method === 'POST') {
        const body = await readBody(request);
        const config = await service.setPatrolConfig({
          enabled: body?.enabled,
          intervalMinutes: body?.intervalMinutes,
        });
        sendJson(response, 200, config);
        return;
      }

      if (pathname === '/api/patrol/run' && method === 'POST') {
        // A patrol turn can take minutes, so it must not hold the HTTP request open.
        sendJson(response, 202, { status: 'started' });
        void service.runPatrol()
          .then((outcome) => {
            broadcast('patrol', outcome);
            return service.getOverview();
          })
          .then((overview) => broadcast('update', overview))
          .catch((error) => {
            broadcast('patrol', { error: error?.message ?? String(error), findings: [] });
          });
        return;
      }

      if (pathname === '/api/chat/duty' && method === 'GET') {
        // The duty rounds, grouped. The Host chat side panel shows one session, so it
        // never shows the rounds — and the rounds are the user seeing the boss work.
        const rounds = await service.getDutyRounds();
        sendJson(response, 200, { rounds });
        return;
      }

      if (pathname === '/api/chat/history' && method === 'GET') {
        // The transcript lives in the runtime, not in the Mini App. Reading it back is what
        // lets the page show what was said in the Host chat side panel — and what makes the
        // conversation survive a reload.
        const messages = await service.getChatHistory();
        sendJson(response, 200, { messages });
        return;
      }

      if (pathname === '/api/chat/session' && method === 'GET') {
        // The Host side panel needs the boss's session id, and the page must be able to ask for
        // it before the first message is ever sent.
        const stored = persistence ? await persistence.getBossSession() : null;
        sendJson(response, 200, { bossSessionId: stored?.sessionId ?? null, agent: stored?.agent ?? null });
        return;
      }

      if (pathname === '/api/chat' && method === 'POST') {
        const body = await readBody(request);
        const text = String(body?.text ?? '').trim();
        if (!text) {
          sendJson(response, 400, { error: 'empty_message' });
          return;
        }
        // The boss's session id goes out with the acknowledgement: the page needs it to offer
        // "open this conversation in the Host chat side panel" (the Host renders agent turns
        // far better than a Mini App can re-implement them).
        const stored = persistence ? await persistence.getBossSession() : null;
        // A conversation turn can take minutes, so it must not hold the HTTP request open.
        sendJson(response, 202, { status: 'started', bossSessionId: stored?.sessionId ?? null });
        void service.chat(text, broadcastChatEvent)
          .then((outcome) => {
            broadcast('chat.done', {
              status: outcome.status,
              text: outcome.text ?? '',
              error: outcome.error ?? null,
              request: outcome.request ?? null,
            });
            return service.getOverview();
          })
          .then((overview) => broadcast('update', overview))
          .catch((error) => {
            broadcast('chat.done', { status: 'error', text: '', error: error?.message ?? String(error) });
          });
        return;
      }

      if (pathname === '/api/chat/answer' && method === 'POST') {
        const body = await readBody(request);
        const requestId = String(body?.requestId ?? '');
        if (!requestId) {
          sendJson(response, 400, { error: 'missing_request_id' });
          return;
        }
        sendJson(response, 202, { status: 'started' });
        void service.answerChatQuestion(
          { requestId, answers: body?.answers ?? [] },
          broadcastChatEvent,
        )
          .then((outcome) => {
            broadcast('chat.done', {
              status: outcome.status,
              text: outcome.text ?? '',
              error: outcome.error ?? null,
              request: outcome.request ?? null,
            });
          })
          .catch((error) => {
            broadcast('chat.done', { status: 'error', text: '', error: error?.message ?? String(error) });
          });
        return;
      }

      if (pathname.startsWith('/api/permissions/') && method === 'POST') {
        const requestId = pathname.slice('/api/permissions/'.length);
        const body = await readBody(request);
        const decision = body?.decision === 'allowOnce' ? 'allowOnce' : 'deny';
        const pending = pendingPermissions.get(requestId);
        if (pending) {
          pending.resolve(decision);
          pendingPermissions.delete(requestId);
        }
        sendJson(response, 200, { ok: true });
        return;
      }

      sendJson(response, 404, { error: 'not_found' });
    } catch (error) {
      const status = Number(error?.status) || 500;
      const code = error?.code || 'internal_error';
      if (status >= 500) logger.error('mimic-tear.request.failed', { path: pathname, message: error?.message });
      sendJson(response, status, { error: code, message: error?.message ?? '请求处理失败' });
    }
  };

  /**
   * Forward one event of the boss's conversation turn to the page.
   *
   * The runtime streams the turn as it happens: `text.delta` is the reply arriving piece by
   * piece, the tool events are what the boss is doing right now, and a questionnaire pauses
   * the turn until the user answers it.
   *
   * @param {any} event
   */
  const broadcastChatEvent = (event) => {
    switch (event?.type) {
      case 'text.delta':
        broadcast('chat.delta', { text: event.text ?? '' });
        break;
      case 'message.committed':
        broadcast('chat.message', { text: event.text ?? '' });
        break;
      case 'tool.started':
        broadcast('chat.tool', { name: event.name ?? '', phase: 'started' });
        break;
      case 'tool.finished':
        broadcast('chat.tool', { name: event.name ?? '', phase: 'finished', ok: event.ok !== false });
        break;
      case 'question.requested':
        broadcast('chat.question', {
          requestId: event.requestId ?? '',
          mode: event.mode ?? 'questionnaire',
          request: event.request ?? null,
        });
        break;
      default:
        // `run.queued`, `turn.started`, `turn.finished` and unknown future types are ignored.
        break;
    }
  };

  /**
   * Ask the page to decide a tool permission request raised by the boss.
   * @param {any} event
   * @returns {Promise<'allowOnce'|'deny'>}
   */
  const requestPermission = (event) => new Promise((resolvePermission) => {
    const requestId = event?.requestId ?? `perm_${Date.now()}`;

    // Nobody answers: deny, so a waiting run is never left hanging. The timer is unref'd
    // and cleared on resolve so it can never hold the process open.
    const timer = setTimeout(() => {
      pendingPermissions.delete(requestId);
      resolvePermission('deny');
    }, 120_000);
    timer.unref?.();

    pendingPermissions.set(requestId, {
      resolve: (decision) => {
        clearTimeout(timer);
        resolvePermission(decision);
      },
    });

    broadcast('permission', {
      requestId,
      sessionId: event?.sessionId ?? null,
      toolName: event?.toolName ?? '未知工具',
      reason: event?.reason ?? '',
    });
  });

  return {
    handler,
    broadcast,
    requestPermission,
    streams,
    setService(next) {
      service = next;
    },
  };
}

/**
 * Serve a static asset from the client directory, refusing anything outside it.
 */
async function serveAsset(response, clientDir, relativePath) {
  const root = resolve(clientDir);
  const target = resolve(root, normalize(relativePath).replace(/^([/\\])+/, ''));
  if (target !== root && !target.startsWith(root + sep)) {
    response.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: 'forbidden' }));
    return;
  }

  try {
    const stats = await stat(target);
    if (!stats.isFile()) throw new Error('not a file');
  } catch {
    response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: 'not_found' }));
    return;
  }

  response.writeHead(200, {
    'content-type': CONTENT_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  createReadStream(target).pipe(response);
}

/**
 * Mini App entry point.
 * @param {any} context
 */
export async function start(context) {
  const { readPlan } = await import('./plan-store.mjs');
  const { scanSkills } = await import('./skill-catalog.mjs');
  const { RuntimeStore } = await import('./runtime-store.mjs');
  const { Persistence } = await import('./persistence.mjs');
  const { ProjectService } = await import('./project-service.mjs');
  const { BossBridge } = await import('./boss-bridge.mjs');
  const { PatrolStore } = await import('./patrol-store.mjs');

  const { homedir } = await import('node:os');

  const dbPath = process.env.MIMIC_RUNTIME_DB
    ?? join(homedir(), '.minimax', 'v2', 'sqlite', 'runtime-state.sqlite');
  const store = RuntimeStore.open(dbPath);

  const skillRoots = [
    { label: '用户技能', source: 'user', dir: join(homedir(), '.agents', 'skills') },
    { label: 'MiniMax 技能', source: 'user', dir: join(homedir(), '.minimax', 'skills') },
    { label: '内置技能', source: 'builtin', dir: join(homedir(), '.minimax', '.builtin-skills') },
  ];
  const skillScan = await scanSkills(skillRoots);
  const refreshSkills = () => scanSkills(skillRoots);

  const domainsModule = await import('./domains.json', { with: { type: 'json' } });
  const domains = domainsModule.default?.domains ?? domainsModule.domains ?? [];

  const persistence = new Persistence(context.dataDir);
  const patrol = new PatrolStore(context.dataDir);

  const app = createApp({
    service: null,
    clientDir: join(context.pluginRoot, 'miniapp', 'client'),
    logger: context.logger,
    persistence,
  });

  const boss = new BossBridge({
    agent: context.agent ?? null,
    persistence,
    bossAgentName: process.env.MIMIC_BOSS_AGENT ?? 'boss',
    onPermission: app.requestPermission,
  });

  const service = new ProjectService({
    store,
    readPlan,
    skills: skillScan,
    domains,
    persistence,
    boss,
    patrol,
    refreshSkills,
  });

  // The app needs the service, and the boss needs the app's permission channel.
  app.setService(service);

  const server = createServer((request, response) => {
    void app.handler(request, response);
  });

  // Track sockets: `server.close()` only stops accepting new connections and waits for the
  // open ones, and an SSE stream would hold the port open forever.
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await listen(server, context.listen.host, context.listen.port);
  context.logger.info('mimic-tear.runtime.listening', { port: context.listen.port });

  // Poll the runtime revision and push a new snapshot when anything changed.
  //
  // The conversation is watched separately: a message said in the Host chat side panel does
  // not move the runtime revision (no session, goal or task changed), so the revision alone
  // would never notice it. The message count is the cheap detector for "something was said".
  let lastRevision = service.currentRevision();
  let lastChatMessageCount = 0;
  const timer = setInterval(() => {
    void (async () => {
      try {
        const revision = service.currentRevision();
        if (revision === lastRevision) {
          // The revision is quiet, but the conversation may not be.
          const chatCount = await service.getChatMessageCount();
          if (chatHistoryChanged(chatCount, lastChatMessageCount).changed) {
            lastChatMessageCount = chatCount;
            app.broadcast('chat.history', { messages: await service.getChatHistory() });
          }
          return;
        }
        lastRevision = revision;
        const overview = await service.getOverview();
        app.broadcast('update', overview);
      } catch (error) {
        context.logger.warn('mimic-tear.poll.failed', { message: error?.message });
      }
    })();
  }, POLL_INTERVAL_MS);
  timer.unref?.();

  // The boss's proactive patrol. It only runs when the board is open, and only when the
  // decision-relevant state actually changed since the last run — a patrol that has nothing
  // new to look at must not spend a turn or a notification.
  //
  // The same tick also watches the duty handover stamp. The duty boss runs in its own
  // process, so a duty round is invisible to the runtime revision this loop watches; without
  // this the conversation would only show the rounds that happened before it was opened.
  let lastDutyRunAt = null;
  const patrolTimer = setInterval(() => {
    void (async () => {
      try {
        const config = await service.getPatrolConfig();
        if (dutyAnnouncementNeeded(config, lastDutyRunAt).changed) {
          lastDutyRunAt = config.lastRunAt;
          broadcast('duty', { rounds: await service.getDutyRounds() });
        }
        // Cheap early-outs before the (expensive) snapshot.
        if (!config.enabled) return;
        if (!isPatrolDue(config)) return;

        const snapshot = await service.snapshot();
        const signatureMatches = Boolean(config.lastSignature)
          && service.inboxSignature(snapshot) === config.lastSignature;
        const action = boardPatrolAction(config, signatureMatches);
        if (action === 'skip') return;
        if (action === 'stamp') {
          // Nothing changed: just move the clock so the next check is not immediately due.
          await stampBoardPatrol(patrol);
          return;
        }

        const outcome = await service.runPatrol();
        broadcast('patrol', outcome);
        const overview = await service.getOverview();
        app.broadcast('update', overview);
      } catch (error) {
        context.logger.warn('mimic-tear.patrol.failed', { message: error?.message });
      }
    })();
  }, PATROL_CHECK_INTERVAL_MS);
  patrolTimer.unref?.();

  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    context.signal.removeEventListener('abort', onAbort);
    clearInterval(timer);
    clearInterval(patrolTimer);
    for (const stream of app.streams) {
      try {
        stream.end();
      } catch {
        /* already closed */
      }
    }
    app.streams.clear();
    for (const socket of sockets) {
      try {
        socket.destroy();
      } catch {
        /* already closed */
      }
    }
    sockets.clear();
    store.close();
    await close(server);
  };

  const onAbort = () => {
    void dispose().catch(() => undefined);
  };
  context.signal.addEventListener('abort', onAbort, { once: true });
  if (context.signal.aborted) await dispose();

  return { dispose };
}

function listen(server, host, port) {
  return new Promise((resolvePromise, rejectPromise) => {
    const onError = (error) => rejectPromise(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolvePromise();
    });
  });
}

function close(server) {
  return new Promise((resolvePromise, rejectPromise) => {
    server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
  });
}
