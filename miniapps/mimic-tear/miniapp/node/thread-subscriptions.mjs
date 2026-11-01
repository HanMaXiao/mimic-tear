/**
 * 订阅表：哪条线有投递口，负责会话是谁，投过什么。
 *
 * ## 它是什么
 *
 * 「事件该投给谁」这件事的**唯一权威**。没有订阅项 → 这条线没有投递口 → 事件投不出去。
 *
 * ## 为什么是状态，不是现推
 *
 * 现推的话，每一轮都要重新决定「谁负责这条线」。那个决定一旦飘了，事件就投错人——而
 * **投错人比不投更糟**：不投只是晚一点，投错是把工作交到不该拿的人手里。所以归属落成状态，
 * 只由显式动作改。
 *
 * ## 与管辖名单的关系
 *
 * 订阅表**不是**管辖权。管辖名单说「大哥可以管哪些项目」，订阅表说「这些项目的事件投给
 * 哪个会话」。两者都必须成立，直通才发生——**投递口比管辖权更窄**。
 *
 * 形状与 `managed-projects.json` 同形（一个数组、一个文件、原子写），免得又长出一套
 * 读写的规矩。
 */

import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { readJsonArray, updateJsonArray, writeJsonAtomic } from './json-ledger.mjs';

/**
 * @typedef {{
 *   projectName:string,
 *   projectId?:number|string|null,
 *   ownerSessionId:string|null,
 *   ownerAgent?:string|null,
 *   reason:string,
 *   since:number,
 *   addedAt:number,
 *   active:boolean,
 *   delivered:string[],
 *   inFlight?:Record<string,{triggerId:string, activityAt:number, sentAt:number}>,
 * }} Subscription
 */

/** 添加订阅必须写明理由——跟管辖名单一个规矩。 */
const REASON_REQUIRED = '添加订阅必须写明理由（大老板的原话或指示）';

/** 一条线最多记多少个「已投递」的事件 id。 */
const DELIVERED_MEMORY = 200;

/**
 * 在途标记多久算过期。
 *
 * **必须有这个口径**：负责会话那一轮要是永远不结束（卡住、被中断而没 resolve），
 * 在途标记就一直挂着 → 那条线的投递一直被合并 → 事件一直不投。
 * 过期之后旧标记作废、照常投递（事件不丢，最多多唤醒一次）。
 */
export const IN_FLIGHT_EXPIRY_MS = 60 * 60_000;

