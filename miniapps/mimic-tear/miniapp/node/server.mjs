import { createServer } from 'node:http';
import { join } from 'node:path';

import { boardPatrolAction, isPatrolDue, stampBoardPatrol } from './patrol-scheduler.mjs';
import { dutyAnnouncementNeeded } from './duty-announce.mjs';
import { chatHistoryChanged } from './chat-history.mjs';
import { ROUTES, matchRoute } from './api-routes.mjs';
import { withSecurityHeaders } from './security.mjs';

/**
 * The Mini App's HTTP surface: a small REST API plus one SSE stream, and the static Client.
 *
 * The Node entry owns the assigned loopback port for as long as the board is available, so
 * `dispose()` has to close the listener, every SSE connection and the poll timer.
 *
 * The routes themselves live in `api-routes.mjs`; this file only assembles them.
 */

export const POLL_INTERVAL_MS = 3000;

/** How often the server checks whether the boss's patrol is due. */
const PATROL_CHECK_INTERVAL_MS = 30_000;

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
    response.writeHead(status, withSecurityHeaders({
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    }));
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

  /**
   * Hand the page's decision back to the waiting tool call.
   *
   * @param {string} requestId
   * @param {'allowOnce'|'deny'} decision
   * @returns {boolean} whether anyone was waiting for this request
   */
  const resolvePermission = (requestId, decision) => {
    const pending = pendingPermissions.get(requestId);
    if (!pending) return false;
    pending.resolve(decision);
    pendingPermissions.delete(requestId);
    return true;
  };

  const handler = async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://miniapp.local');
    const { pathname } = url;
    const method = request.method ?? 'GET';

    try {
      const matched = matchRoute(method, pathname);
      if (!matched) {
        sendJson(response, 404, { error: 'not_found' });
        return;
      }

      await matched.route.handler({
        service,
        persistence,
        logger,
        clientDir,
        url,
        request,
        response,
        params: matched.params,
        sendJson: (status, payload) => sendJson(response, status, payload),
        broadcast,
        broadcastChatEvent,
        readBody,
        streams,
        resolvePermission,
      });
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
  const requestPermission = (event) => new Promise((settle) => {
    const requestId = event?.requestId ?? `perm_${Date.now()}`;

    // Nobody answers: deny, so a waiting run is never left hanging. The timer is unref'd
    // and cleared on resolve so it can never hold the process open.
    const timer = setTimeout(() => {
      pendingPermissions.delete(requestId);
      settle('deny');
    }, 120_000);
    timer.unref?.();

    pendingPermissions.set(requestId, {
      resolve: (decision) => {
        clearTimeout(timer);
        settle(decision);
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
 * 板面的运行时轮询。
 *
 * 每 3 秒问一次运行时：状态变了就把新的快照推给页面。对话是单独一路——
 * 宿主侧栏里说的话不会推动运行时版本号（没有会话、目标或任务变化），
 * 所以还要看会话消息数有没有变。
 *
 * 消息数是一次 COUNT，在几百 MB 的运行时库上不便宜（本机实测 0.2ms 热缓存、
 * 10ms 冷缓存）。所以先问一句更便宜的：**运行时库本身有没有被写过**
 * （`PRAGMA data_version`，读一下就完了，不扫表，实测 0.01ms）。
 * 没人写过，对话就不可能多出一句，那次 COUNT 就省掉了；
 * 有人写过才去数——所以侧栏里说的话照样在下一个轮询周期内浮出来。
 *
 * @param {{
 *   service: any,
 *   store?: { dataVersion?: () => number | null } | null,
 *   broadcast: (event: string, data: unknown) => void,
 *   logger?: any,
 *   intervalMs?: number,
 * }} deps
 */
export function createRuntimePoller(deps) {
  const {
    service,
    store = null,
    broadcast,
    logger = { info() {}, warn() {}, error() {}, debug() {} },
    intervalMs = POLL_INTERVAL_MS,
  } = deps;

  let lastRevision = service.currentRevision();
  let lastChatMessageCount = 0;
  /** 上一次看到的运行时数据版本号；`null` 表示还没对过基准。 */
  let lastDataVersion = null;

  /**
   * 运行时库自上次检查以来有没有被别的连接写过。
   *
   * @returns {boolean} true 表示「有可能变了，值得去数一次」
   */
  const runtimeWritten = () => {
    const version = typeof store?.dataVersion === 'function' ? store.dataVersion() : null;
    // 拿不到信号就保守：照旧每次都数，绝不为了省事丢掉实时性。
    if (version === null || version === undefined) return true;
    // 第一次检查只对齐基准，之后才有「变没变」可比。
    if (lastDataVersion === null) {
      lastDataVersion = version;
      return true;
    }
    if (version === lastDataVersion) return false;
    lastDataVersion = version;
    return true;
  };

  const tick = async () => {
    try {
      const revision = service.currentRevision();
      if (revision === lastRevision) {
        // The revision is quiet, but the conversation may not be.
        if (!runtimeWritten()) return;
        const chatCount = await service.getChatMessageCount();
        if (chatHistoryChanged(chatCount, lastChatMessageCount).changed) {
          lastChatMessageCount = chatCount;
          broadcast('chat.history', { messages: await service.getChatHistory() });
        }
        return;
      }
      lastRevision = revision;
      const overview = await service.getOverview();
      broadcast('update', overview);
    } catch (error) {
      logger.warn('mimic-tear.poll.failed', { message: error?.message });
    }
  };

  /** @type {NodeJS.Timeout | null} */
  let timer = null;

  return {
    tick,
    start() {
      if (timer) return;
      timer = setInterval(() => {
        void tick();
      }, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
  };
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
  const { RoundControl } = await import('./round-control.mjs');

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

  // 在跑的轮次登记表。**只在内存里**：它是「这一轮正在跑」的进程内事实，不是要落盘的
  // 业务状态。板面重启后没有「正在跑」这回事——宿主那边的会话轮次也跟着没了。
  const rounds = new RoundControl();

  const service = new ProjectService({
    store,
    readPlan,
    skills: skillScan,
    domains,
    persistence,
    boss,
    patrol,
    rounds,
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
  const poller = createRuntimePoller({
    service,
    store,
    broadcast: app.broadcast,
    logger: context.logger,
  });
  poller.start();

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
          // 走 app.broadcast：这个函数里没有别的 broadcast 可用，
          // 之前直接写 broadcast(...) 会被下面那个 catch 吞掉，交班汇报从来没到过页面。
          app.broadcast('duty', { rounds: await service.getDutyRounds() });
        }
        // 直通：把这一轮的事件直接投进项目负责人的会话，**不经过大哥**。
        //
        // **默认关**（`patrol-config.json` 的 `directDelivery`）。打开的前提是大哥的提示词
        // 已经改成「事件直达了，你只管没有归属的事」——否则两边各干一遍，同一份活干两次，
        // 而收件箱已经堆了 93 条没人看的结论了。
        //
        // 它放在板面自己巡检的早退**之前**：板面巡检和大哥值班是两件事，不该互相绑架。
        if (config.directDelivery) {
          // 直通的投递轮次**不再用单飞闸**（那是钝器：一条线的长投递挡住所有线）。
          // 精确的那一层是**在途标记**：同一条线 + 同类事件在飞 → 并进来，不投；
          // 别的线照常投递。见 `.agents/notes/proposed/architecture/2026-11-01-direct-delivery-wakeup-coalescing.md`。
          const { runRound } = await import('./direct-delivery-runner.mjs');
          const { ManagedProjects } = await import('./managed-projects.mjs');
          const { ThreadSubscriptions } = await import('./thread-subscriptions.mjs');
          const direct = await runRound({
            store,
            patrol,
            managed: new ManagedProjects(context.dataDir),
            subscriptions: new ThreadSubscriptions(context.dataDir),
            agent: context.agent ?? null,
          });
          context.logger.info('mimic-tear.direct.delivered', {
            attempted: direct.outcome.attempted,
            delivered: direct.outcome.delivered,
            queued: direct.outcome.queued,
            failed: direct.outcome.failed,
          });
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

        // 轮次是后台的：起完就等它跑完。已经被叫停的轮次**不算跑完**——如实报出去。
        const started = await service.startPatrol();
        if (started.skipped) {
          // 已经有一轮在跑了。同一件事不跑第二遍。
          context.logger.info('mimic-tear.patrol.skipped', { reason: started.reason });
          return;
        }
        const settled = await started.promise;
        if (settled.status !== 'finished') {
          context.logger.warn('mimic-tear.patrol.not_finished', {
            status: settled.status,
            message: settled.error,
          });
          app.broadcast('patrol', { findings: [], error: settled.error, status: settled.status });
          return;
        }
        app.broadcast('patrol', settled.result);
        const overview = await service.getOverview();
        app.broadcast('update', overview);
      } catch (error) {
        context.logger.warn('mimic-tear.patrol.failed', { message: error?.message });
      }
    })();
  }, PATROL_CHECK_INTERVAL_MS);
  patrolTimer.unref?.();

  // The duty heartbeat: a fallback for a broken host-side duty cron. It only runs while the
  // board is open — the Mini App is on-demand — and that ceiling is the whole point of
  // `duty-heartbeat.mjs`: it covers "the board is open and the cron's chain broke", not
  // "the board is closed".
  // The cron the heartbeat watches is resolved inside it, from `patrol-config.json`'s
  // `dutyCronId` — the node side must not pin an id here: the scheduler re-points by
  // creating a new definition, and a pinned id goes stale without saying so.
  const { runDutyHeartbeat, HEARTBEAT_CHECK_INTERVAL_MS } = await import('./duty-heartbeat.mjs');
  const heartbeatTimer = setInterval(() => {
    void (async () => {
      try {
        const stored = await persistence.getBossSession();
        await runDutyHeartbeat({
          dataDir: context.dataDir,
          store,
          sessionId: stored?.sessionId ?? null,
          agent: context.agent ?? null,
        });
      } catch (error) {
        context.logger.warn('mimic-tear.heartbeat.failed', { message: error?.message });
      }
    })();
  }, HEARTBEAT_CHECK_INTERVAL_MS);
  heartbeatTimer.unref?.();

  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    context.signal.removeEventListener('abort', onAbort);
    poller.stop();
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
