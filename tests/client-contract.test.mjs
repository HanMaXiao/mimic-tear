import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLIENT_DIR = fileURLToPath(new URL('../miniapps/mimic-tear/miniapp/client', import.meta.url));
const HTML = join(CLIENT_DIR, 'index.html');
const ASSETS_DIR = join(CLIENT_DIR, 'assets');
const ENTRY = join(ASSETS_DIR, 'app.js');

/** Characters that must never appear in the UI: emoji and pictographic symbols. */
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{1F000}-\u{1F0FF}]/u;

/**
 * Every file under a directory, relative to it.
 *
 * The client is split into modules and stylesheets, so the contract is asserted against
 * the whole tree instead of one file.
 *
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function filesUnder(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath ?? entry.path, entry.name)).split('\\').join('/'))
    .sort();
}

/**
 * Read every source file of a kind, keyed by its path relative to the assets directory.
 *
 * @param {string} dir
 * @param {string} extension
 * @returns {Promise<Record<string, string>>}
 */
async function readSources(dir, extension) {
  const sources = {};
  for (const file of await filesUnder(dir)) {
    if (!file.endsWith(extension)) continue;
    sources[file] = await readFile(join(dir, file), 'utf8');
  }
  return sources;
}

/**
 * All the sources of a kind, concatenated.
 *
 * @param {Record<string, string>} sources
 * @returns {string}
 */
function joined(sources) {
  return Object.values(sources).join('\n');
}

/**
 * The one source file that holds a marker.
 *
 * @param {Record<string, string>} sources
 * @param {string} marker
 * @returns {string}
 */
function sourceWith(sources, marker) {
  const hit = Object.entries(sources).find(([, source]) => source.includes(marker));
  assert.ok(hit, `客户端里找不到 ${marker}`);
  return hit[1];
}

/**
 * Split a stylesheet into its rules.
 *
 * @param {string} css
 * @returns {Array<{selector: string, body: string}>}
 */
function parseRules(css) {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    rules.push({ selector: match[1].trim(), body: match[2] });
  }
  return rules;
}

/**
 * The `--mcode-*` variables a theme selector defines.
 *
 * @param {Record<string, string>} cssSources
 * @param {'light'|'dark'} theme
 * @returns {Set<string>}
 */
function themeVarNames(cssSources, theme) {
  const names = new Set();
  for (const source of Object.values(cssSources)) {
    for (const rule of parseRules(source)) {
      const selectors = rule.selector.split(',').map((one) => one.trim());
      if (!selectors.includes(`[data-theme='${theme}']`)) continue;
      for (const name of rule.body.matchAll(/(--mcode-[a-z-]+)\s*:/g)) names.add(name[1]);
    }
  }
  return names;
}

/**
 * The `--mcode-*` variables the system dark mode defines.
 *
 * @param {Record<string, string>} cssSources
 * @returns {Set<string>}
 */
function systemDarkVarNames(cssSources) {
  const names = new Set();
  for (const source of Object.values(cssSources)) {
    const start = source.indexOf('@media (prefers-color-scheme: dark)');
    if (start === -1) continue;
    const rest = source.slice(start);
    const end = rest.indexOf('\n}');
    const block = end === -1 ? rest : rest.slice(0, end);
    for (const name of block.matchAll(/(--mcode-[a-z-]+)\s*:/g)) names.add(name[1]);
  }
  return names;
}

