import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { API_ROUTES, ROUTES } from '../miniapps/mimic-tear/miniapp/node/api-routes.mjs';

/**
 * 跨层 API 契约测试。
 *
 * 三方对账：服务端的路由表、客户端的端点表、规格 §5 的 API 表。
 *
 * 这条链路上任何一边单独改都不会立刻报错：服务端加了一条没人调用的路由，规格里
 * 没有，页面照常跑；客户端把一个路径拼错，服务端回 404，页面只是空一块。三方对账
 * 把这种「静默的漂移」变成一条指名道姓的失败。
 *
 * **路由清单是从路由注册表里读出来的**，不是在测试里另抄一份：加一条路由时测试会
 * 自己发现，不用记得回来改这张表。
 */

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLIENT_APP = join(REPO_ROOT, 'miniapps', 'mimic-tear', 'miniapp', 'client', 'assets', 'app.js');
const SPEC = join(REPO_ROOT, 'docs', 'specs', '2026-10-20-mimic-tear-design.md');

/**
 * 服务端有、规格有、客户端还没接的端点。
 *
 * 这种端点**不是**失败：服务端可以先于客户端上线，端点先立在那里，页面以后再接。
 * 但它必须被**显式登记**——登记是「我知道这条还没接」的一次表态，不是默认放过。
 * 路由表里多出一条没人用的端点而这里没登记时，测试会失败并指名那条端点。
 *
 * @type {Array<{ endpoint: string, reason: string }>}
 */
const SERVER_ONLY_ENDPOINTS = [
  {
    endpoint: 'POST /api/duty/intent',
    reason: '大哥在值班轮次里自己写下值班意图；页面不发这条请求，但它是对外的真实契约',
  },
];

/**
 * 把端点写成「方法 + 路径」。
 *
 * @param {{ method: string, path: string }} route
 * @returns {string}
 */
function endpointId(route) {
  return `${route.method} ${route.path}`;
}

/**
 * 路径的形状：把路径参数抹平成 `*`。
 *
 * 路径参数的名字在运行时没有意义——`/api/projects/1` 里那个 `1` 不管来自 `:id` 还是
 * `:projectId` 都一样——所以客户端与服务端比对的是形状，不是参数名。参数名的一致性
 * 由「服务端 ↔ 规格」那一侧保证（那边比的是完整模板）。
 *
 * @param {string} path
 * @returns {string}
 */
function pathShape(path) {
  return path
    .split('/')
    .map((segment) => (segment.startsWith(':') ? '*' : segment))
    .join('/');
}

/* --------------------------------------------------------------- 客户端端点表 */

/**
 * 跳过一个字符串字面量（含模板字符串与其中的插值）。
 *
 * @param {string} source
 * @param {number} index 引号的位置
 * @returns {number} 结束位置（引号之后）
 */
function skipLiteral(source, index) {
  const quote = source[index];
  let cursor = index + 1;
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === '\\') {
      cursor += 2;
      continue;
    }
    if (quote === '`' && char === '$' && source[cursor + 1] === '{') {
      cursor = skipInterpolation(source, cursor + 2);
      continue;
    }
    if (char === quote) return cursor + 1;
    cursor += 1;
  }
  return source.length;
}

/**
 * 跳过模板字符串里的一段插值（`${…}` 里的内容）。
 *
 * @param {string} source
 * @param {number} index 插值内容的起点
 * @returns {number} 结束位置（右花括号之后）
 */
function skipInterpolation(source, index) {
  let depth = 1;
  let cursor = index;
  while (cursor < source.length && depth > 0) {
    const char = source[cursor];
    if (char === '\'' || char === '"' || char === '`') {
      cursor = skipLiteral(source, cursor);
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') depth -= 1;
    cursor += 1;
  }
  return cursor;
}

/**
 * 截出一对大括号之间的内容。
 *
 * @param {string} source
 * @param {number} openIndex 左大括号的位置
 * @returns {string} 块内的文本
 */
function readBlock(source, openIndex) {
  let depth = 0;
  let cursor = openIndex;
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === '/' && source[cursor + 1] === '/') {
      const end = source.indexOf('\n', cursor);
      cursor = end === -1 ? source.length : end + 1;
      continue;
    }
    if (char === '/' && source[cursor + 1] === '*') {
      const end = source.indexOf('*/', cursor + 2);
      cursor = end === -1 ? source.length : end + 2;
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') {
      cursor = skipLiteral(source, cursor);
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex + 1, cursor);
    }
    cursor += 1;
  }
  throw new Error('大括号没有闭合');
}

