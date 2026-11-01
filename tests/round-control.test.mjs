import test from 'node:test';
import assert from 'node:assert/strict';

import { RoundControl, resolveWhenBusy } from '../miniapps/mimic-tear/miniapp/node/round-control.mjs';

/**
 * 一个永远不会自己结束的轮次，直到它被叫停。
 *
 * @param {{signal: AbortSignal}} ctx
 * @returns {Promise<{status:string}>}
 */
function waitForAbort(ctx) {
  return new Promise((resolve) => {
    if (ctx.signal.aborted) {
      resolve({ status: 'aborted' });
      return;
    }
    ctx.signal.addEventListener('abort', () => resolve({ status: 'aborted' }), { once: true });
  });
}

test('whenBusy 策略：只有「在跑的全是巡检轮次」才插话', () => {
  assert.equal(resolveWhenBusy([]), undefined, '没人跑 = 不用传 whenBusy');
  assert.equal(resolveWhenBusy(null), undefined, '没人跑 = 不用传 whenBusy');
  assert.equal(resolveWhenBusy(['patrol']), 'steer', '巡检轮次只读事实，插话安全');
  assert.equal(resolveWhenBusy(['patrol', 'patrol']), 'steer', '全是巡检轮次 = 插话');
  assert.equal(resolveWhenBusy(['chat']), 'queue', '对话可能在改文件 = 排队');
  assert.equal(resolveWhenBusy(['dispatch']), 'queue', '派工可能在改文件 = 排队');
  assert.equal(resolveWhenBusy(['patrol', 'chat']), 'queue', '混着一轮可能改文件的 = 排队');
});

test('start：轮次是后台的，返回句柄，不等它跑完', async () => {
  const control = new RoundControl();
  let finished = false;

  const started = control.start({
    kind: 'patrol',
    slot: 'board-patrol',
    sessionId: 'sess-1',
    run: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      finished = true;
      return { findings: 2 };
    },
  });

  assert.equal(started.status, 'running', '起完就是 running');
  assert.equal(started.skipped, false, '第一个不是跳过的');
  assert.equal(finished, false, 'start 不等它跑完');

  const settled = await started.promise;
  assert.equal(settled.status, 'finished', '跑完了');
  assert.equal(settled.result.findings, 2, '跑完的产出拿得到');
  assert.equal(finished, true);
});

test('stop：叫停一轮，轮次落成 aborted 而不是消失', async () => {
  const control = new RoundControl();
  const started = control.start({
    kind: 'patrol',
    slot: 'board-patrol',
    sessionId: 'sess-1',
    run: (signal, ctx) => waitForAbort({ signal }),
  });

  const stopped = control.stop(started.id);
  assert.equal(stopped.stopped, true, '叫停成功');
  assert.equal(stopped.reason, 'aborted');

  const settled = await started.promise;
  assert.equal(settled.status, 'aborted', '被叫停的轮次是 aborted');
  assert.equal(control.get(started.id).status, 'aborted', '状态留痕，不是静默消失');
  assert.ok(control.get(started.id).endedAt, '结束时间记下来了');
});

test('stop：叫停一个不存在的轮次 / 一个已经跑完的轮次，都不动手', async () => {
  const control = new RoundControl();

  const missing = control.stop('rnd_没有');
  assert.equal(missing.stopped, false);
  assert.equal(missing.reason, 'not_found');

  const started = control.start({
    kind: 'chat',
    sessionId: 'sess-1',
    run: async () => ({ status: 'finished' }),
  });
  await started.promise;

  const finished = control.stop(started.id);
  assert.equal(finished.stopped, false, '已经跑完的轮次停不了');
  assert.equal(finished.reason, 'not_running');
  assert.equal(finished.status, 'finished');
});

