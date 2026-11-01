/**
 * 板面状态的单一 store。
 *
 * ## 要收口的是什么
 *
 * 板面的状态散在 `liveboards/mimic-tear/` 下的十几个 json 里。散开的代价不是「文件多」，
 * 是**同一件事被写在几个地方，跨文件的一致性只能靠人工核对**。已经出过真事故：
 * 派工账的并发写毁掉过记录——幂等键就在账里，丢一条就可能把同一条指令重投一次。
 *
 * 所以这里给板面自己写的那几本账一个**共同的家**：
 *
 * | 段 | 原来在哪 | 谁写 |
 * | --- | --- | --- |
 * | `dispatches` | `dispatches.json` | **两个写者，两个进程**：看板的派工路径 + 值班路径 |
 * | `acks` | `acks.json` | 看板 |
 * | `dismissed` | `dismissed.json` | 看板 |
 * | `bossSession` | `boss-session.json` | 看板 |
 *
 * 收口之后：**一个文件、一把锁、一条写路径**。派工账那两个写者不再各写各的——
 * 它们写的是同一段，锁的是同一把锁。
 *
 * ## 一次性迁移，不留两份口径
 *
 * 老文件在 store 文件还不存在时**读一次**，读进来的就是 store 的内容。之后老文件
 * **再也不被读**——它们留在盘上（是用户的数据，不删），但那只是历史快照。
 *
 * **不做「双读」**：新旧两套都读，就是两份口径——而这个仓库已经因为多处口径不一致
 * 吃过亏（主规格 §25.1：判据必须只有一个）。要么老文件是历史，要么老文件是真相，
 * 不能两者都是。
 *
 * 迁移在锁里做，而且**在锁里再查一次**：两个进程同时第一次访问时，只有一个真的迁移，
 * 另一个看到 store 已经在了就直接用——不然第二个会用老文件的内容盖掉第一个刚写进去的。
 *
 * ## 哪些状态不在这儿
 *
 * - **结论账家族**（`patrol.json` / `patrol-answered.json` / `patrol-archive.json`）与
 *   **`patrol-config.json`**：**不在这里**。它们被大哥按文件名直接读写（值班技能里
 *   「写进 `patrol-answered.json`」是手写文件），而 CLI 还没有能替代手写的 `answer`
 *   命令。收口它们 = 动大哥的手，得先改大哥的契约——那是独立立项的事。
 * - **看门狗自己的状态**（`watchdog-state.json` / `watchdog-notices.json`）：看门狗是
 *   **独立进程**（Windows 计划任务），不在 Mini App 的生命周期里，跨进程共享一个
 *   store 会把两边的锁搅在一起。
 * - **大哥的长期配置**（`duty-intent.json` / `managed-projects.json` /
 *   `skill-library.json` / `thread-subscriptions.json`）：各自由 CLI 或大哥自己独占
 *   写入，生命周期是「大哥的长期配置」，跟板面的运行时状态不是一回事。
 */

import { join, resolve } from 'node:path';

import { readJsonFile, withFileLock, writeJsonAtomic } from './json-ledger.mjs';
/** store 的版本号。结构变了就 +1，迁移代码按它决定怎么读老数据。 */
export const BOARD_STATE_VERSION = 1;

/** store 的文件名。 */
export const BOARD_STATE_FILE = 'board-state.json';

/**
 * 段 → 老文件。
 *
 * 只有**老文件在、store 里还没有这一段**时才会读它们（一次性迁移）。
 */
const LEGACY_FILES = {
  dispatches: 'dispatches.json',
  acks: 'acks.json',
  dismissed: 'dismissed.json',
  bossSession: 'boss-session.json',
  findings: 'patrol.json',
  answered: 'patrol-answered.json',
  archive: 'patrol-archive.json',
  config: 'patrol-config.json',
};

/** 每一段的形状。`array` 的段读出来永远是数组，其余按各自的形状归一。 */
const SECTION_SHAPES = {
  dispatches: 'array',
  acks: 'array',
  dismissed: 'array',
  findings: 'array',
  answered: 'array',
  bossSession: 'session',
  archive: 'archive',
  config: 'config',
};

/**
 * 读不出来的段，**记住它读不出来**，而不是把它当成空段。
 *
 * 一段账坏了，只有那一段坏：别的段照常读写。收口之前就是这样——派工账坏了不会让
 * 「代答」记不进去（那条路径写的是另一本账，坏的那本只影响它自己）。
 * 收口到一个文件之后，这个性质得**显式保住**，否则一份坏账会连累整个 store。
 *
 * 键是段名，值是「哪份老文件读不出来、报了什么」。
 */
const DAMAGED_KEY = 'damaged';