/**
 * 跳到下一项（跳过逗号与空白）。
 *
 * @param {string} source
 * @param {number} index
 * @returns {number}
 */
function skipSeparator(source, index) {
  let cursor = index;
  while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
  if (source[cursor] === ',') {
    cursor += 1;
    while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
  }
  return cursor;
}

/**
 * 找一个左圆括号的配对右括号。
 *
 * @param {string} source
 * @param {number} openIndex
 * @returns {number}
 */
function findClosingParen(source, openIndex) {
  let depth = 0;
  let cursor = openIndex;
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === '\'' || char === '"' || char === '`') {
      cursor = skipLiteral(source, cursor);
      continue;
    }
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return cursor;
    }
    cursor += 1;
  }
  throw new Error('圆括号没有闭合');
}

/**
 * 读端点表里一项的值。
 *
 * 表里的值有两种写法，都要认：字符串常量（`overview: '/api/overview'`）和函数
 * （`project: (id) => \`/api/projects/${id}\``）。函数里的插值换成 `:参数名`，正好
 * 和服务端路由表里的写法对上。
 *
 * @param {string} block 端点表的文本
 * @param {number} index 值的起始位置
 * @returns {{ path: string|null, params: string[], next: number }}
 */
function readEndpointValue(block, index) {
  let cursor = index;
  while (cursor < block.length && /\s/.test(block[cursor])) cursor += 1;
  const char = block[cursor];

  if (char === '\'' || char === '"' || char === '`') {
    const end = skipLiteral(block, cursor);
    const literal = block.slice(cursor + 1, end - 1);
    // 带插值的模板串不是静态路径：插值的是路径参数时应该写成函数。
    if (literal.includes('${')) return { path: null, params: [], next: skipSeparator(block, end) };
    return { path: literal, params: [], next: skipSeparator(block, end) };
  }

  if (char === '(') {
    const close = findClosingParen(block, cursor);
    const params = block
      .slice(cursor + 1, close)
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    let arrow = close + 1;
    while (arrow < block.length && /\s/.test(block[arrow])) arrow += 1;
    if (!block.startsWith('=>', arrow)) {
      return { path: null, params: [], next: skipSeparator(block, arrow) };
    }
    arrow += 2;
    while (arrow < block.length && /\s/.test(block[arrow])) arrow += 1;
    const body = block[arrow];
    if (body === '`') {
      const end = skipLiteral(block, arrow);
      const literal = block.slice(arrow + 1, end - 1);
      const path = literal.replace(/\$\{([^}]*)\}/g, (_match, expression) => `:${expression.trim()}`);
      return { path, params, next: skipSeparator(block, end) };
    }
    if (body === '\'' || body === '"') {
      const end = skipLiteral(block, arrow);
      return { path: block.slice(arrow + 1, end - 1), params, next: skipSeparator(block, end) };
    }
    return { path: null, params: [], next: skipSeparator(block, arrow) };
  }

  return { path: null, params: [], next: skipSeparator(block, cursor) };
}

/**
 * 去掉注释。
 *
 * 端点表里带着说明用的注释，而注释里有撇号（`watchdog's`）也有冒号（`log: …`）——
 * 不先清掉，解析器就会把注释里的字当成键，或者一头栽进一个没闭合的字符串里。
 * 字符串里的内容原样保留：`//` 出现在路径里也是合法的。
 *
 * @param {string} source
 * @returns {string}
 */
function stripComments(source) {
  let out = '';
  let cursor = 0;
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === '/' && source[cursor + 1] === '/') {
      const end = source.indexOf('\n', cursor);
      cursor = end === -1 ? source.length : end;
      continue;
    }
    if (char === '/' && source[cursor + 1] === '*') {
      const end = source.indexOf('*/', cursor + 2);
      cursor = end === -1 ? source.length : end + 2;
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') {
      const end = skipLiteral(source, cursor);
      out += source.slice(cursor, end);
      cursor = end;
      continue;
    }
    out += char;
    cursor += 1;
  }
  return out;
}

