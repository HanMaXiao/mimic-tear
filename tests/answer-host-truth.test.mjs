import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { ManagedProjects } from '../miniapps/mimic-tear/miniapp/node/managed-projects.mjs';
import { PatrolStore } from '../miniapps/mimic-tear/miniapp/node/patrol-store.mjs';
import { makeRuntimeDb, tmpDir, cleanupDir } from './helpers/fixture.mjs';

const CLI = fileURLToPath(new URL('../miniapps/mimic-tear/miniapp/node/patrol-cli.mjs', import.meta.url));
const NODE = process.execPath;

/**
 * 跑一次 CLI，把 stdout 解析成 JSON。
 *
 * @param {string[]} args
 * @returns {any}
 */
function runCli(args) {
  const output = execFileSync(NODE, [CLI, ...args], { encoding: 'utf8' });
  return JSON.parse(output.replace(/^\uFEFF+/, ''));
}

/**
 * 这组测试守的是**「代答」这个词**。
 *
 * 2026-11-01 13:07 那一轮值班，大哥查出：`patrol-cli answer` 只写板面账，不调宿主
 * `agent.answer`——宿主卡照样 `status='pending'`、会话照样卡着，但账上写着「已答」。
 * 后果有两处，两处都坏：
 *
 *  1. **假成功**：命令回 `ok: true`，看起来像卡被答了，其实没翻。
 *  2. **假闭眼**：大哥记完建议，那张卡就从 `facts` 的待答清单里消失了——
 *     而宿主那边它还开着、那个会话还卡着。于是「卡着的会话」从此没人再管。
 *
 * 所以这里断言的是**两个词各自只管一件事**：
 * 「宿主卡开没开」归运行时，「大哥给没给建议」归板面账。
 */

test('宿主卡还开着：answer 必须说清它没翻转宿主卡', async () => {
  const dir = tmpDir();
  try {
    const dataDir = `${dir}/data`;
    const dbPath = makeRuntimeDb(dir);

    // ask-1 是 fixture 里唯一 status='pending' 的卡。
    const payload = runCli([
      'answer',
      'ask-1',
      '--answer',
      '是',
      '--rationale',
      '明天开工更省事',
      '--session-id',
      'sess-alpha-lead',
      '--data-dir',
      dataDir,
      '--db',
      dbPath,
    ]);

    assert.equal(payload.hostStatus, 'pending', '宿主状态必须照实报出来');
    assert.equal(payload.awaitingUser, true, '宿主卡还开着 = 还在等大老板');
    assert.ok(
      String(payload.note ?? '').includes('没有翻转宿主卡'),
      `没翻卡这件事必须写在输出里（实际 note：${payload.note ?? '（空）'}）`,
    );
  } finally {
    cleanupDir(dir);
  }
});

test('宿主卡已经翻了：answer 不得再声称在等大老板', async () => {
  const dir = tmpDir();
  try {
    const dataDir = `${dir}/data`;
    const dbPath = makeRuntimeDb(dir);

    // ask-2 是 fixture 里 status='answered' 的卡。
    const payload = runCli([
      'answer',
      'ask-2',
      '--answer',
      '否',
      '--data-dir',
      dataDir,
      '--db',
      dbPath,
    ]);

    assert.equal(payload.hostStatus, 'answered');
    assert.equal(payload.awaitingUser, false, '宿主已经收了这张卡，不该再算「等大老板」');
    assert.equal(payload.note, null, '没什么要提醒的就不该有 note');
  } finally {
    cleanupDir(dir);
  }
});

test('给一张查无此卡的记一笔 = 造假账：必须拒绝入账', async () => {
  const dir = tmpDir();
  try {
    const dataDir = `${dir}/data`;
    const dbPath = makeRuntimeDb(dir);

    let failed = false;
    try {
      runCli([
        'answer',
        'ask-does-not-exist',
        '--answer',
        '是',
        '--data-dir',
        dataDir,
        '--db',
        dbPath,
      ]);
    } catch (error) {
      failed = true;
      assert.notEqual(error.status, 0, '这条必须以非零退出码失败');
    }
    assert.ok(failed, '给不存在的卡记账必须失败，不能静默成功');

    const patrol = new PatrolStore(dataDir);
    const recorded = await patrol.listAnswered();
    assert.equal(
      recorded.length,
      0,
      '没入账就是没入账——账上不能多一条谁也查不到底的「已答」',
    );
  } finally {
    cleanupDir(dir);
  }
});

test('大哥给过建议的卡，仍然留在待答清单里，并带上这条建议', async () => {
  const dir = tmpDir();
  try {
    const dataDir = `${dir}/data`;
    const dbPath = makeRuntimeDb(dir);

    // 管辖名单：alpha 不在名单里，项目与卡都会按管辖闸被筛掉。
    await new ManagedProjects(dataDir).add('alpha', '大老板点名要盯这个');

    runCli([
      'answer',
      'ask-1',
      '--answer',
      '是',
      '--rationale',
      '明天开工更省事',
      '--data-dir',
      dataDir,
      '--db',
      dbPath,
    ]);

    const facts = runCli(['facts', '--data-dir', dataDir, '--db', dbPath]);
    const card = (facts.openQuestionnaires ?? []).find((item) => item.requestId === 'ask-1');

    assert.ok(
      card,
      '宿主还开着的卡必须继续出现在待答清单里——它一消失，那个卡着的会话就没人再管了',
    );
    assert.equal(
      card.bossSuggestion?.answer,
      '是',
      '建议要跟着卡一起出现：大哥得看见「这张我已经表过态」',
    );
  } finally {
    cleanupDir(dir);
  }
});

test('已答账要带上宿主状态：哪张还卡着，一眼看得出来', async () => {
  const dir = tmpDir();
  try {
    const dataDir = `${dir}/data`;
    const dbPath = makeRuntimeDb(dir);

    await new ManagedProjects(dataDir).add('alpha', '大老板点名要盯这个');
    runCli([
      'answer',
      'ask-1',
      '--answer',
      '是',
      '--data-dir',
      dataDir,
      '--db',
      dbPath,
    ]);

    const facts = runCli(['facts', '--data-dir', dataDir, '--db', dbPath]);
    const entry = (facts.alreadyAnswered ?? []).find((item) => item.requestId === 'ask-1');

    assert.ok(entry, '账上要能查到这条建议');
    assert.equal(entry.hostStatus, 'pending');
    assert.equal(entry.awaitingUser, true, '记了建议 ≠ 卡翻了');
  } finally {
    cleanupDir(dir);
  }
});
