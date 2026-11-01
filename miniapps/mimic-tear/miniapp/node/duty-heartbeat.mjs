/**
 * The duty heartbeat: a fallback for a broken host-side duty cron.
 *
 * The host's cron is the only trigger that runs 24×7. It also breaks: on 2026-10-22 four
 * rounds sat pending for hours with nothing delivered, and a later round took eighteen
 * minutes to be delivered. While the chain is broken nobody is on duty — and the board's
 * duty lamp only ever says "no handover for N minutes", never "the chain that should have
 * handed over is dead".
 *
 * What this covers, and what it does not — the line that must not be blurred:
 *
 * - It covers **"the board is open and the cron's delivery chain broke"**: the Mini App
 *   process is alive, so it can notice and step in.
 * - It does **not** cover **"the board is closed"**. The Mini App is on-demand: with the app
 *   closed there is no node process, no timer, nothing to notice. That half is the host's
 * job (and the watchdog scheduled task's — see the gap plan).
 *
 * So this is a *fallback*, not a replacement, and every conclusion it produces says which
 * half it is talking about.
 *
 * Three rules keep it from doubling the duty rounds:
 *
 * 1. **Only a blank slot may be filled.** If the scheduler created a run for that slot, the
 *    host knows about the round — it may be late, it may be retrying — and a second duty
 *    round for the same slot would double the spend. Only slots where *nobody created a
 *    run at all* are the heartbeat's to fill.
 * 2. **One round per slot.** The slot that was filled is remembered in the heartbeat's own
 *    state file, so a slow tick cannot fire twice for the same slot.
 * 3. **The chain is resolved by name, not by a hardcoded id.** A hardcoded id pointed at a
 *    deleted cron and made every verdict read "healthy" — the failure mode that looks
 *    exactly like "nothing went wrong". See `duty-chain.mjs`.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { appendAlert } from './watchdog-alerts.mjs';
import { BoardStateStore } from './board-state.mjs';
import { computeDutyEvidence, DEFAULT_DUTY_INTERVAL_MINUTES } from './view-model.mjs';
import { DUTY_CRON_SEED, readDutyChain } from './duty-chain.mjs';
import { computeDutyGap, describeDuration, resolveNow } from './duty-gap.mjs';
import { DutyIntent, normalizeDutyIntent } from './duty-intent.mjs';

export { resolveNow };

/**
 * How long the Host keeps an idle Mini App runtime alive before shutting it down.
 *
 * Measured 2026-10-22 08:15:37 → 08:20:30 = 291.8 seconds. It is a Host behaviour, not
 * ours, so it is a budget we have to live inside rather than a number we control.
 */
export const RUNTIME_IDLE_GRACE_MS = 292_000;

/**
 * How often the heartbeat looks.
 *
 * It has to be **shorter than the runtime's idle grace** (see above). A five-minute
 * interval lost that race by seven seconds on 2026-10-22: the runtime was shut down before
 * the first tick could fire, so the freshly published code never ran at all. A minute leaves
 * room for several ticks per idle window, and it also shortens how long a broken duty
 * chain goes unnoticed.
 */
export const HEARTBEAT_CHECK_INTERVAL_MS = 60_000;

const STATE_FILE = 'duty-heartbeat.json';

/**
 * What the heartbeat asks the boss to do.
 *
 * The real duty prompt lives in the cron's own definition; this is the fallback's own
 * instruction, and it says the one thing the fallback is for.
 *
 * @param {{gapMinutes?:number|null, gapRounds?:number|null, gapSince?:number|null}} [gap]
 * @returns {string}
 */
