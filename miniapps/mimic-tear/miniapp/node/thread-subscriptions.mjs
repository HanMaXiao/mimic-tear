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

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

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
 * }} Subscription
 */

/** 添加订阅必须写明理由——跟管辖名单一个规矩。 */
const REASON_REQUIRED = '添加订阅必须写明理由（大老板的原话或指示）';

/** 一条线最多记多少个「已投递」的事件 id。 */
const DELIVERED_MEMORY = 200;

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
    const value = await readJson(this.path, []);
    return Array.isArray(value)
      ? value.filter((entry) => entry && typeof entry.projectName === 'string')
      : [];
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
   * @param {Subscription[]} entries
   */
  async #write(entries) {
    await mkdir(this.dataDir, { recursive: true });
    const temp = `${this.path}.${process.pid}.${Date.now().toString(36)}.tmp`;
    await writeFile(temp, JSON.stringify(entries, null, 2), 'utf8');
    await rename(temp, this.path);
  }
}

/**
 * @param {string} path
 * @param {any} fallback
 * @returns {Promise<any>}
 */
async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}