/**
 * 过渡期：老文件还写不写？
 *
 * **写。** 镜像是给**回退**用的：万一这套收口后来被否掉了，旧代码（它只读老文件）得读到
 * **最新的**数据，而不是迁移那一刻的快照。
 *
 * 镜像是**派生出来的，不是真相**——真相只有 store 一份，代码读的一直是 store。
 * 过渡期结束（收口被确认是对的方向）之后，用 `MIMIC_TEAR_MIRROR_LEGACY=off` 关掉它，
 * 老文件就只是历史快照。
 */
function mirrorEnabled() {
  return process.env.MIMIC_TEAR_MIRROR_LEGACY !== 'off';
}

/**
 * 把一段写回它的老文件。
 *
 * @param {string} dir
 * @param {string} name
 * @param {any} value
 * @returns {Promise<void>}
 */
async function writeLegacySection(dir, name, value) {
  const file = LEGACY_FILES[name];
  if (!file) return;
  await writeJsonAtomic(join(dir, file), value);
}

/**
 * @typedef {{
 *   version:number,
 *   updatedAt:number,
 *   dispatches:any[],
 *   acks:string[],
 *   dismissed:any[],
 *   bossSession:{sessionId:string, agent:string}|null,
 *   findings:any[],
 *   answered:any[],
 *   archive:{version:number, updatedAt:number, total:number, batches:any[]},
 *   config:any,
 * }} BoardState
 */

/**
 * 一段的值归一。
 *
 * 老文件里写坏形状的东西不是没有的事：空数组、缺字段的对象都出现过。归一让**读出来
 * 的形状永远一样**，写路径就不用到处判空。
 *
 * @param {string} name
 * @param {any} value
 * @returns {any}
 */
function normalizeSection(name, value) {
  const shape = SECTION_SHAPES[name] ?? 'array';
  if (shape === 'session') {
    if (!value) return null;
    // 早版本写的是裸字符串。
    if (typeof value === 'string') return { sessionId: value, agent: 'boss' };
    if (typeof value.sessionId !== 'string') return null;
    return { sessionId: value.sessionId, agent: typeof value.agent === 'string' ? value.agent : 'boss' };
  }
  if (shape === 'archive') {
    if (!value || typeof value !== 'object') {
      return { version: 1, updatedAt: 0, total: 0, batches: [] };
    }
    return {
      version: Number(value.version) || 1,
      updatedAt: Number(value.updatedAt) || 0,
      total: Number(value.total) || 0,
      batches: Array.isArray(value.batches) ? value.batches : [],
    };
  }
  if (shape === 'config') {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }
  return Array.isArray(value) ? value : [];
}

/**
 * 整个 store 的形状归一。
 *
 * @param {any} value
 * @returns {BoardState}
 */
function normalizeState(value) {
  const state = value && typeof value === 'object' ? value : {};
  const damaged = state[DAMAGED_KEY] && typeof state[DAMAGED_KEY] === 'object'
    ? { ...state[DAMAGED_KEY] }
    : {};
  return {
    version: Number(state.version) || BOARD_STATE_VERSION,
    updatedAt: Number(state.updatedAt) || 0,
    ...Object.fromEntries(
      Object.keys(SECTION_SHAPES).map((name) => [name, normalizeSection(name, state[name])]),
    ),
    [DAMAGED_KEY]: damaged,
  };
}

/**
 * 板面状态的单一 store。
 */
export class BoardStateStore {
  /**
   * @param {string} dataDir the board's data directory
   */
  constructor(dataDir) {
    this.dataDir = resolve(dataDir);
    this.path = join(this.dataDir, BOARD_STATE_FILE);
  }

  /**
   * 读整个 store。**不写盘**（除非需要一次性迁移或补齐新段）。
   *
   * @returns {Promise<BoardState>}
   */
  async read() {
    const value = await readJsonFile(this.path, null);
    if (!value || typeof value !== 'object') return this.#migrate();
    // store 在、但**新加的段还没有**（升级到更多段的机器）：把那些段从老文件补进来。
    const missing = Object.keys(SECTION_SHAPES).filter((name) => value[name] === undefined);
    if (!missing.length) return normalizeState(value);
    return this.#upgrade(value, missing);
  }

