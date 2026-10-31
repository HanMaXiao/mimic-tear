import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const VERIFY_AGENT_NOTES = join(REPO_ROOT, 'scripts', 'verify-agent-notes.mjs');

/**
 * 建一个临时目录；测试结束时由调用方清理。
 * @param {string} [prefix] 目录名前缀
 * @returns {string} 临时目录绝对路径
 */
function tmpDir(prefix = 'mimic-agent-notes-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * 按相对路径清单写出一个目录。
 * @param {string} dir 目标目录
 * @param {Record<string, string>} files 相对路径 -> 内容
 * @returns {string} 目标目录
 */
function writeTree(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, ...rel.split('/'));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  return dir;
}

/**
 * 跑门禁脚本，拿到退出码与输出（脚本非零退出不算测试失败）。
 * @param {Record<string, string>} env 环境变量
 * @returns {Promise<{code: number, stdout: string, stderr: string}>} 运行结果
 */
async function runGate(env) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [VERIFY_AGENT_NOTES], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      windowsHide: true,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

/** 一份完全合规的 note。 */
const VALID_NOTE = [
  '# Agent Note: 一条合规的决策',
  '',
  'Status: implemented',
  '',
  '## 问题',
  '',
  '这里写动机。',
  '',
  '## 决策',
  '',
  '这里写决策。',
  '',
  '## 曾考虑的替代方案',
  '',
  '**别的做法。** 这里写它为什么输。',
  '',
  '## 后果',
  '',
  '这里写代价与收获。',
  '',
].join('\n');

/** 一棵合规的 notes 树。 */
const VALID_TREE = {
  'implemented/architecture/2026-11-01-a-decision.md': VALID_NOTE,
};

test('Agent Note 门禁：真实仓库的 notes 树通过', async () => {
  const result = await runGate({ MIMIC_TEAR_REPO_ROOT: REPO_ROOT });

  assert.equal(result.code, 0, `不该失败：\n${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /全部符合/);
  assert.match(result.stdout, /份 Agent Note/);
});

test('Agent Note 门禁：合规的样例树通过', async (t) => {
  const dir = tmpDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeTree(join(dir, 'notes'), VALID_TREE);

  const result = await runGate({
    MIMIC_TEAR_REPO_ROOT: dir,
    MIMIC_TEAR_NOTES_ROOT: join(dir, 'notes'),
  });

  assert.equal(result.code, 0, `不该失败：\n${result.stdout}${result.stderr}`);
});

test('Agent Note 门禁：结构与格式的每一条违规都要被拦下', async (t) => {
  const cases = [
    {
      name: '未知的生命周期目录',
      files: { ...VALID_TREE, 'drafts/2026-11-01-x.md': VALID_NOTE },
      expect: /未知的生命周期目录/,
    },
    {
      name: '集中的 INDEX.md',
      files: { ...VALID_TREE, 'INDEX.md': '# 索引\n' },
      expect: /不许有 INDEX\.md/,
    },
    {
      name: '文件名缺日期',
      files: { ...VALID_TREE, 'implemented/architecture/a-decision.md': VALID_NOTE },
      expect: /文件名必须是 yyyy-mm-dd-主题\.md/,
    },
    {
      name: '未知的分类目录',
      files: { ...VALID_TREE, 'implemented/misc/2026-11-01-x.md': VALID_NOTE },
      expect: /未知的分类目录/,
    },
    {
      name: 'Status 与所在目录不一致',
      files: {
        ...VALID_TREE,
        'implemented/architecture/2026-11-01-b.md': VALID_NOTE.replace('Status: implemented', 'Status: proposed'),
      },
      expect: /状态文法/,
    },
    {
      name: '第一个二级标题不是「## 问题」',
      files: {
        ...VALID_TREE,
        'implemented/architecture/2026-11-01-c.md': VALID_NOTE.replace('## 问题', '## 背景'),
      },
      expect: /第一个二级标题必须是「## 问题」/,
    },
    {
      name: '缺少必带小节',
      files: {
        ...VALID_TREE,
        'implemented/architecture/2026-11-01-d.md': VALID_NOTE.replace(/## 后果[\s\S]*$/, ''),
      },
      expect: /缺少必带小节「## 后果」/,
    },
    {
      name: '缺少「曾考虑的替代方案」',
      files: {
        ...VALID_TREE,
        'implemented/architecture/2026-11-01-e.md': VALID_NOTE.replace(/## 曾考虑的替代方案[\s\S]*?## 后果/, '## 后果'),
      },
      expect: /缺少「## 曾考虑的替代方案」/,
    },
    {
      name: 'implemented 里出现提案腔标题',
      files: {
        ...VALID_TREE,
        'implemented/architecture/2026-11-01-f.md': VALID_NOTE.replace('## 后果', '## 验收标准\n\n这里写验收。\n\n## 后果'),
      },
      expect: /提案腔标题/,
    },
    {
      name: 'Status 行出现两次',
      files: {
        ...VALID_TREE,
        'implemented/architecture/2026-11-01-g.md': `${VALID_NOTE}\nStatus: implemented\n`,
      },
      expect: /「Status:」行必须全文只出现一次/,
    },
    {
      name: '归档区缺 Archived 行',
      files: { ...VALID_TREE, 'archived/architecture/2026-11-01-h.md': VALID_NOTE },
      expect: /Archived: YYYY-MM-DD/,
    },
    {
      name: '生命周期根目录下放非白名单文件',
      files: { ...VALID_TREE, 'implemented/scratch.md': '# 随手写的\n' },
      expect: /生命周期根目录下只允许/,
    },
    {
      name: '决策记录不许有第二个家',
      files: VALID_TREE,
      extra: { 'docs/adr/2026-11-01-x.md': '# 又一个家\n' },
      expect: /决策记录只有一个家/,
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async (sub) => {
      const dir = tmpDir();
      sub.after(() => rmSync(dir, { recursive: true, force: true }));
      writeTree(join(dir, 'notes'), item.files);
      if (item.extra) writeTree(dir, item.extra);

      const result = await runGate({
        MIMIC_TEAR_REPO_ROOT: dir,
        MIMIC_TEAR_NOTES_ROOT: join(dir, 'notes'),
      });

      assert.equal(result.code, 1, `应该失败：\n${result.stdout}${result.stderr}`);
      assert.match(result.stdout, item.expect);
    });
  }
});

test('Agent Note 门禁：notes 目录不存在时按用法错误退出', async (t) => {
  const dir = tmpDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const result = await runGate({
    MIMIC_TEAR_REPO_ROOT: dir,
    MIMIC_TEAR_NOTES_ROOT: join(dir, 'not-there'),
  });

  assert.equal(result.code, 2, `应该是用法错误：\n${result.stdout}${result.stderr}`);
});