test('slot：同一个槽位上已经有在跑的，第二轮直接跳过', async () => {
  const control = new RoundControl();
  const first = control.start({
    kind: 'patrol',
    slot: 'board-patrol',
    sessionId: 'sess-1',
    run: (signal, ctx) => waitForAbort({ signal }),
  });

  let secondRan = false;
  const second = control.start({
    kind: 'patrol',
    slot: 'board-patrol',
    sessionId: 'sess-1',
    run: async () => { secondRan = true; return { findings: 99 }; },
  });

  assert.equal(second.skipped, true, '第二轮被跳过');
  assert.equal(second.reason, 'slot_busy');
  assert.equal(second.id, first.id, '跳过时指向正在跑的那一轮');
  assert.equal(secondRan, false, '被跳过的那一轮不会跑出结论');

  control.stop(first.id);
  await first.promise;

  // 跑完之后，同一个槽位可以再起。
  const third = control.start({
    kind: 'patrol',
    slot: 'board-patrol',
    sessionId: 'sess-1',
    run: async () => ({ findings: 1 }),
  });
  assert.equal(third.skipped, false, '跑完之后槽位空出来了');
  await third.promise;
});

test('activeForSession：会话上在跑的轮次能被查到，跑完就没了', async () => {
  const control = new RoundControl();
  const started = control.start({
    kind: 'patrol',
    sessionId: 'sess-1',
    run: (signal, ctx) => waitForAbort({ signal }),
  });

  const active = control.activeForSession('sess-1');
  assert.equal(active.length, 1, '查得到在跑的那一轮');
  assert.equal(active[0].kind, 'patrol');
  assert.equal(control.activeForSession('别的会话').length, 0, '别的会话上没有人跑');

  control.stop(started.id);
  await started.promise;
  assert.equal(control.activeForSession('sess-1').length, 0, '跑完就不在了');
});

test('attach：插话进这一轮的对话，也能收到这一轮的事件', async () => {
  const control = new RoundControl();
  const seen = [];
  const started = control.start({
    kind: 'patrol',
    sessionId: 'sess-1',
    run: async (signal, { onEvent }) => {
      // 插话是在轮次跑起来之后才挂上来的，所以事件要晚一点发——
      // 这正是「插话进正在跑的那一轮」的真实时序。
      await new Promise((resolve) => setTimeout(resolve, 5));
      onEvent({ type: 'text.delta', text: '巡检' });
      return { findings: 1 };
    },
  });

  control.attach(started.id, (event) => seen.push(event));
  await started.promise;

  assert.equal(seen.length, 1, '挂上去的监听者收到了事件');
  assert.equal(seen[0].text, '巡检');
});

test('宿主用 status=aborted 表达叫停时，轮次也记 aborted', async () => {
  const control = new RoundControl();
  const started = control.start({
    kind: 'patrol',
    sessionId: 'sess-1',
    run: async () => ({ status: 'aborted', error: '这一轮被叫停了。' }),
  });

  const settled = await started.promise;
  assert.equal(settled.status, 'aborted');
  assert.equal(control.get(started.id).status, 'aborted');
});

test('跑挂了：轮次记 error，promise 不往外抛', async () => {
  const control = new RoundControl();
  const started = control.start({
    kind: 'chat',
    sessionId: 'sess-1',
    run: async () => { throw new Error('宿主说会话忙'); },
  });

  const settled = await started.promise;
  assert.equal(settled.status, 'error');
  assert.equal(settled.error, '宿主说会话忙', '失败原因留痕');
  assert.equal(control.get(started.id).status, 'error');
});

test('list：最新的在前', async () => {
  const control = new RoundControl();
  const first = control.start({ kind: 'chat', sessionId: 's1', run: async () => ({ n: 1 }) });
  await first.promise;
  const second = control.start({ kind: 'chat', sessionId: 's1', run: async () => ({ n: 2 }) });
  await second.promise;

  const list = control.list();
  assert.equal(list[0].id, second.id, '最新的在前');
  assert.equal(list.length, 2);
});
