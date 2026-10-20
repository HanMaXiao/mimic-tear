import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const CLIENT_DIR = 'D:/Project/AppProject/Mimic Tear/miniapps/mimic-tear/miniapp/client';
const HTML = join(CLIENT_DIR, 'index.html');
const APP = join(CLIENT_DIR, 'assets', 'app.js');
const CSS = join(CLIENT_DIR, 'assets', 'styles.css');

/** Characters that must never appear in the UI: emoji and pictographic symbols. */
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{1F000}-\u{1F0FF}]/u;

test('client-contract', async (t) => {
  const html = await readFile(HTML, 'utf8');
  const app = await readFile(APP, 'utf8');
  const css = await readFile(CSS, 'utf8');

  await t.test('语义骨架完整', () => {
    for (const tag of ['<header', '<nav', '<main', '<section', '<h1', '<table', '<dialog']) {
      assert.ok(html.includes(tag), `缺少 ${tag}`);
    }
    assert.ok(html.includes('<th scope="col">'), '表头需要 scope');
    assert.ok(html.includes('<caption'), '表格需要 caption');
  });

  await t.test('四个视图容器都存在', () => {
    for (const id of ['view-overview', 'view-inbox', 'view-project', 'view-skills']) {
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
      assert.ok(app.includes(path), `app.js 未引用 ${path}`);
    }
    assert.ok(app.includes('/api/dispatch'), 'app.js 未引用派工接口');
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

  await t.test('没有远程资源引用', () => {
    const allowed = ['http://www.w3.org/2000/svg', 'http://127.0.0.1', 'http://localhost'];
    for (const [name, content] of [['index.html', html], ['app.js', app], ['styles.css', css]]) {
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
    for (const [name, content] of [['index.html', html], ['app.js', app], ['styles.css', css]]) {
      const found = content.match(EMOJI);
      assert.equal(found, null, `${name} 含有 emoji：${found}`);
    }
  });

  await t.test('不使用渐变与霓虹装饰', () => {
    assert.ok(!/linear-gradient|radial-gradient/i.test(css), '不允许渐变');
    assert.ok(!/box-shadow:[^;]*glow/i.test(css), '不允许发光阴影');
  });
});
