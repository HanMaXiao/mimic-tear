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
const SCRIPTS = join(REPO_ROOT, 'scripts');
const CHECK_PACKAGE = join(SCRIPTS, 'check-package.mjs');
const CHECK_PUBLISHED = join(SCRIPTS, 'check-published.mjs');
const CHECK_STYLE = join(SCRIPTS, 'check-style.mjs');
const INSTALL_HOOKS = join(SCRIPTS, 'install-hooks.mjs');
const CLIENT_CONTRACT_TEST = join(REPO_ROOT, 'tests', 'client-contract.test.mjs');

/** 一个干净的包：零依赖、无 console、无 TODO、无 emoji。 */
const CLEAN_FILES = {
  'package.json': '{\n  "mcode": {\n    "schemaVersion": 2,\n    "miniApp": "./miniapp/miniapp.json"\n  }\n}\n',
  'miniapp/miniapp.json': '{\n  "name": "mimic-tear"\n}\n',
  'miniapp/node/server.mjs':
    "import { readFile } from 'node:fs/promises';\nimport { join } from 'node:path';\n\nexport const load = async (p) => readFile(join('.', p), 'utf8');\n",
  'miniapp/node/peer.mjs': "import { load } from './server.mjs';\n\nexport const peer = load;\n",
  'miniapp/client/index.html': '<!doctype html>\n<html><head><title>mimic-tear</title></head><body></body></html>\n',
  'miniapp/client/assets/app.js': "const root = document.getElementById('app');\n",
  'miniapp/client/assets/styles.css': 'body {\n  color: #333;\n}\n',
};

/**
 * 建一个临时目录；测试结束时由调用方清理。
 * @param {string} [prefix] 目录名前缀
 * @returns {string} 临时目录绝对路径
 */