  /**
   * 把新加的段从老文件补进来。
   *
   * **在锁里做**，而且**在锁里再查一次**：另一个进程可能已经补好了。
   *
   * @param {any} raw
   * @param {string[]} missing
   * @returns {Promise<BoardState>}
   */
  async #upgrade(raw, missing) {
    return withFileLock(this.path, async () => {
      const value = await readJsonFile(this.path, null);
      if (!value || typeof value !== 'object') return this.#migrateLocked();
      const stillMissing = missing.filter((name) => value[name] === undefined);
      if (!stillMissing.length) return normalizeState(value);
      const next = { ...value };
      const damaged = { ...(value[DAMAGED_KEY] ?? {}) };
      for (const name of stillMissing) {
        try {
          const legacy = await readJsonFile(join(this.dataDir, LEGACY_FILES[name]), null);
          next[name] = normalizeSection(name, legacy);
        } catch (error) {
          damaged[name] = `${LEGACY_FILES[name]} 里的内容不是合法 JSON：${error?.message ?? error}`;
          next[name] = normalizeSection(name, null);
        }
      }
      next[DAMAGED_KEY] = damaged;
      next.version = BOARD_STATE_VERSION;
      next.updatedAt = Date.now();
      await writeJsonAtomic(this.path, next);
      return normalizeState(next);
    });
  }

  /**
   * 改一段。读-改-写整个 store，中间持锁。
   *
   * @param {(state:BoardState) => BoardState|Promise<BoardState>} mutate
   * @returns {Promise<BoardState>}
   */
  async update(mutate) {
    return withFileLock(this.path, async () => {
      const value = await readJsonFile(this.path, null);
      const current = value && typeof value === 'object'
        ? normalizeState(value)
        : await this.#migrateLocked();
      const next = normalizeState(await mutate({ ...current }));
      // 有一段读不出来的时候，**不许写那一段**：把它当成空账写下去，就是
      // 「记录明明在、读回来像没有」的老毛病。别的段照写（一条坏账只坏一段）。
      for (const [name, why] of Object.entries(next[DAMAGED_KEY] ?? {})) {
        if (next[name] !== current[name]) {
          throw new Error(`板面状态的「${name}」这一段读不出来（${why}）：不能当成空账写下去`);
        }
      }
      next.version = BOARD_STATE_VERSION;
      next.updatedAt = Date.now();
      await writeJsonAtomic(this.path, next);

      // 过渡期：把改动的那几段**镜像**回老文件（回退时老代码读它们）。
      // 镜像写失败**不影响**这次写：真相在 store，镜像只是给回退用的。
      if (mirrorEnabled()) {
        for (const name of Object.keys(SECTION_SHAPES)) {
          if (next[name] === current[name]) continue;
          await writeLegacySection(this.dataDir, name, next[name]).catch(() => undefined);
        }
      }
      return next;
    });
  }

  /**
   * 把 store 的内容**显式**写回老文件。
   *
   * 过渡期的保险：万一镜像写失败过、或者要回退，先跑一次这个，老文件就是齐的。
   * 回退是**显式动作**，不是自愈。
   *
   * @returns {Promise<{written:string[], failed:string[]}>}
   */
  async exportLegacy() {
    const state = await this.read();
    const written = [];
    const failed = [];
    for (const name of Object.keys(SECTION_SHAPES)) {
      try {
        await writeLegacySection(this.dataDir, name, state[name]);
        written.push(name);
      } catch {
        failed.push(name);
      }
    }
    return { written, failed };
  }

  /**
   * 读一段。
   *
   * @param {'dispatches'|'acks'|'dismissed'|'findings'|'answered'|'bossSession'|'archive'|'config'} name
   * @returns {Promise<any>}
   */
  async section(name) {
    const state = await this.read();
    const why = state[DAMAGED_KEY]?.[name];
    if (why) {
      throw new Error(`板面状态的「${name}」这一段读不出来（${why}）：不能当成空账`);
    }
    return state[name];
  }

  /**
   * 写一段。**整段替换**——调用方自己负责合并。
   *
   * @param {string} name
   * @param {any} value
   * @returns {Promise<any>}
   */
  async setSection(name, value) {
    const next = await this.update((state) => ({ ...state, [name]: value }));
    return next[name];
  }

  /**
   * 一次性迁移。**在锁里做**，而且在锁里再查一次 store 是不是已经被别人建好了。
   *
   * @returns {Promise<BoardState>}
   */
  async #migrate() {
    return withFileLock(this.path, async () => {
      const value = await readJsonFile(this.path, null);
      if (value && typeof value === 'object') return normalizeState(value);
      return this.#migrateLocked();
    });
  }

  /**
   * 真正搬数据的那一步。**必须在锁里调用**。
   *
   * 老文件坏了就**报错**，不当成「没有记录」——那是这个仓库的既有纪律：一份读不出来的
   * 账不是空账，报成空账会让一条明明存在的记录读回来像没有，然后被重投一次。
   *
   * @returns {Promise<BoardState>}
   */
  async #migrateLocked() {
    /** @type {any} */
    const state = { version: BOARD_STATE_VERSION, updatedAt: Date.now() };
    /** @type {Record<string,string>} */
    const damaged = {};
    for (const [name, file] of Object.entries(LEGACY_FILES)) {
      try {
        const value = await readJsonFile(join(this.dataDir, file), null);
        state[name] = normalizeSection(name, value);
      } catch (error) {
        // 这一段读不出来：**记住它读不出来**，而不是当成空段。
        // 一份坏账只坏它自己——别的段照常读写（收口之前就是这个性质）。
        damaged[name] = `${file} 里的内容不是合法 JSON：${error?.message ?? error}`;
        state[name] = normalizeSection(name, null);
      }
    }
    state[DAMAGED_KEY] = damaged;
    await writeJsonAtomic(this.path, state);
    return normalizeState(state);
  }}