export class ThreadSubscriptions {
  /** @param {string} dataDir */
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.path = join(dataDir, 'thread-subscriptions.json');
  }

  /**
   * 当前的订阅。
   *
   * @returns {Promise<Subscription[]>}
   */
  async list() {
    const all = await readJsonArray(this.path);
    return all.filter((entry) => entry && typeof entry.projectName === 'string');
  }

  /**
   * 给一条线开投递口。
   *
   * **负责会话有两种取得方式**（宿主的所有权闸决定的）：
   *
   * 1. **现成的会话**（`ownerSessionId`）——但它必须是 **Mini App 自己拥有的**会话
   *    （`purpose = miniapp:<pluginId>`）。桌面端用户会话不是，宿主会拒写。
   * 2. **让 Mini App 建一个**（给 `ownerAgent`，会话留空）——第一次投递时建出来，
   *    建完写回订阅表。这是方案 A 的落法。
   *
   * 两种都没有 = 没有投递口。
   *
   * @param {string} projectName
   * @param {string|null} ownerSessionId 负责会话；`null` 表示「让 Mini App 建一个」
   * @param {string} reason 为什么
   * @param {{projectId?:number|string|null, ownerAgent?:string|null}} [options]
   * @returns {Promise<Subscription[]>}
   */
  async add(projectName, ownerSessionId, reason, options = {}) {
    const name = String(projectName ?? '').trim();
    const sessionId = String(ownerSessionId ?? '').trim();
    const ownerAgent = String(options.ownerAgent ?? '').trim() || null;
    const why = String(reason ?? '').trim();
    if (!name) throw new Error('必须写明项目名');
    if (!sessionId && !ownerAgent) {
      throw new Error('必须写明负责会话（或让 Mini App 自建：给 ownerAgent）——没有投递口就没有归属');
    }
    if (!why) throw new Error(REASON_REQUIRED);

    const all = await this.list();
    const existing = all.find((entry) => entry.projectName === name);
    if (existing) {
      existing.ownerSessionId = sessionId || null;
      if (ownerAgent) existing.ownerAgent = ownerAgent;
      existing.reason = why;
      existing.addedAt = Date.now();
      existing.active = true;
      if (options.projectId != null) existing.projectId = options.projectId;
    } else {
      all.push({
        projectName: name,
        projectId: options.projectId ?? null,
        ownerSessionId: sessionId || null,
        ownerAgent,
        reason: why,
        since: Date.now(),
        addedAt: Date.now(),
        active: true,
        delivered: [],
      });
    }
    await this.#write(all);
    return all;
  }

  /**
   * 记下这条线的负责会话是哪一个。
   *
   * **只有真正建出来的那一次才写。** 投递失败不写——写一个查不到的 sessionId 进去，
   * 下一轮就会拿着它去续一个不存在的会话。
   *
   * @param {string} projectName
   * @param {string} sessionId Mini App 自己拥有的那个会话
   * @returns {Promise<Subscription[]>}
   */
  async setOwnerSession(projectName, sessionId) {
    const name = String(projectName ?? '').trim();
    const id = String(sessionId ?? '').trim();
    if (!name || !id) return this.list();
    const all = await this.list();
    const entry = all.find((item) => item.projectName === name);
    if (!entry) return all;
    entry.ownerSessionId = id;
    entry.updatedAt = Date.now();
    await this.#write(all);
    return all;
  }

  /**
   * 关掉一条线的投递口。
   *
   * @param {string} projectName
   * @param {string} reason
   * @returns {Promise<Subscription[]>}
   */
  async remove(projectName, reason) {
    const name = String(projectName ?? '').trim();
    const why = String(reason ?? '').trim();
    if (!name) throw new Error('必须写明项目名');
    if (!why) throw new Error(REASON_REQUIRED);
    const all = await this.list();
    const next = all.filter((entry) => entry.projectName !== name);
    await this.#write(next);
    return next;
  }

  /**
   * 记下「这个事件已经投过了」。
   *
   * 去重靠它——同一条事件不能投两次，那会让负责人会话收到重复的活。
   *
   * @param {string} projectName
   * @param {string[]} triggerIds
   * @returns {Promise<Subscription[]>}
   */
  async markDelivered(projectName, triggerIds) {
    const name = String(projectName ?? '').trim();
    const ids = (triggerIds ?? []).map((id) => String(id)).filter(Boolean);
    if (!name || ids.length === 0) return this.list();
    const all = await this.list();
    const entry = all.find((item) => item.projectName === name);
    if (!entry) return all;
    const seen = new Set(Array.isArray(entry.delivered) ? entry.delivered : []);
    for (const id of ids) seen.add(id);
    entry.delivered = [...seen].slice(-DELIVERED_MEMORY);
    await this.#write(all);
    return all;
  }

  /**
   * 投递前的一次**认领**：要么「这一笔归我发」，要么「已经有同类的在途，并进去」。
   *
   * **为什么是「认领」而不是「读一眼再写」**：拆成两步，两个 tick 就可能同时读到
   * 「没有在途」，于是各发一次——同一个项目两个在途。认领是一次读-改-写。
   *
   * **并入不是丢事件**：命中的那条事件 id 进在途记录，等那一轮结束后按**合并后的最新
   * 活动时间**再投一次（见 `direct-delivery.mjs` 的尾巴投递）。
   *
   * @param {string} projectName
   * @param {string} type 事件类型（同类才并）
   * @param {{id?:string, at?:number}} trigger 要认领的事件
   * @param {{expiryMs?:number, now?:number}} [options]
   * @returns {Promise<{claimed:boolean, merged:boolean, expired:boolean, reason:string, record:any}>}
   */
  async claimDelivery(projectName, type, trigger, options = {}) {
    const name = String(projectName ?? '').trim();
    const kind = String(type ?? '').trim();
    if (!name || !kind) return { claimed: false, merged: false, expired: false, reason: 'invalid', record: null };
    const expiryMs = Number(options.expiryMs) > 0 ? Number(options.expiryMs) : IN_FLIGHT_EXPIRY_MS;
    const now = Number(options.now) || Date.now();

    const all = await this.list();
    const entry = all.find((item) => item.projectName === name);
    if (!entry) return { claimed: false, merged: false, expired: false, reason: 'no_subscription', record: null };

    /** @type {any} */
    let outcome = null;
    // **一次读-改-写，在锁里**（`json-ledger.mjs` 的纪律）：拆成「先读后写」，两个 tick
    // 就可能同时读到「没有在途」，于是各发一次——同一个项目两个在途。
    await updateJsonArray(this.path, (current) => {
      // 账本的修补重写会再调一次 mutate → 那时内容已经写对了，原样返回即可。
      if (outcome) return current;
      const target = current.find((item) => item?.projectName === name);
      if (!target) {
        outcome = { claimed: false, merged: false, expired: false, reason: 'no_subscription', record: null };
        return current;
      }
      const inflight = { ...(target.inFlight ?? {}) };
      const running = inflight[kind] ?? null;
      const expired = Boolean(running) && (now - Number(running?.sentAt ?? 0) > expiryMs);

      if (running && !expired) {
        // **命中在途**：并进来，本轮不投。
        const merged = [...(running.merged ?? []), trigger];
        const record = {
          ...running,
          merged,
          activityAt: Math.max(Number(running.activityAt ?? 0), Number(trigger?.at ?? 0) || 0),
        };
        inflight[kind] = record;
        target.inFlight = inflight;
        outcome = {
          claimed: false, merged: true, expired: false, reason: 'merged_into_inflight', record,
        };
        return current;
      }

      // **认领**（新的一笔，或旧的已过期 → 接管）。
      const record = {
        type: kind,
        triggerId: trigger?.id ?? '',
        activityAt: Number(trigger?.at ?? 0) || 0,
        sentAt: now,
        merged: [],
        sessionId: target.ownerSessionId ?? '',
      };
      inflight[kind] = record;
      target.inFlight = inflight;
      outcome = {
        claimed: true,
        merged: false,
        expired: Boolean(expired),
        reason: expired ? 'expired_taken_over' : 'claimed',
        record,
        // 过期那条里的合并事件**不能丢**：它们从没被投出去。交给调用方补投。
        expiredRecord: expired ? running : null,
      };
      return current;
    }, null);

    return outcome ?? { claimed: false, merged: false, expired: false, reason: 'no_subscription', record: null };
  }

  /**
   * 读一条在途记录（投递结束时要读它——并进来的事件是在途期间才写进去的）。
   *
   * @param {string} projectName
   * @param {string} type
   * @returns {Promise<any>}
   */
  async getInFlight(projectName, type) {
    const name = String(projectName ?? '').trim();
    const kind = String(type ?? '').trim();
    if (!name || !kind) return null;
    const entry = (await this.list()).find((item) => item.projectName === name);
    return entry?.inFlight?.[kind] ?? null;
  }

  /**
   * 清掉在途标记。
   *
   * 成功投递 → 转成 `delivered`（调用方负责记账）；失败 → 从在途里撤掉，
   * 事件下一轮还会被计划到（**失败不记账**的语义不变）。
   *
   * @param {string} projectName
   * @param {string} type 事件类型
   * @returns {Promise<Subscription[]>}
   */
  async clearInFlight(projectName, type) {
    const name = String(projectName ?? '').trim();
    if (!name || !type) return this.list();
    const all = await this.list();
    const entry = all.find((item) => item.projectName === name);
    if (!entry) return all;
    const inflight = { ...(entry.inFlight ?? {}) };
    if (inflight[type]) {
      delete inflight[type];
      entry.inFlight = inflight;
      await this.#write(all);
    }
    return all;
  }

  /**
   * @param {Subscription[]} entries
   */
  async #write(entries) {
    await mkdir(this.dataDir, { recursive: true });
    // **用仓库自己的写盘纪律**（`json-ledger.mjs`）：唯一临时名 + 原子替换 + **rename 重试**。
    // 少了重试，Windows 上「刚写的文件被扫描器占住」会变成一次写失败——
    // 2026-11-01 跑在途合并的测试时真机撞到过 `EPERM: rename`。
    await writeJsonAtomic(this.path, entries);
  }
}

/**
 * @param {string} path
 * @returns {Promise<any>}
 */
async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return [];
  }
}
