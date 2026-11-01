/**
 * 一次只跑一个：上一轮还没跑完，这一轮就**跳过**。
 *
 * ## 为什么需要它
 *
 * 直通的投递要等负责 agent 那一轮跑完（可能好几分钟），而投递循环每 30 秒跳一次。
 * 两轮重叠起来会有两个后果：
 *
 * 1. **同一个事件被投两次**——「已投出」的账要等投递结束才记，重叠的那一轮看不到它。
 * 2. **建出两个负责会话**——负责会话是在投递时建的，上一轮还没写回订阅表，
 *    下一轮又建了一个（2026-11-01 方案 A 真机验收时真机撞出来的）。
 *
 * ## 跳过不是丢
 *
 * 被跳过的那一轮**不消费任何东西**：计划是每一轮重新算的，没投出去的事件还在，
 * 下一轮会重新计划到它。投递本身不推进水位线（那是值班交班戳的事）。
 */

/**
 * @returns {{busy:boolean, run:<T>(fn:()=>Promise<T>)=>Promise<{skipped:boolean, value:T|null}>}}
 */
export function createSingleFlight() {
  /** @type {boolean} */
  let inFlight = false;
  return {
    get busy() {
      return inFlight;
    },
    async run(fn) {
      if (inFlight) return { skipped: true, value: null };
      inFlight = true;
      try {
        return { skipped: false, value: await fn() };
      } finally {
        inFlight = false;
      }
    },
  };
}
