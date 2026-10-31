/**
 * 「实质进展」的判据：区分「大哥没跑」与「大哥在跑但没进展」。
 *
 * ## 为什么需要这一层
 *
 * 文章 §6 的那句话是这一整层存在的理由：
 *
 * > 「许多异常并非进程崩溃，而是**模型在执行中陷入无效循环或偏离目标**。」
 *
 * 现有的看门狗只看**交班戳**：戳旧了就是 `stale`。但「大哥这一轮跑了三十分钟，
 * 一直在转、什么都没产出」——进程活着、心跳新鲜、戳也可能刚被刷过——现有判定**完全看不见**。
 *
 * ## 判据用确定性，不用模型
 *
 * 「有没有进展」必须能从运行时数据里**算出来**：消息数、状态、目标用量、后台任务数。
 * 用模型判会带来两个坏处：判据本身要花一次推理（而看门狗的判断必须在几秒内给出），
 * 而且同一个状态两次判可能不一样——**告警一旦不确定，就等于没有告警**。
 *
 * ## 三种进展
 *
 * - **产出增长**：会话的消息数变多了（它说了新的话 / 真的执行了）。
 * - **状态迁移**：会话状态变了（`started` → `idle`，或反过来）。
 * - **新产物**：目标用量涨了、后台任务多了一个。
 *
 * 任一发生都算有进展。**都不发生**、而会话又处于「在跑」状态，才叫 stuck。
 */

/**
 * 多久没进展就算卡住了。
 *
 * 它必须**明显长于一个值班轮次**（30 分钟），否则一轮正常的、比较慢的值班就会被误判成卡住。
 */
export const DEFAULT_STUCK_THRESHOLD_MS = 45 * 60_000;

/**
 * 会话「在跑」的判定。与运行时的对外口径一致：`started` = running。
 */
export const RUNNING_STATUS = 'started';

/**
 * 给一个会话拍一张「进展快照」。
 *
 * @param {{sessionId?:string, status?:string, messages?:number, at?:number}} input
 * @returns {{sessionId:string, status:string, messages:number, at:number}}
 */
export function snapshotProgress(input = {}) {
  return {
    sessionId: String(input.sessionId ?? ''),
    status: String(input.status ?? 'idle'),
    messages: Number.isFinite(Number(input.messages)) ? Number(input.messages) : 0,
    at: Number.isFinite(Number(input.at)) ? Number(input.at) : 0,
  };
}

/**
 * 两次快照之间有没有实质进展。
 *
 * @param {{sessionId?:string, status?:string, messages?:number}|null} previous
 * @param {{sessionId?:string, status?:string, messages?:number}} current
 * @returns {boolean}
 */
export function hasProgress(previous, current) {
  if (!previous || !current) return false;
  // 换了会话 = 换了对象，之前的进展不算数。
  if (previous.sessionId && current.sessionId && previous.sessionId !== current.sessionId) return true;
  if (current.messages > previous.messages) return true;
  if (current.status !== previous.status) return true;
  return false;
}

/**
 * 判「在跑但没进展」。
 *
 * @param {{
 *   previous?:{sessionId?:string,status?:string,messages?:number,lastProgressAt?:number}|null,
 *   current?:{sessionId?:string,status?:string,messages?:number}|null,
 *   now?:number,
 *   thresholdMs?:number,
 * }} input
 * @returns {{stuck:boolean, reason:string|null, minutes:number, lastProgressAt:number|null, sessionId:string|null}}
 */
export function decideStuck(input = {}) {
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const limit = Number.isFinite(Number(input.thresholdMs)) && Number(input.thresholdMs) > 0
    ? Number(input.thresholdMs)
    : DEFAULT_STUCK_THRESHOLD_MS;
  const current = input.current ?? null;
  const previous = input.previous ?? null;

  if (!current || !current.sessionId) {
    return { stuck: false, reason: null, minutes: 0, lastProgressAt: null, sessionId: null };
  }

  // 不在跑就没有「卡住」可言 —— 它要么交了班（那就由 stale 管），要么根本没启动。
  if (current.status !== RUNNING_STATUS) {
    return {
      stuck: false,
      reason: null,
      minutes: 0,
      lastProgressAt: previous?.lastProgressAt ?? now,
      sessionId: current.sessionId,
    };
  }

  // 第一次看见这个会话：没有基线，不能凭「没进展」就报卡住。
  if (!previous || previous.sessionId !== current.sessionId) {
    return {
      stuck: false,
      reason: null,
      minutes: 0,
      lastProgressAt: now,
      sessionId: current.sessionId,
    };
  }

  const progressed = hasProgress(previous, current);
  const lastProgressAt = progressed ? now : (previous.lastProgressAt ?? now);
  const minutes = Math.max(0, Math.floor((now - lastProgressAt) / 60_000));
  const stuck = (now - lastProgressAt) >= limit;

  return {
    stuck,
    reason: stuck ? 'no_progress' : null,
    minutes,
    lastProgressAt,
    sessionId: current.sessionId,
  };
}