test('client-contract', async (t) => {
  const html = await readFile(HTML, 'utf8');
  const jsSources = await readSources(ASSETS_DIR, '.js');
  const cssSources = await readSources(ASSETS_DIR, '.css');
  const app = joined(jsSources);
  const css = joined(cssSources);

  await t.test('语义骨架完整', () => {
    for (const tag of ['<header', '<nav', '<main', '<section', '<h1', '<table', '<dialog']) {
      assert.ok(html.includes(tag), `缺少 ${tag}`);
    }
    assert.ok(html.includes('<th scope="col">'), '表头需要 scope');
    assert.ok(html.includes('<caption'), '表格需要 caption');
  });

  await t.test('六个视图容器都存在', () => {
    for (const id of ['view-chat', 'view-overview', 'view-inbox', 'view-project', 'view-skills', 'view-alerts']) {
      assert.ok(html.includes(`id="${id}"`), `缺少视图 ${id}`);
    }
  });

  await t.test('可访问性契约', () => {
    assert.ok(html.includes('role="status"'), '需要有 role="status"');
    assert.ok(html.includes('role="alert"'), '需要有 role="alert"');
    assert.ok(html.includes('aria-label="主导航"'), '导航需要 aria-label');
    assert.ok(html.includes('aria-label="刷新数据"'), '刷新按钮需要 aria-label');
    assert.ok(html.includes('aria-labelledby'), '区块需要 aria-labelledby');
    assert.ok(html.includes('aria-current'), '当前导航项需要 aria-current');
  });

  await t.test('四个 API 与 SSE 都被引用', () => {
    for (const path of ['/api/overview', '/api/inbox', '/api/projects', '/api/skills', '/api/stream']) {
      assert.ok(app.includes(path), `客户端未引用 ${path}`);
    }
    assert.ok(app.includes('/api/dispatch'), '客户端未引用派工接口');
  });

  await t.test('样式使用语义变量并支持浅深色与减少动效', () => {
    for (const variable of [
      '--mcode-bg',
      '--mcode-surface',
      '--mcode-text',
      '--mcode-text-muted',
      '--mcode-border',
      '--mcode-accent',
      '--mcode-danger',
      '--mcode-success',
      '--mcode-warning',
    ]) {
      assert.ok(css.includes(`${variable}:`), `缺少变量 ${variable}`);
    }
    assert.ok(css.includes('prefers-color-scheme'), '缺少 prefers-color-scheme');
    assert.ok(css.includes('prefers-reduced-motion'), '缺少 prefers-reduced-motion');
    assert.ok(css.includes('[data-theme=\'dark\']'), '缺少深色主题');
  });

  await t.test('圆角与描边符合基线', () => {
    assert.match(css, /\.panel\s*\{[^}]*border-radius:\s*12px/, '卡片应为 12px 圆角');
    assert.match(css, /\.btn\s*\{[^}]*border-radius:\s*8px/, '控件应为 8px 圆角');
    assert.match(css, /border:\s*1px solid var\(--mcode-border\)/, '描边应为 1px');
  });

  await t.test('深链直达项目时也能找到项目（总览未加载的兜底）', () => {
    assert.ok(app.includes('function findProject'), '缺少 findProject 兜底查找');
    assert.ok(app.includes('state.project.project'), '兜底应使用已加载的项目详情');
    assert.ok(app.includes('const overviewPromise = state.overview ?'), '任何路由都应加载总览');
  });

  await t.test('支持 /?project=N 深链（Host 的 open API 不接受 fragment）', () => {
    assert.ok(app.includes("get('project')"), '缺少 query 深链解析');
    assert.ok(app.includes('location.search'), '缺少 location.search 读取');
  });

  await t.test('重绘按内容签名守卫，避免 SSE 频繁重建 DOM', () => {
    assert.ok(app.includes('overviewChanged'), '缺少 overviewChanged 守卫');
    assert.ok(app.includes('inboxChanged'), '缺少 inboxChanged 守卫');
    assert.ok(app.includes('function overviewChanged'), '需要内容签名比较');
  });

  await t.test('等待时长用人类可读文案，不直接显示分钟数', () => {
    assert.ok(app.includes('waitingLabel'), '缺少 waitingLabel');
    assert.ok(!app.includes('等待 ${item.ageMinutes}'), '不应直接渲染分钟数');
    assert.ok(app.includes('等待 ${minutes} 分钟'), '短等待应显示分钟');
    assert.ok(app.includes('等待 ${Math.round(hours / 24)} 天'), '长等待应显示天数');
  });

  await t.test('横向溢出被约束，表格在容器内滚动', () => {
    assert.match(css, /\.table-scroll\s*\{[^}]*overflow-x:\s*auto/, '表格容器应可横向滚动');
    assert.match(css, /\.table-scroll\s*\{[^}]*max-width:\s*100%/, '表格容器不应撑破页面');
    assert.match(css, /\.panel\s*\{[^}]*min-width:\s*0/, '面板需要 min-width: 0 才能收缩');
    assert.match(css, /\.view\s*\{[^}]*min-width:\s*0/, '视图需要 min-width: 0 才能收缩');
  });

  await t.test('看板显示大哥值班状态', () => {
    assert.ok(html.includes('id="duty-status"'), '缺少值班状态位');
    assert.ok(app.includes('function renderDutyStatus'), '缺少 renderDutyStatus');
    assert.ok(app.includes('大哥值班中'), '缺少值班文案');
  });

  await t.test('主动巡检：界面有开关、有立即巡检、API 齐全', () => {
    assert.ok(html.includes('id="patrol-enabled"'), '缺少巡检开关');
    assert.ok(html.includes('id="patrol-run-button"'), '缺少立即巡检按钮');
    for (const path of ['/api/patrol', '/api/patrol/config', '/api/patrol/run']) {
      assert.ok(app.includes(path), `客户端未引用 ${path}`);
    }
    assert.ok(app.includes("patrol: '大哥巡检'"), '收件箱缺少巡检类型标签');
  });

  await t.test('自动派工开关整个消失——大哥自己判断该不该派工', () => {
    // 有没有派工不该由一个开关决定：它既管不了值班路径，也没法表达"这件事值得派"。
    assert.ok(
      !html.includes('patrol-autodispatch'),
      '不该再有自动派工开关——大哥自己判断',
    );
    assert.ok(!app.includes('patrol-autodispatch'), '客户端不该再读写自动派工开关');
    assert.ok(!app.includes('autoDispatch'), 'autoDispatch 这个概念不该再出现在客户端');
    // 剩下的那个开关说的是人话：大哥在不在岗。
    assert.ok(html.includes('大哥在岗'), '巡检开关应标明它管的是大哥在不在岗');
  });

  await t.test('浅色与深色主题定义同一套变量', () => {
    const lightVars = themeVarNames(cssSources, 'light');
    const darkVars = themeVarNames(cssSources, 'dark');
    const systemVars = systemDarkVarNames(cssSources);
    assert.ok(lightVars.size >= 15, `浅色变量过少：${lightVars.size}`);
    for (const name of lightVars) {
      assert.ok(darkVars.has(name), `深色主题缺少 ${name}`);
    }
    for (const name of darkVars) {
      assert.ok(lightVars.has(name), `浅色主题缺少 ${name}`);
    }
    // 系统深色模式走的是同一套变量，不能另起一套。
    for (const name of systemVars) {
      assert.ok(lightVars.has(name), `系统深色模式多出变量 ${name}`);
    }
    for (const name of lightVars) {
      assert.ok(systemVars.has(name), `系统深色模式缺少 ${name}`);
    }
  });

  await t.test('已封装技能库：面板、接口与渲染都在', () => {
    // The registry is a different thing from the capability scan, so it gets its own
    // section under the library rather than being folded into the domain list.
    assert.ok(html.includes('id="skill-library-list"'), '缺少已封装技能库列表容器');
    assert.ok(html.includes('id="skill-library-count"'), '缺少已封装技能库计数位');
    assert.ok(html.includes('已封装技能库'), '缺少已封装技能库标题');

    assert.ok(app.includes('/api/skill-library'), '客户端未引用技能库接口');
    assert.ok(app.includes('function renderSkillLibrary'), '缺少 renderSkillLibrary');
    assert.ok(app.includes('renderSkillLibrary();'), '技能库渲染没有被调用');

    // The ids the renderer reaches for must exist: a missing one makes `el()` return null
    // and the panel silently stays empty.
    for (const id of ['skill-library-list', 'skill-library-count']) {
      assert.ok(html.includes(`id="${id}"`), `客户端渲染用到的 ${id} 不在 HTML 里`);
    }

    // The four states of the registry must all be legible on the board.
    for (const label of ['待封装', '可派工', '已失效', '已退役']) {
      assert.ok(app.includes(label), `缺少状态文案 ${label}`);
    }
  });

  await t.test('看门狗告警：接口、视图容器与四态都在', () => {
    assert.ok(app.includes('/api/watchdog/alerts'), '客户端未引用告警日志接口');
    assert.ok(html.includes('id="view-alerts"'), '缺少告警视图容器');
    assert.ok(html.includes('aria-labelledby="alerts-title"'), '告警视图需要 aria-labelledby');
    assert.ok(html.includes('data-nav="alerts"'), '侧栏缺少告警入口');
    assert.ok(
      html.includes('<caption class="visually-hidden">看门狗告警日志</caption>'),
      '告警表需要用 caption 说明这张表是干什么的',
    );

    // The ids the renderer reaches for must exist: a missing one makes `el()` return null
    // and the panel silently stays empty.
    for (const id of ['alerts-body', 'alerts-count']) {
      assert.ok(html.includes(`id="${id}"`), `客户端渲染用到的 ${id} 不在 HTML 里`);
    }

    assert.ok(app.includes('function renderAlerts'), '缺少 renderAlerts');
    assert.ok(app.includes('function loadWatchdogAlerts'), '缺少 loadWatchdogAlerts');

    // The four states have to be legible on the board: loading, empty, error and full.
    assert.ok(app.includes('正在加载告警日志'), '缺少加载态');
    assert.ok(app.includes('看门狗还没有报过警'), '缺少空态');
    assert.ok(app.includes('告警日志读取失败'), '缺少错误态');

    // The three flips the watchdog can make, each in its own words.
    for (const [action, label] of [['stale', '掉线'], ['recovered', '归位'], ['missed', '漏轮']]) {
      assert.ok(app.includes(`${action}: '${label}'`), `缺少 ${action} 的文案`);
    }
    assert.ok(app.includes('已送达'), '缺少送达文案');
    assert.ok(app.includes('未送达'), '缺少未送达文案');
  });

  await t.test('派工状态恢复：读回记录，并与 SSE 用同一套渲染', () => {
    assert.ok(app.includes('/api/dispatch/'), '客户端未引用派工记录读取接口');
    assert.ok(app.includes('function restoreDispatch'), '缺少 restoreDispatch');
    assert.ok(app.includes('function normalizeDispatchOutcome'), '缺少派工结果归一化');
    assert.ok(app.includes('function renderDispatchOutcome'), '缺少派工结果渲染');

    // The live event and the restored record must go through the same renderer: a
    // dispatch that comes back after a reload may not look like a different thing.
    assert.match(
      sourceWith(jsSources, "addEventListener('dispatch'"),
      /addEventListener\('dispatch'[\s\S]{0,400}?renderDispatchOutcome\(/,
      'SSE 派工事件应走共用渲染',
    );
    assert.match(
      sourceWith(jsSources, 'async function restoreDispatch'),
      /async function restoreDispatch[\s\S]{0,2000}?renderDispatchOutcome\(/,
      '恢复路径应走共用渲染',
    );

    for (const text of ['指令已投递给目标会话', '派工未完成：', '指令仍在投递中']) {
      assert.ok(app.includes(text), `缺少派工文案 ${text}`);
    }
  });

  await t.test('没有远程资源引用', () => {
    const allowed = ['http://www.w3.org/2000/svg', 'http://127.0.0.1', 'http://localhost'];
    const sources = [
      ['index.html', html],
      ...Object.entries(jsSources).map(([name, source]) => [name, source]),
      ...Object.entries(cssSources).map(([name, source]) => [name, source]),
    ];
    for (const [name, content] of sources) {
      const matches = content.match(/https?:\/\/[^\s'"`)]+/g) ?? [];
      for (const match of matches) {
        assert.ok(
          allowed.some((prefix) => match.startsWith(prefix)),
          `${name} 引用了远程资源 ${match}`,
        );
      }
      assert.ok(!/@import\s+url/.test(content), `${name} 使用了 @import 远程样式`);
    }
  });

  await t.test('没有 emoji', () => {
    const sources = [
      ['index.html', html],
      ...Object.entries(jsSources).map(([name, source]) => [name, source]),
      ...Object.entries(cssSources).map(([name, source]) => [name, source]),
    ];
    for (const [name, content] of sources) {
      const found = content.match(EMOJI);
      assert.equal(found, null, `${name} 含有 emoji：${found}`);
    }
  });

  await t.test('不使用渐变与霓虹装饰', () => {
    assert.ok(!/linear-gradient|radial-gradient/i.test(css), '不允许渐变');
    assert.ok(!/box-shadow:[^;]*glow/i.test(css), '不允许发光阴影');
  });

  await t.test('客户端按视图拆成了原生 ES 模块，入口仍是 app.js', async () => {
    // 没有构建步骤：浏览器直接加载这些模块，所以入口必须还是那一个 script 标签。
    assert.ok(
      html.includes('<script type="module" src="/assets/app.js"></script>'),
      'index.html 仍应加载 /assets/app.js 作为模块入口',
    );

    const entry = await readFile(ENTRY, 'utf8');
    assert.ok(/^import\s/m.test(entry), '入口模块应当用 import 装配各模块');
    for (const folder of ['./shared/', './views/', './runtime/']) {
      assert.ok(entry.includes(folder), `入口模块没有引用 ${folder} 下的模块`);
    }

    // 没有孤立的模块文件：每个模块都要能被入口走到。
    const reachable = new Set();
    const queue = ['app.js'];
    while (queue.length) {
      const file = queue.shift();
      if (reachable.has(file)) continue;
      reachable.add(file);
      const source = jsSources[file];
      assert.ok(source, `模块 ${file} 不在 assets 目录里`);
      for (const match of source.matchAll(/from\s+'(\.[^']+)'/g)) {
        queue.push(relative(ASSETS_DIR, resolve(dirname(join(ASSETS_DIR, file)), match[1])).split('\\').join('/'));
      }
    }
    for (const file of Object.keys(jsSources)) {
      assert.ok(reachable.has(file), `模块 ${file} 没有任何人引用，是孤儿文件`);
    }
  });

  await t.test('样式表拆成多张，页面用多个 link 加载', async () => {
    const links = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((match) => match[1]);
    assert.ok(links.length >= 2, `样式表应当拆成多张，现在只有 ${links.length} 张`);
    for (const href of links) {
      assert.ok(href.startsWith('/assets/'), `样式表路径不对：${href}`);
      const path = join(CLIENT_DIR, href.slice(1));
      assert.ok(
        await stat(path).then(() => true, () => false),
        `样式表 ${href} 在磁盘上不存在`,
      );
    }
    for (const [name, source] of Object.entries(cssSources)) {
      assert.ok(!/@import/.test(source), `${name} 使用了 @import（会串行加载）`);
    }
  });
});