function tmpDir(prefix = 'mimic-packaging-') {
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
 * 跑一个守卫脚本，拿到退出码与输出（脚本非零退出不算测试失败）。
 * @param {string} script 脚本绝对路径
 * @param {string[]} [args] 传给脚本的参数
 * @param {Record<string, string>} [env] 追加的环境变量
 * @returns {Promise<{code: number, stdout: string, stderr: string}>} 运行结果
 */
async function runScript(script, args = [], env = {}) {
  const base = { ...process.env };
  delete base.MIMIC_TEAR_STRICT_BYTES;
  delete base.MIMIC_TEAR_COMMIT_SCOPE;
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [script, ...args], {
      env: { ...base, ...env },
      encoding: 'utf8',
      windowsHide: true,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

test('打包守卫：干净的包通过', async (t) => {
  const dir = tmpDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeTree(join(dir, 'pkg'), CLEAN_FILES);

  const result = await runScript(CHECK_PACKAGE, [], { MIMIC_TEAR_PACKAGE_DIR: join(dir, 'pkg') });

  assert.equal(result.code, 0, `不该失败：\n${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /零 node_modules/);
});

test('打包守卫：node_modules / lockfile / 第三方 import / 本机路径 都要被拦下', async (t) => {
  const cases = [
    {
      name: 'node_modules',
      files: { ...CLEAN_FILES, 'node_modules/lodash/index.js': 'module.exports = {};\n' },
      expect: /node_modules/,
    },
    {
      name: 'lockfile',
      files: { ...CLEAN_FILES, 'package-lock.json': '{ "lockfileVersion": 3 }\n' },
      expect: /lockfile/,
    },
    {
      name: '第三方 import',
      files: {
        ...CLEAN_FILES,
        'miniapp/node/uses-dep.mjs': "import { get } from 'lodash';\n\nexport const x = get;\n",
      },
      expect: /第三方模块/,
    },
    {
      name: '本机绝对路径',
      files: {
        ...CLEAN_FILES,
        'miniapp/node/paths.mjs': "export const ROOT = 'D:/Project/AppProject/Mimic Tear';\n",
      },
      expect: /本机绝对路径/,
    },
    {
      name: 'package.json 声明依赖',
      files: {
        ...CLEAN_FILES,
        'package.json': '{\n  "dependencies": {\n    "lodash": "^4.0.0"\n  }\n}\n',
      },
      expect: /dependencies/,
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async (sub) => {
      const dir = tmpDir();
      sub.after(() => rmSync(dir, { recursive: true, force: true }));
      writeTree(join(dir, 'pkg'), item.files);

      const result = await runScript(CHECK_PACKAGE, [], { MIMIC_TEAR_PACKAGE_DIR: join(dir, 'pkg') });

      assert.equal(result.code, 1, `应该失败：\n${result.stdout}${result.stderr}`);
      assert.match(result.stdout, item.expect);
    });
  }
});

test('打包守卫：node: 内置模块、相对路径、Windows 系统目录都不算违规', async (t) => {
  const dir = tmpDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeTree(join(dir, 'pkg'), {
    ...CLEAN_FILES,
    'miniapp/node/ok.mjs':
      "import { readFileSync } from 'node:fs';\n" +
      "import { helper } from './server.mjs';\n" +
      "import { other } from '../peer.mjs';\n" +
      "export const x = [readFileSync, helper, other];\n",
    'miniapp/node/system-path.mjs':
      "export const WSCRIPT = process.env.SystemRoot ?? 'C:\\\\Windows';\n",
    'miniapp/node/prose.mjs':
      '/**\n * A fresh state — no baseline yet.\n *\n * `notifiedStale: null` means "the user has not been told anything yet", which is\n * different from "we told them it is fine".\n */\n' +
      'export const nothing = null;\n',
    'miniapp/client/index.html':
      '<!doctype html>\n<html><head><title>https://example.com/docs</title></head><body></body></html>\n',
  });

  const result = await runScript(CHECK_PACKAGE, [], { MIMIC_TEAR_PACKAGE_DIR: join(dir, 'pkg') });

  assert.equal(result.code, 0, `不该失败：\n${result.stdout}${result.stderr}`);
});

test('发布漂移守卫：两侧一致时通过', async (t) => {
  const dir = tmpDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeTree(join(dir, 'pkg'), CLEAN_FILES);
  writeTree(join(dir, 'published'), CLEAN_FILES);

  const result = await runScript(CHECK_PUBLISHED, [], {
    MIMIC_TEAR_PACKAGE_DIR: join(dir, 'pkg'),
    MIMIC_TEAR_PUBLISHED_DIR: join(dir, 'published'),
  });

  assert.equal(result.code, 0, `不该失败：\n${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /没有漂移/);
});

test('发布漂移守卫：内容不同、多出文件、少了文件都要被拦下', async (t) => {
  const cases = [
    {
      name: '内容不同',
      repo: { ...CLEAN_FILES },
      published: { ...CLEAN_FILES, 'miniapp/client/index.html': '<!doctype html>\n<html><body>旧版</body></html>\n' },
      expect: /miniapp\/client\/index\.html/,
    },
    {
      name: '发布副本少了文件',
      repo: { ...CLEAN_FILES },
      published: { ...CLEAN_FILES },
      dropFromPublished: ['miniapp/node/server.mjs'],
      expect: /仅在仓库中存在/,
    },
    {
      name: '发布副本多了文件',
      repo: { ...CLEAN_FILES },
      published: { ...CLEAN_FILES, 'miniapp/node/leftover.mjs': 'export const old = 1;\n' },
      expect: /仅在已发布副本中存在/,
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async (sub) => {
      const dir = tmpDir();
      sub.after(() => rmSync(dir, { recursive: true, force: true }));
      writeTree(join(dir, 'pkg'), item.repo);
      const published = { ...item.published };
      for (const drop of item.dropFromPublished ?? []) delete published[drop];
      writeTree(join(dir, 'published'), published);

      const result = await runScript(CHECK_PUBLISHED, [], {
        MIMIC_TEAR_PACKAGE_DIR: join(dir, 'pkg'),
        MIMIC_TEAR_PUBLISHED_DIR: join(dir, 'published'),
      });

      assert.equal(result.code, 1, `应该失败：\n${result.stdout}${result.stderr}`);
      assert.match(result.stdout, item.expect);
    });
  }
});

test('发布漂移守卫：没有已发布副本时打印 SKIPPED 并放行', async (t) => {
  const dir = tmpDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeTree(join(dir, 'pkg'), CLEAN_FILES);

  const result = await runScript(CHECK_PUBLISHED, [], {
    MIMIC_TEAR_PACKAGE_DIR: join(dir, 'pkg'),
    MIMIC_TEAR_PUBLISHED_DIR: join(dir, 'not-installed'),
  });

  assert.equal(result.code, 0, `不该失败：\n${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /SKIPPED/);
});

test('发布漂移守卫：仅行尾差异算警告，不算漂移', async (t) => {
  const dir = tmpDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeTree(join(dir, 'pkg'), CLEAN_FILES);
  writeTree(join(dir, 'published'), {
    ...CLEAN_FILES,
    'miniapp/node/server.mjs': CLEAN_FILES['miniapp/node/server.mjs'].replace(/\n/g, '\r\n'),
  });

  const relaxed = await runScript(CHECK_PUBLISHED, [], {
    MIMIC_TEAR_PACKAGE_DIR: join(dir, 'pkg'),
    MIMIC_TEAR_PUBLISHED_DIR: join(dir, 'published'),
  });
  assert.equal(relaxed.code, 0, `仅行尾差异不该判为漂移：\n${relaxed.stdout}`);
  assert.match(relaxed.stdout, /仅行尾差异/);

  const strict = await runScript(CHECK_PUBLISHED, [], {
    MIMIC_TEAR_PACKAGE_DIR: join(dir, 'pkg'),
    MIMIC_TEAR_PUBLISHED_DIR: join(dir, 'published'),
    MIMIC_TEAR_STRICT_BYTES: '1',
  });
  assert.equal(strict.code, 1, '严格字节模式下仅行尾差异也要失败');
});

test('风格守卫：干净的包通过', async (t) => {
  const dir = tmpDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeTree(join(dir, 'pkg'), CLEAN_FILES);

  const result = await runScript(CHECK_STYLE, [], {
    MIMIC_TEAR_PACKAGE_DIR: join(dir, 'pkg'),
    MIMIC_TEAR_CLIENT_CONTRACT_TEST: CLIENT_CONTRACT_TEST,
  });

  assert.equal(result.code, 0, `不该失败：\n${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /没有 emoji/);
});

test('风格守卫：console 调用、遗留 TODO、客户端 emoji 都要被拦下', async (t) => {
  const cases = [
    {
      name: '运行时里的 console.log',
      files: { ...CLEAN_FILES, 'miniapp/node/noisy.mjs': "console.log('hello');\n" },
      expect: /console\.log/,
    },
    {
      name: '运行时里的 console.error',
      files: { ...CLEAN_FILES, 'miniapp/node/noisy.mjs': "console.error('boom');\n" },
      expect: /console\.error/,
    },
    {
      name: '遗留的 TODO',
      files: { ...CLEAN_FILES, 'miniapp/node/pending.mjs': '// TODO: 以后再收拾这里\nexport const a = 1;\n' },
      expect: /TODO/,
    },
    {
      name: '客户端里的 emoji',
      files: { ...CLEAN_FILES, 'miniapp/client/assets/app.js': "const tip = '🚨 出事了';\n" },
      expect: /emoji/,
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async (sub) => {
      const dir = tmpDir();
      sub.after(() => rmSync(dir, { recursive: true, force: true }));
      writeTree(join(dir, 'pkg'), item.files);

      const result = await runScript(CHECK_STYLE, [], {
        MIMIC_TEAR_PACKAGE_DIR: join(dir, 'pkg'),
        MIMIC_TEAR_CLIENT_CONTRACT_TEST: CLIENT_CONTRACT_TEST,
      });

      assert.equal(result.code, 1, `应该失败：\n${result.stdout}${result.stderr}`);
      assert.match(result.stdout, item.expect);
    });
  }
});

test('风格守卫：emoji 的检测正则确实取自客户端契约测试', async (t) => {
  const dir = tmpDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeTree(join(dir, 'pkg'), CLEAN_FILES);

  const result = await runScript(CHECK_STYLE, [], {
    MIMIC_TEAR_PACKAGE_DIR: join(dir, 'pkg'),
    MIMIC_TEAR_CLIENT_CONTRACT_TEST: CLIENT_CONTRACT_TEST,
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /client-contract\.test\.mjs/);
});

test('提交守卫：自测四个场景全过', async () => {
  const result = await runScript(INSTALL_HOOKS, ['--self-test'], {});

  assert.equal(result.code, 0, `自测没过：\n${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /自测全部通过/);
});