/**
 * 读客户端的 API 端点表。
 *
 * @param {string} source app.js 的全文
 * @returns {Array<{ key: string, path: string, params: string[] }>}
 */
function parseClientEndpoints(source) {
  const marker = source.indexOf('const API =');
  assert.notEqual(marker, -1, 'app.js 里找不到 API 端点表（const API = { … }）');
  const openIndex = source.indexOf('{', marker);
  assert.notEqual(openIndex, -1, 'app.js 的 API 端点表没有大括号');
  const block = stripComments(readBlock(source, openIndex));

  const endpoints = [];
  let cursor = 0;
  while (cursor < block.length) {
    const rest = block.slice(cursor);
    const keyMatch = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(rest);
    if (!keyMatch) {
      const char = block[cursor];
      if (char === '\'' || char === '"' || char === '`') {
        cursor = skipLiteral(block, cursor);
        continue;
      }
      cursor += 1;
      continue;
    }
    const key = keyMatch[1];
    cursor += keyMatch[0].length;
    const value = readEndpointValue(block, cursor);
    cursor = value.next;
    if (value.path) endpoints.push({ key, path: value.path, params: value.params });
  }
  return endpoints;
}

/* ------------------------------------------------------------------- 规格 §5 */

/**
 * 截出规格里的一节（到下一个二级标题为止）。
 *
 * @param {string} markdown
 * @param {string} heading
 * @returns {string}
 */
