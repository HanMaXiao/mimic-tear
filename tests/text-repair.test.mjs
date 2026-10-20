import test from 'node:test';
import assert from 'node:assert/strict';

import { repairMojibake, buildVocabulary } from '../miniapps/mimic-tear/miniapp/node/text-repair.mjs';

const gbk = new TextDecoder('gbk', { fatal: false });
const toMojibake = (text) => gbk.decode(new TextEncoder().encode(text));

test('text-repair', async (t) => {
  await t.test('ASCII 文本原样返回', () => {
    const text = 'Tasks:\n  X V1.4-A: something [producing]  verify=on\n';
    assert.equal(repairMojibake(text), text);
  });

  await t.test('干净的中文文本不会被误改', () => {
    const text = 'V1.4-B1:LaunchCommand 运行时字段入库 + OperationType.System 持久化';
    assert.equal(repairMojibake(text), text, '干净文本必须原样返回');
  });

  await t.test('UTF-8 被当成 GBK 解码产生的乱码被还原', () => {
    const original = 'V1.4-A:LogRule 引擎 longest-match + record→class + 仓储';
    const mojibake = toMojibake(original);

    assert.notEqual(mojibake, original, 'fixture 自身应为乱码');
    const repaired = repairMojibake(mojibake);
    assert.equal(repaired, original);
  });

  await t.test('丢失的字节用同族干净文本的词表补回', () => {
    const original = '跨重启 PID 持久化';
    const mojibake = toMojibake(original);
    const vocabulary = buildVocabulary('DEHD V1.4 – 跨重启 PID 持久化 + LogRule 增强');

    const repaired = repairMojibake(mojibake, vocabulary);
    assert.ok(repaired.includes('跨重启'), `应补回 跨重启，实际为 ${repaired}`);
    assert.ok(repaired.includes('持久化'), `应补回 持久化，实际为 ${repaired}`);
  });

  await t.test('ASCII 上下文里的问号不被当成丢失的字节', () => {
    const original = 'ready? next line';
    const mojibake = toMojibake(original);
    const repaired = repairMojibake(mojibake);

    assert.ok(repaired.includes('?'), `问号应保留，实际为 ${repaired}`);
  });

  await t.test('修复结果始终是合法 UTF-8（无替换字符）', () => {
    const samples = [
      '跨重启 PID 持久化 + LogRule 增强',
      '自定义规则 UI + Service + 持久化 + 通知',
      '全栈 build + test + 收口报告',
      '混合 ASCII 与 中文 的 文本',
    ];

    for (const original of samples) {
      const repaired = repairMojibake(toMojibake(original));
      assert.ok(!repaired.includes('\ufffd'), `不应残留替换字符：${repaired}`);
      assert.equal(Buffer.from(repaired, 'utf8').toString('utf8'), repaired);
    }
  });

  await t.test('空值安全', () => {
    assert.equal(repairMojibake(''), '');
    assert.equal(repairMojibake(null), null);
    assert.equal(repairMojibake(undefined), undefined);
  });
});