export function buildHeartbeatPrompt(gap = {}) {
  const lines = [
    '这是一次值班补位：宿主 cron 的值班投递链断了，这一轮没有交班。',
  ];
  const minutes = Number(gap.gapMinutes);
  const rounds = Number(gap.gapRounds);
  if (Number.isFinite(minutes) && Number.isFinite(rounds)) {
    // 断多久、断几轮必须写进提示词：不说的话，大哥会以为自己只是晚了一轮，
    // 于是把「断了四个小时」当成「正常迟到」汇报上去。
    lines.push(`你断了 ${Math.round(minutes)} 分钟（${rounds} 轮值班）`
      + (Number.isFinite(Number(gap.gapSince)) ? `，从 ${new Date(Number(gap.gapSince)).toISOString()} 起` : '')
      + '。如实说出来，不要当成普通迟到。');
    lines.push('这一轮补的是「当前状态」——不要去重放那几轮，历史已经过去了。');
  }
  lines.push('请按值班时的四件事走一遍：巡检在管的项目、记下结论、派工该派的、最后交班。');
  lines.push('交班会写回看板的值班时间戳，所以补的这一轮之后，漏掉的那段仍留在调度记录里。');
  return lines.join('\n');
}

/**
 * The fallback's own instruction, without a gap to report.
 *
 * @type {string}
 */
export const HEARTBEAT_PROMPT = buildHeartbeatPrompt();

/**
 * Read the heartbeat's own state.
 *
 * @param {string} dataDir
 * @returns {Promise<any>}
 */
