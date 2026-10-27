import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLIENT_DIR = fileURLToPath(new URL('../miniapps/mimic-tear/miniapp/client', import.meta.url));
const APP = join(CLIENT_DIR, 'assets', 'app.js');

/**
 * Pull one top-level function out of the client source.
 *
 * The client is a browser script with top-level side effects, so it cannot be imported
 * into a test. The render function under test is self-contained though — it only touches
 * `state`, `el` and `escapeHtml` — so it can be lifted out and run against stubs. This
 * exercises the real rendering code, not a paraphrase of it.
 *
 * @param {string} source
 * @param {string} name
 * @returns {string}
 */
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `客户端里找不到 ${name}`);
  // A top-level function ends with a closing brace in column zero.
  const end = source.indexOf('\n}\n', start);
  assert.notEqual(end, -1, `${name} 的结尾没找到`);
  return source.slice(start, end + 3);
}

/** A DOM stand-in: enough for the renderer, with the writes visible. */
function makeElementRegistry() {
  const elements = new Map();
  return {
    elements,
    el(id) {
      if (!elements.has(id)) elements.set(id, { id, textContent: '', innerHTML: '' });
      return elements.get(id);
    },
  };
}

test('client-skill-library-render', async (t) => {
  const app = await readFile(APP, 'utf8');

  // The client's own escaper, so the escaping assertion tests the real behaviour.
  const escapeHtml = new Function(`${extractFunction(app, 'escapeHtml')}\nreturn escapeHtml;`)();

  const renderSource = extractFunction(app, 'renderSkillLibrary');

  /** @param {any} skillLibrary */
  function render(skillLibrary) {
    const registry = makeElementRegistry();
    const state = { skillLibrary };
    const fn = new Function('state', 'el', 'escapeHtml', `${renderSource}\nreturn renderSkillLibrary;`)(
      state,
      registry.el,
      escapeHtml,
    );
    fn();
    return registry;
  }

  await t.test('未加载时显示加载中，而不是空白', () => {
    const registry = render(null);
    assert.match(registry.elements.get('skill-library-list').innerHTML, /正在加载/);
  });

  await t.test('空库给出解释，而不是空白', () => {
    const registry = render({ entries: [], stats: { active: 0, stale: 0, retired: 0, candidates: 0 } });
    assert.match(registry.elements.get('skill-library-list').innerHTML, /还没有封装过的技能/);
  });

  await t.test('条目渲染出技能名、状态、触发词与派工次数', () => {
    const registry = render({
      entries: [
        {
          id: 'sl1',
          skillName: 'mimic-tear-watchdog-heartbeat-verify',
          title: '值班心跳验收',
          status: 'candidate',
          domain: 'troubleshoot',
          triggers: ['看门狗', '心跳'],
          usageCount: 3,
          successCount: 2,
          lastError: null,
        },
      ],
      stats: { active: 1, stale: 0, retired: 0, candidates: 2 },
    });

    const html = registry.elements.get('skill-library-list').innerHTML;
    assert.match(html, /mimic-tear-watchdog-heartbeat-verify/, '要显示技能名');
    assert.match(html, /值班心跳验收/, '要显示标题');
    assert.match(html, /待封装/, '要显示状态');
    assert.match(html, /troubleshoot/, '要显示领域');
    assert.match(html, /看门狗、心跳/, '要显示触发词');
    assert.match(html, /派工 3 次 · 成功 2 次/, '要显示派工统计');

    const counter = registry.elements.get('skill-library-count').textContent;
    assert.match(counter, /1 个可派工/);
    assert.match(counter, /2 个待封装/);
  });

  await t.test('失效原因要显示出来——否则大老板看不到为什么不能用', () => {
    const registry = render({
      entries: [
        {
          id: 'sl2',
          skillName: 'broken-skill',
          title: 'broken-skill',
          status: 'stale',
          domain: '',
          triggers: [],
          usageCount: 0,
          successCount: 0,
          lastError: '技能文件不存在：C:/skills/broken-skill/SKILL.md',
        },
      ],
      stats: { active: 0, stale: 1, retired: 0, candidates: 0 },
    });

    const html = registry.elements.get('skill-library-list').innerHTML;
    assert.match(html, /已失效/);
    assert.match(html, /技能文件不存在/);
  });

  await t.test('内容里的尖括号被转义，不会打坏 DOM', () => {
    const registry = render({
      entries: [
        {
          id: 'sl3',
          skillName: 'xss',
          title: '<img src=x onerror=alert(1)>',
          status: 'active',
          domain: '',
          triggers: [],
          usageCount: 0,
          successCount: 0,
          lastError: null,
        },
      ],
      stats: { active: 1, stale: 0, retired: 0, candidates: 0 },
    });

    const html = registry.elements.get('skill-library-list').innerHTML;
    assert.ok(!html.includes('<img'), '标题里的标签必须被转义');
    assert.match(html, /&lt;img/);
  });
});