function readSection(markdown, heading) {
  const start = markdown.indexOf(heading);
  if (start === -1) throw new Error(`规格里找不到 ${heading}`);
  const rest = markdown.slice(start + heading.length);
  const next = rest.search(/\n## [^#]/);
  return next === -1 ? rest : rest.slice(0, next);
}

/**
 * 读规格 §5 的 API 表。
 *
 * @param {string} markdown
 * @returns {Array<{ method: string, path: string }>}
 */
function parseSpecApiRows(markdown) {
  const rows = [];
  for (const line of readSection(markdown, '## 5. API').split('\n')) {
    const match = /^\|\s*(GET|POST|PUT|PATCH|DELETE)\s*\|\s*`([^`]+)`\s*\|/.exec(line);
    if (match) rows.push({ method: match[1], path: match[2] });
  }
  return rows;
}

/**
 * 读规格 §5.2 的 SSE 事件表。
 *
 * @param {string} markdown
 * @returns {string[]}
 */
function parseSpecSseEvents(markdown) {
  const events = [];
  for (const line of readSection(markdown, '## 5. API').split('\n')) {
    const match = /^\|\s*`([^`]+)`\s*\|/.exec(line);
    if (match) events.push(match[1]);
  }
  return events;
}

/* ---------------------------------------------------------------------- 测试 */

test('api-contract', async (t) => {
  const clientSource = await readFile(CLIENT_APP, 'utf8');
  const specSource = await readFile(SPEC, 'utf8');

  // 三方的原始清单。
  const serverRoutes = API_ROUTES.map((route) => ({ method: route.method, path: route.path }));
  const staticRoutes = ROUTES.filter((route) => route.kind === 'static');
  const clientEndpoints = parseClientEndpoints(clientSource);
  const specRows = parseSpecApiRows(specSource);
  const specEvents = parseSpecSseEvents(specSource);

  const serverIds = new Set(serverRoutes.map(endpointId));
  const specIds = new Set(specRows.map(endpointId));
  const clientShapes = new Set(clientEndpoints.map((endpoint) => pathShape(endpoint.path)));

  await t.test('三方清单都读得出来', () => {
    assert.ok(serverRoutes.length > 0, '服务端的 API 路由表是空的');
    for (const route of serverRoutes) {
      assert.ok(route.method && route.path, `路由表里有半条路由：${JSON.stringify(route)}`);
      assert.ok(route.path.startsWith('/api/'), `API 路由必须以 /api/ 开头：${route.path}`);
    }
    assert.ok(specRows.length > 0, '规格 §5 的 API 表没读到任何一行');
    assert.ok(clientEndpoints.length > 0, '客户端的端点表没读到任何一项');
    for (const endpoint of clientEndpoints) {
      assert.ok(
        endpoint.path.startsWith('/api/'),
        `客户端端点 ${endpoint.key} 的路径不像 API 路径：${endpoint.path}`,
      );
    }
  });

  await t.test('静态路由还在（它们不是 API，但页面要靠它们）', () => {
    const staticIds = staticRoutes.map((route) => `${route.method} ${route.path}`);
    for (const expected of ['GET /', 'GET /index.html', 'GET /assets/:file']) {
      assert.ok(staticIds.includes(expected), `静态路由少了：${expected}（现有：${staticIds.join('、')}）`);
    }
  });

  await t.test('服务端有的端点，规格 §5 必须也写着', () => {
    for (const route of serverRoutes) {
      const id = endpointId(route);
      assert.ok(
        specIds.has(id),
        `服务端有、规格没有：${id}。规格 §5 的 API 表漏了这条路由，补上它，或者把路由从注册表里撤掉。`,
      );
    }
  });

  await t.test('规格 §5 写着的端点，服务端必须真的有', () => {
    for (const row of specRows) {
      const id = endpointId(row);
      assert.ok(
        serverIds.has(id),
        `规格有、服务端没有：${id}。规格 §5 写的这条路由在注册表里找不到，要么实现它，要么改规格。`,
      );
    }
  });

  await t.test('客户端调的端点，服务端必须真的有', () => {
    for (const endpoint of clientEndpoints) {
      const shape = pathShape(endpoint.path);
      const matched = serverRoutes.filter((route) => pathShape(route.path) === shape);
      assert.ok(
        matched.length > 0,
        `客户端调用了服务端没有的端点：${endpoint.path}（端点表键名 ${endpoint.key}）。服务端路由表里没有形状为 ${shape} 的路由。`,
      );
      assert.equal(
        matched.length,
        1,
        `客户端端点 ${endpoint.key}（${endpoint.path}）对应到多条服务端路由：${matched.map(endpointId).join('、')}。服务端登记有歧义。`,
      );
    }
  });

  await t.test('服务端有、客户端还没接的端点，必须在例外清单里登记', () => {
    const registered = new Map(SERVER_ONLY_ENDPOINTS.map((entry) => [entry.endpoint, entry.reason]));
    for (const route of serverRoutes) {
      const id = endpointId(route);
      if (clientShapes.has(pathShape(route.path))) continue;
      assert.ok(
        registered.has(id),
        `服务端新增了端点但客户端还没接上，也没有登记例外：${id}。要么让客户端接上，要么在 SERVER_ONLY_ENDPOINTS 里写清为什么可以先不接。`,
      );
    }
  });

  await t.test('例外清单不能过期（登记过的端点要么还在没人用，要么就划掉）', () => {
    for (const entry of SERVER_ONLY_ENDPOINTS) {
      const route = serverRoutes.find((candidate) => endpointId(candidate) === entry.endpoint);
      assert.ok(route, `例外清单里的端点服务端已经没有了：${entry.endpoint}。请从 SERVER_ONLY_ENDPOINTS 里删掉。`);
      assert.ok(
        !clientShapes.has(pathShape(route.path)),
        `例外清单过期了：${entry.endpoint} 客户端已经接上了。请从 SERVER_ONLY_ENDPOINTS 里删掉这条登记。`,
      );
      assert.ok(entry.reason && entry.reason.length > 0, `例外清单里的 ${entry.endpoint} 没写原因`);
    }
  });

  await t.test('路由表声明会广播的 SSE 事件，规格 §5.2 的事件表里必须有', () => {
    // 单向检查：路由表 ⊆ 事件表。反过来不成立——`snapshot`、`permission`、
    // `chat.history`、`duty` 是在路由之外广播的，不挂在任何一条路由上。
    const known = new Set(specEvents);
    for (const route of API_ROUTES) {
      for (const broadcast of route.broadcast ?? []) {
        assert.ok(
          known.has(broadcast.event),
          `路由 ${endpointId(route)} 声明会广播事件 ${broadcast.event}，但规格 §5.2 的事件表里没有它。`,
        );
      }
    }
  });
});