export async function readHeartbeatState(dataDir) {
  try {
    const raw = await readFile(join(dataDir, STATE_FILE), 'utf8');
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

/**
 * Write the heartbeat's own state.
 *
 * @param {string} dataDir
 * @param {any} state
 * @returns {Promise<void>}
 */
export async function writeHeartbeatState(dataDir, state) {
  await mkdir(dataDir, { recursive: true });
  const target = join(dataDir, STATE_FILE);
  const temp = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;
  await writeFile(temp, JSON.stringify(state, null, 2), 'utf8');
  await rename(temp, target);
}

/**
 * The duty period and the pinned cron id, from the duty config.
 *
 * `dutyCronId` is how the user pins the duty cron: when the scheduler is re-pointed, this
 * field has to follow, or the node side keeps reading a chain that no longer exists. The
 * node side only reads it — it never guesses which cron is current.
 *
 * @param {string} dataDir
 * @returns {Promise<{periodMinutes:number, dutyCronId:string|null}>}
 */
export async function readDutyConfig(dataDir) {
  try {
    // 配置住在板面状态的单一 store 里（`board-state.mjs`）——心跳是**独立进程**，
    // 它读的是同一个 store 的同一段，不是另一个文件。
    const value = await new BoardStateStore(dataDir).section('config');
    const minutes = Number(value?.dutyIntervalMinutes);
    const pinned = typeof value?.dutyCronId === 'string' ? value.dutyCronId.trim() : '';
    return {
      periodMinutes: Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_DUTY_INTERVAL_MINUTES,
      dutyCronId: pinned || null,
    };
  } catch {
    return { periodMinutes: DEFAULT_DUTY_INTERVAL_MINUTES, dutyCronId: null };
  }
}

/**
 * Decide whether the heartbeat should step in this tick.
 *
 * The judgement comes from the same evidence the watchdog uses (`computeDutyEvidence`), so
 * there is one rule about what a gap is, not two. The **gap** itself — how long, how many
 * rounds, which of them count as missed duty — is `duty-gap.mjs`'s job, and this function
 * only turns that answer into "step in / don't".
 *
 * Three things it has to get right:
 *
 * 1. **Resting is not a gap.** A boss that was told to rest must not be handed a duty
 *    round. It was not on duty, so nothing was missed.
 * 2. **Coverage has to advance.** The old rule remembered the slot it had just filled and
 *    compared it with the *first* blank slot — and the first blank slot is always "one past
 *    the last delivery", so it never moves. The lock was therefore permanent: the heartbeat
 *    could fill exactly one round per chain, ever. It now remembers how far it has
 *    **covered**, and the next blank slot is the first one beyond that.
 * 3. **A failed fill must be retryable.** If the fill fails, the coverage must not
 *    advance — otherwise the round is marked done and never retried.
 *
 * @param {{runs?:any[], periodMs?:number, now?:number, intent?:any,
 *          coveredThroughSlot?:number|null, coveredAt?:number|null}} input
 * @returns {{broken:boolean, trigger:boolean, reason:string, slot:number|null, since:number|null,
 *            evidence:{runId:string,status:string,retryAttempt:number,createdAt:number,error:string|null}|null,
 *            pendingTail:any, blankTail:any, gap:any}}
 */
export function evaluateDutyHeartbeat(input) {
  const runs = input?.runs ?? [];
  const periodMs = Number(input?.periodMs) > 0 ? Number(input.periodMs) : DEFAULT_DUTY_INTERVAL_MINUTES * 60_000;
  const now = resolveNow(input?.now);
  const intent = normalizeDutyIntent(input?.intent);
  const coveredThroughSlot = Number.isFinite(Number(input?.coveredThroughSlot))
    && input?.coveredThroughSlot !== null
    && input?.coveredThroughSlot !== undefined
    ? Number(input.coveredThroughSlot)
    : null;

  const evidence = computeDutyEvidence({
    runs,
    periodMs,
    now,
    evidenceWindowMs: periodMs * 1.5,
  });

  const pendingTail = evidence.pendingTail;
  const blankTail = evidence.blankTail;
  const broken = pendingTail.slots > 0 || blankTail.slots > 0;

  const gap = computeDutyGap({
    blankTail,
    anchor: evidence.anchor,
    periodMs,
    now,
    intent,
    coveredThroughSlot,
    coveredAt: input?.coveredAt ?? null,
  });

  const base = {
    broken,
    slot: null,
    since: null,
    evidence: pendingTail.runs[0] ?? null,
    pendingTail,
    blankTail,
    gap,
  };

  if (!broken) {
    return { ...base, trigger: false, reason: 'healthy' };
  }

  if (blankTail.slots === 0) {
    // The scheduler created a run for every missing slot and never delivered it. The host
    // is on those rounds — late, or retrying — and a second round would double the spend.
    return { ...base, trigger: false, reason: 'host_in_flight', since: pendingTail.since };
  }

  if (gap.source === 'resting') {
    // The boss was told to rest. Resting is not an outage, and it is not a gap either:
    // nobody was supposed to hand over.
    return { ...base, trigger: false, reason: 'resting', since: gap.hole.since };
  }

  if (!gap.coverable) {
    // Everything in this gap has already been covered. `already_triggered` keeps its old
    // name because other code reads it; what it now means is "this stretch is done".
    return {
      ...base,
      trigger: false,
      reason: 'already_triggered',
      slot: gap.covered.throughSlot,
      since: gap.gap.since,
    };
  }

  return {
    ...base,
    trigger: true,
    reason: 'blank_slot',
    slot: gap.uncovered.nextSlot,
    since: gap.gap.since,
  };
}

/**
 * The conclusion a human reads: the run-level evidence, never just a timestamp.
 *
 * @param {ReturnType<typeof evaluateDutyHeartbeat>} decision
 * @returns {string}
 */
export function describeDutyHeartbeat(decision) {
  const lines = [];
  if (decision.pendingTail.slots > 0) {
    lines.push(`宿主 cron 排了 ${decision.pendingTail.slots} 轮但没投出去：`);
    for (const run of decision.pendingTail.runs) {
      lines.push(`  run_id=${run.runId} status=${run.status} retry_attempt=${run.retryAttempt}`
        + ` created_at=${new Date(run.createdAt).toISOString()}`
        + (run.error ? ` error=${run.error}` : ''));
    }
  }
  if (decision.blankTail.slots > 0) {
    lines.push(`另有 ${decision.blankTail.slots} 个槽位宿主连 run 都没创建`
      + `（从 ${new Date(decision.blankTail.since).toISOString()} 起）——只有这些能补。`);
  }
  // 断多久、断几轮、以及其中多少真的算漏班——休息期间攒下的空槽不算。
  const gap = decision.gap;
  if (gap) {
    if (gap.source === 'resting') {
      lines.push('大哥在休息——休息期间不算漏班，也不补位。');
    } else if (gap.gap.slots > 0) {
      lines.push(`断档 ${describeDuration(gap.gap.minutes)}，其中算漏班 ${gap.gap.rounds} 轮`
        + `（从 ${new Date(gap.gap.since).toISOString()} 起）`
        + `；已补 ${gap.covered.slots} 轮，还欠 ${gap.uncovered.slots} 轮。`);
    } else {
      lines.push(`洞有 ${gap.hole.slots} 轮，但这轮在岗期间没有漏班。`);
    }
  }
  lines.push('范围：node 侧只能在「板面开着」时补；板面关着时没有 node 进程，补不了。');
  return lines.join('\n');
}

/**
 * The heartbeat's status, for the board.
 *
 * @param {{dataDir?:string, store?:any, now?:number, seedCronId?:string|null, periodMs?:number}} [options]
 * @returns {Promise<any>}
 */
export async function getDutyHeartbeatStatus(options = {}) {
  const dataDir = options.dataDir ?? null;
  const now = resolveNow(options.now);
  const config = dataDir
    ? await readDutyConfig(dataDir)
    : { periodMinutes: DEFAULT_DUTY_INTERVAL_MINUTES, dutyCronId: null };
  const periodMs = Number(options.periodMs) > 0 ? Number(options.periodMs) : config.periodMinutes * 60_000;
  const state = dataDir ? await readHeartbeatState(dataDir) : {};
  // The **pin** (the user's decision, from the duty config) and the **seed** (the built-in
  // family hint) are two different channels: the pin is a decision, the seed is only a
  // lookup. Conflating them is what made "pin the seed's id" silently fall back.
  const pinnedCronId = options.pinnedCronId ?? config.dutyCronId ?? null;
  const seedCronId = options.seedCronId ?? DUTY_CRON_SEED;
  // What the boss was told to do. Without it the board cannot tell "the chain broke" from
  // "the boss was told to rest" — and those two want opposite answers.
  const intent = options.intent ?? (dataDir ? await new DutyIntent(dataDir).read() : null);

  // With a store, the state is computed live (the heartbeat's own tick does this). Without
  // one, the last observation the heartbeat wrote down is what we have — and it says when
  // it was made, so nothing is presented as fresher than it is.
  const chain = options.store ? readDutyChain(options.store, { pinnedCronId, seedCronId }).chain : null;
  const decision = chain
    ? evaluateDutyHeartbeat({
      runs: readDutyChain(options.store, { pinnedCronId, seedCronId }).runs,
      periodMs,
      now,
      intent,
      coveredThroughSlot: state.coveredThroughSlot ?? null,
      coveredAt: state.coveredAt ?? null,
    })
    : null;

  return {
    broken: decision ? decision.broken : Boolean(state.brokenSince),
    reason: decision ? decision.reason : (state.brokenSince ? 'last_seen_broken' : 'healthy'),
    slot: decision ? decision.slot : null,
    since: decision ? decision.since : (state.brokenSince ?? null),
    pendingTail: decision ? decision.pendingTail : { slots: 0, since: null, runs: [] },
    blankTail: decision ? decision.blankTail : { slots: 0, since: null, firstSlot: null, lastSlot: null },
    // The gap, in full: how long, how many rounds, which of them count as missed duty.
    gap: decision ? decision.gap : null,
    mode: intent?.mode ?? 'on-duty',
    chain: chain ? { name: chain.name, targetCronId: chain.targetCronId, active: chain.active, reason: chain.reason } : null,
    lastTriggeredSlot: state.lastTriggeredSlot ?? null,
    lastTriggeredAt: state.lastTriggeredAt ?? null,
    // How far the fallback has covered. It advances as the hole advances, so the heartbeat
    // can keep covering instead of locking on the first round forever.
    coveredThroughSlot: state.coveredThroughSlot ?? null,
    coveredAt: state.coveredAt ?? null,
    lastResult: state.lastResult ?? null,
    lastError: state.lastError ?? null,
    updatedAt: state.updatedAt ?? null,
    // When this was observed, so the board can say "as of HH:MM" instead of implying now.
    asOf: decision ? now : (state.updatedAt ?? null),
    // The scope, in the payload: the board must not read this as "the duty is covered".
    scope: '只覆盖「板面开着 + 宿主 cron 投递链断了」；板面关着时补不了（那是宿主侧的事）',
  };
}

/**
 * Run one heartbeat tick: notice a broken chain, and fill a slot nobody created.
 *
 * @param {{dataDir:string, store?:any, sessionId?:string|null, agent?:any, cronId?:string|null,
 *          periodMs?:number, now?:number, prompt?:string}} [options]
 * @returns {Promise<any>}
 */
export async function runDutyHeartbeat(options = {}) {
  const dataDir = options.dataDir;
  const now = resolveNow(options.now);
  const config = await readDutyConfig(dataDir);
  const periodMs = Number(options.periodMs) > 0 ? Number(options.periodMs) : config.periodMinutes * 60_000;
  const sessionId = options.sessionId ?? null;
  const agent = options.agent ?? null;

  const state = await readHeartbeatState(dataDir);
  // The pin (the user's decision) and the seed (the built-in family hint) travel on two
  // separate channels — see `duty-chain.mjs`.
  const pinnedCronId = options.pinnedCronId ?? config.dutyCronId ?? null;
  const seedCronId = options.seedCronId ?? DUTY_CRON_SEED;
  const { chain, runs } = readDutyChain(options.store ?? {}, { pinnedCronId, seedCronId });

  // What the boss was told to do. A boss that was told to rest is **not** on duty, so it
  // must not be handed a duty round — and the empty slots it accumulates while resting are
  // not missed rounds. Without this, "resting" would only silence the alarm while the
  // heartbeat kept burning duty rounds in the background.
  const intent = options.intent ?? await new DutyIntent(dataDir).read();

  // The target cron has to exist and not be deleted. If it does not, the chain is
  // misconfigured — and saying "healthy" then would be the exact lie that cost an
  // afternoon: a watchdog that points at a deleted cron sees no runs and reports nothing
  // wrong. So it says so, loudly, and writes it down.
  if (!chain.active) {
    await appendAlert(dataDir, {
      at: now,
      action: 'heartbeat_misconfigured',
      title: '仿身泪滴 · 值班心跳配置不对',
      body: `目标 cron「${chain.name}」不存在或已被删除（reason=${chain.reason}`
        + `${chain.pinnedCronId ? `, 配置里钉的是 ${chain.pinnedCronId}` : ''}）。`
        + '所以 node 侧既判不出断链、也不会补位——它读的是一条不存在的链。'
        + '修法：把 patrol-config.json 的 dutyCronId 更新成当前活着的那个 cron id。',
      delivered: false,
      error: chain.reason,
      note: null,
      gapTo: null,
    });
    await writeHeartbeatState(dataDir, {
      ...state,
      lastResult: 'misconfigured',
      lastError: chain.reason,
      updatedAt: now,
    });
    return {
      broken: false,
      trigger: false,
      reason: 'misconfigured',
      slot: null,
      since: null,
      evidence: null,
      pendingTail: { slots: 0, since: null, runs: [] },
      blankTail: { slots: 0, since: null, firstSlot: null },
      chain,
      triggered: false,
      result: 'misconfigured',
    };
  }

  const decision = evaluateDutyHeartbeat({
    runs,
    periodMs,
    now,
    intent,
    coveredThroughSlot: state.coveredThroughSlot ?? null,
    coveredAt: state.coveredAt ?? null,
  });

  // C4: a broken chain is written down whether or not the heartbeat steps in.
  if (decision.broken && (state.brokenSince ?? null) === null) {
    await appendAlert(dataDir, {
      at: now,
      action: 'heartbeat_break',
      title: '仿身泪滴 · 值班链断了',
      body: describeDutyHeartbeat(decision),
      delivered: false,
      error: null,
      note: decision.reason,
      gapTo: null,
    });
  }

  if (!decision.trigger) {
    await writeHeartbeatState(dataDir, {
      ...state,
      brokenSince: decision.broken ? (state.brokenSince ?? decision.since ?? now) : null,
      lastEvidence: decision.evidence,
      updatedAt: now,
    });
    return { ...decision, chain, triggered: false, result: decision.reason };
  }

  // C2: one duty round, on the session the board already knows as the boss session.
  const targetSession = sessionId ?? chain.targetSessionId ?? null;
  // The prompt carries the gap: how long, how many rounds. Without it the boss reports a
  // four-hour outage as if it were a late round.
  const prompt = options.prompt ?? buildHeartbeatPrompt({
    gapMinutes: decision.gap?.gap?.minutes ?? null,
    gapRounds: decision.gap?.gap?.rounds ?? null,
    gapSince: decision.gap?.gap?.since ?? null,
  });
  let outcome;
  try {
    outcome = agent
      ? await agent.run({ text: prompt, sessionId: targetSession }, { onEvent: options.onEvent })
      : { status: 'skipped', error: '没有可用的 agent 通道', text: '' };
  } catch (error) {
    outcome = { status: 'error', error: error?.message ?? String(error), text: '' };
  }

  const failed = !outcome || outcome.error || outcome.status === 'error';
  const next = {
    ...state,
    brokenSince: decision.since ?? now,
    lastTriggeredSlot: decision.slot,
    lastTriggeredAt: now,
    lastResult: failed ? 'error' : 'ok',
    lastError: failed ? (outcome?.error ?? '未知原因') : null,
    lastEvidence: decision.evidence,
    updatedAt: now,
  };

  if (failed) {
    // The coverage must **not** advance: a round that never ran is not a round that ran.
    // Marking it covered here is what used to make a failed fill permanent — the heartbeat
    // remembered the slot, and never tried that stretch again.
    await appendAlert(dataDir, {
      at: now,
      action: 'heartbeat_failed',
      title: '仿身泪滴 · 补位失败',
      body: `补位这一轮没能跑起来：${outcome?.error ?? '未知原因'}\n${describeDutyHeartbeat(decision)}`,
      delivered: false,
      error: outcome?.error ?? '未知原因',
      note: null,
      gapTo: null,
    });
    await writeHeartbeatState(dataDir, next);
    return { ...decision, chain, triggered: true, result: 'error', error: outcome?.error ?? '未知原因' };
  }

  // The round ran. Now the coverage may advance — to the **last** uncovered slot, because
  // one fill reports the current state of everything that was missed. Replaying each round
  // separately would burn one duty round per missed slot and produce the same conclusion
  // every time.
  next.coveredThroughSlot = decision.gap?.uncovered?.coverThroughSlot ?? state.coveredThroughSlot ?? null;
  next.coveredAt = now;
  next.gapSince = decision.gap?.gap?.since ?? null;
  next.gapRounds = decision.gap?.gap?.rounds ?? null;
  next.gapMinutes = decision.gap?.gap?.minutes ?? null;

  await appendAlert(dataDir, {
    at: now,
    action: 'heartbeat_run',
    title: '仿身泪滴 · 已补一轮值班',
    body: `补位这一轮已发起（槽位 ${decision.slot}，session ${targetSession ?? '未知'}）。\n${describeDutyHeartbeat(decision)}`,
    delivered: true,
    error: null,
    note: null,
    gapTo: null,
  });
  await writeHeartbeatState(dataDir, next);
  return { ...decision, chain, triggered: true, result: 'ok' };
}
