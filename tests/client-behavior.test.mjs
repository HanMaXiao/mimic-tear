import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLIENT_DIR = fileURLToPath(new URL('../miniapps/mimic-tear/miniapp/client', import.meta.url));
const HTML_PATH = `${CLIENT_DIR}/index.html`;
const APP_PATH = `${CLIENT_DIR}/assets/app.js`;

/* ------------------------------------------------------------------ DOM shim */

function parseAttributes(raw) {
  const attributes = {};
  const pattern = /([\w:-]+)(?:="([^"]*)")?/g;
  let match;
  while ((match = pattern.exec(raw)) !== null) {
    attributes[match[1]] = match[2] ?? '';
  }
  return attributes;
}

function matchesSelector(element, selector) {
  if (selector === '[data-nav]') return element.dataset.nav !== undefined;
  if (selector === '[data-action]') return element.dataset.action !== undefined;
  if (selector === '[data-domain]') return element.dataset.domain !== undefined;
  return false;
}

class ShimElement {
  constructor(tagName, attributes = {}) {
    this.tagName = tagName.toUpperCase();
    this.attributes = { ...attributes };
    this.dataset = {};
    for (const [key, value] of Object.entries(attributes)) {
      if (key.startsWith('data-')) {
        this.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
      }
    }
    this.id = attributes.id ?? '';
    this.className = attributes.class ?? '';
    this.textContent = '';
    this._innerHTML = '';
    this.value = attributes.value ?? '';
    this.checked = 'checked' in attributes;
    this.hidden = 'hidden' in attributes;
    this.disabled = false;
    this.children = [];
    this.parent = null;
    this.listeners = new Map();
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set innerHTML(html) {
    this._innerHTML = html;
    this.children = [];
    const pattern = /<(\w+)([^>]*)>/g;
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const child = new ShimElement(match[1], parseAttributes(match[2]));
      child.parent = this;
      this.children.push(child);
      if (child.id) registry.set(child.id, child);
    }
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  dispatchEvent(event) {
    event.target = event.target ?? this;
    for (const handler of this.listeners.get(event.type) ?? []) handler(event);
    return true;
  }

  append(node) {
    this.children.push(node);
    node.parent = this;
  }

  appendChild(node) {
    this.append(node);
    return node;
  }

  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }

  focus() {}
  close() { this.open = false; }
  showModal() { this.open = true; }
  setAttribute(key, value) { this.attributes[key] = value; }
  getAttribute(key) { return this.attributes[key] ?? null; }
  removeAttribute(key) { delete this.attributes[key]; }

  closest(selector) {
    let node = this;
    while (node) {
      if (matchesSelector(node, selector)) return node;
      node = node.parent;
    }
    return null;
  }

  querySelectorAll(selector) {
    const found = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (matchesSelector(child, selector)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
}

const registry = new Map();
const allElements = [];

function buildDom(html) {
  const pattern = /<(\w+)([^>]*)>/g;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    const element = new ShimElement(match[1], parseAttributes(match[2]));
    allElements.push(element);
    if (element.id) registry.set(element.id, element);
  }
}

const documentListeners = new Map();
const copyDir = mkdtempSync(join(tmpdir(), 'mimic-client-'));
let loadCounter = 0;

const documentShim = {
  getElementById: (id) => registry.get(id) ?? null,
  createElement: (tag) => {
    const element = new ShimElement(tag);
    allElements.push(element);
    return element;
  },
  querySelectorAll: (selector) => allElements.filter((e) => matchesSelector(e, selector)),
  addEventListener: (type, handler) => {
    if (!documentListeners.has(type)) documentListeners.set(type, []);
    documentListeners.get(type).push(handler);
  },
  // A real DOM always has a root element; the theme override is written onto it.
  documentElement: new ShimElement('html'),
  body: new ShimElement('body'),
};

function fireDocument(type, event) {
  for (const handler of documentListeners.get(type) ?? []) handler(event);
}

/* ---------------------------------------------------------------- fixtures */

const PROJECTS = [
  {
    id: 1,
    name: 'alpha',
    path: 'D:/projects/alpha',
    health: 'active',
    sessionCount: 2,
    lastActivityAt: 1000,
    activeSessions: 1,
    erroredSessions: 0,
    pendingQuestions: 0,
    goals: [],
    planTasks: [],
  },
  {
    id: 2,
    name: 'beta',
    path: 'D:/projects/beta',
    health: 'idle',
    sessionCount: 1,
    lastActivityAt: 900,
    activeSessions: 0,
    erroredSessions: 0,
    pendingQuestions: 0,
    goals: [],
    planTasks: [],
  },
];

const OVERVIEW = {
  generatedAt: 1,
  kpi: { projects: 2, active: 1, pendingDecisions: 0, errors: 0 },
  projects: PROJECTS,
  attention: [],
  internalProjectCount: 0,
  dataWarning: null,
};

// Lets a test drive the overview payload (for example a duty state that is stale).
let overviewOverride = null;
// Lets a test drive the inbox payload.
let inboxOverride = null;
// Lets a test drive the watchdog's alert log.
let alertsOverride = null;
// Lets a test drive the dispatch record the page reads back by id. A function is called
// on every read, so a test can make a dispatch change while the page is watching it.
let dispatchStatusOverride = null;

/**
 * The dispatch record the server hands back on GET /api/dispatch/:id.
 *
 * @returns {any}
 */
function dispatchRecord() {
  if (typeof dispatchStatusOverride === 'function') return dispatchStatusOverride();
  return dispatchStatusOverride ?? {
    id: 'd1',
    status: 'done',
    text: '好，交给你了',
    error: null,
    projectId: 1,
    projectName: 'alpha',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/**
 * A `localStorage` stand-in.
 *
 * The page remembers the dispatch it is waiting for across a reload, so the store has to
 * outlive a single load — otherwise "the page was reloaded" cannot be simulated.
 *
 * @returns {any}
 */
function createStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
    clear: () => { map.clear(); },
  };
}

const PROJECT_DETAIL = {
  project: PROJECTS[0],
  orgTree: [{
    id: 'sess-alpha-lead',
    agentName: 'mavis',
    title: 'Alpha 主会话',
    status: 'idle',
    role: 'lead',
    purpose: null,
    error: null,
    children: [],
  }],
  goals: [],
  questions: [],
  tasks: [],
  plan: null,
};

/* ---------------------------------------------------------------- harness */

/**
 * Load the real client module against a DOM shim and return handles for driving it.
 *
 * @param {{ search?: string, mcode?: any, keepStorage?: boolean, storage?: any,
 *           fail?: string[], hang?: string[] }} [options] query string the page is loaded
 *   with; `mcode` stands in for the Host bridge the real page gets from the preload;
 *   `keepStorage` keeps the remembered dispatch, which is what a reload looks like;
 *   `storage` supplies the page's own store, so two loads can share one;
 *   `fail` and `hang` are path prefixes whose read fails or never answers.
 */
async function loadClient(options = {}) {
  const html = await readFile(HTML_PATH, 'utf8');
  registry.clear();
  allElements.length = 0;
  buildDom(html);

  // Every page gets its own store: the client holds on to the store it first saw, so a
  // background poll from an earlier page can never touch this page's dispatch.
  const store = options.storage ?? createStorage();
  if (!options.keepStorage) store.clear();
  Object.defineProperty(globalThis, 'localStorage', {
    value: store,
    configurable: true,
    writable: true,
  });

  const calls = [];
  const sseListeners = new Map();
  const location = { hash: '', search: options.search ?? '' };
  // A fresh root element per load, so a theme written at boot time is observable.
  documentShim.documentElement = new ShimElement('html');

  globalThis.document = documentShim;
  globalThis.window = {
    get location() { return location; },
    mcode: options.mcode,
    addEventListener: (type, handler) => {
      if (!windowListeners.has(type)) windowListeners.set(type, []);
      windowListeners.get(type).push(handler);
    },
  };
  const windowListeners = new Map();

  globalThis.EventSource = class {
    constructor(url) {
      this.url = url;
      calls.push({ method: 'GET', url });
    }
    addEventListener(type, handler) {
      if (!sseListeners.has(type)) sseListeners.set(type, []);
      sseListeners.get(type).push(handler);
    }
    close() {}
  };

  globalThis.fetch = async (url, request = {}) => {
    calls.push({ method: request.method ?? 'GET', url, body: request.body ? JSON.parse(request.body) : null });
    const path = String(url);
    for (const prefix of options.fail ?? []) {
      if (path.startsWith(prefix)) throw new Error('读取失败');
    }
    for (const prefix of options.hang ?? []) {
      if (path.startsWith(prefix)) return new Promise(() => {});
    }
    let payload = {};
    if (path.startsWith('/api/overview')) payload = overviewOverride ?? OVERVIEW;
    else if (path.startsWith('/api/inbox')) payload = inboxOverride ?? { items: [] };
    else if (path.startsWith('/api/skills')) payload = { groups: [], unmapped: [], total: 0, failures: 0 };
    else if (path.startsWith('/api/patrol')) payload = { config: { enabled: false }, findings: [] };
    else if (path.startsWith('/api/projects/')) payload = PROJECT_DETAIL;
    else if (path.startsWith('/api/projects')) payload = { projects: PROJECTS };
    else if (path.startsWith('/api/watchdog/alerts')) payload = alertsOverride ?? { alerts: [] };
    // The record read back by id comes before the bare dispatch path: both start with
    // "/api/dispatch".
    else if (path.startsWith('/api/dispatch/')) payload = dispatchRecord();
    else if (path.startsWith('/api/dispatch')) payload = { dispatchId: 'd1', status: 'queued' };
    else if (path.startsWith('/api/chat/session')) payload = { bossSessionId: 'mvs_boss_1', agent: 'boss' };
    else if (path.startsWith('/api/chat/history')) payload = { messages: [] };
    else if (path.startsWith('/api/chat/duty')) payload = { rounds: [] };
    else if (path.startsWith('/api/chat')) payload = { status: 'started', bossSessionId: 'mvs_boss_1' };
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  };

  // Node 24 provides globalThis.crypto.randomUUID natively; it is a read-only getter, so it
  // must not be reassigned.
  if (!globalThis.crypto?.randomUUID) {
    Object.defineProperty(globalThis, 'crypto', {
      value: { randomUUID: () => 'uuid-test' },
      configurable: true,
    });
  }

  // Import with a cache-busting query so each test gets a fresh module instance.
  // A file URL is cached by path, so a query string does not give a fresh instance.
  // Each load gets its own copy of the client source, byte-identical to the shipped file.
  const copyPath = `${copyDir}/app-${loadCounter}.mjs`;
  await writeFile(copyPath, await readFile(APP_PATH, 'utf8'), 'utf8');
  loadCounter += 1;
  await import(new URL(`file:///${copyPath.replace(/\\/g, '/')}`).href);

  const settle = async () => {
    // The client renders from fetched data, so give the promise chain a few turns.
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };

  return {
    calls,
    location,
    settle,
    fireSse(type, data) {
      for (const handler of sseListeners.get(type) ?? []) handler({ data: JSON.stringify(data) });
    },
    element: (id) => registry.get(id) ?? null,
    click(element, extra = {}) {
      if (!element) throw new Error('click() 需要一个元素');
      const event = { type: 'click', target: element, preventDefault() {}, ...extra };
      fireDocument('click', event);
    },
    async navigate(hash) {
      location.hash = hash;
      for (const handler of windowListeners.get('hashchange') ?? []) handler({ type: 'hashchange' });
      await settle();
    },
  };
}

/* ------------------------------------------------------------------- tests */

/**
 * What the toast host is saying.
 *
 * @param {any} client
 * @returns {string}
 */
function toastText(client) {
  const host = client.element('toast-host');
  if (!host) return '';
  return host.children.map((node) => node.textContent).join(' ').trim();
}

/**
 * Send one instruction to the first project through the real dialog.
 *
 * @param {any} client
 * @param {string} instruction
 */
async function dispatchToAlpha(client, instruction) {
  const buttons = client.element('projects-body').querySelectorAll('[data-action]')
    .filter((button) => button.dataset.action === 'dispatch' && button.dataset.project === '1');
  assert.ok(buttons.length, '项目 1 应有下达指令按钮');
  client.click(buttons[0]);
  client.element('dispatch-instruction').value = instruction;
  client.element('dispatch-form').dispatchEvent({ type: 'submit', preventDefault() {} });
  await client.settle();
}

test('client behavior (DOM shim)', async (t) => {
  await t.test('派工目标来自对话框自己的目标，不来自当前路由', async () => {
    const client = await loadClient();
    await client.settle();

    // Visit project 1 first, so a route-derived target would be 1.
    await client.navigate('#/project/1');
    await client.settle();

    // Back to the overview, then dispatch for project 2.
    await client.navigate('#/overview');
    await client.settle();

    const body = client.element('projects-body');
    const buttons = body.querySelectorAll('[data-action]')
      .filter((b) => b.dataset.action === 'dispatch' && b.dataset.project === '2');
    assert.equal(buttons.length, 1, '项目 2 应有下达指令按钮');

    client.click(buttons[0]);
    assert.match(client.element('dispatch-target').textContent, /beta/, '对话框应指向 beta');

    client.element('dispatch-instruction').value = '把 beta 的结算逻辑修一下';
    client.element('dispatch-form').dispatchEvent({
      type: 'submit',
      preventDefault() {},
    });
    await client.settle();

    const dispatch = client.calls.find((c) => c.url.startsWith('/api/dispatch') && c.method === 'POST');
    assert.ok(dispatch, '应发出派工请求');
    assert.equal(
      dispatch.body.projectId,
      2,
      '派工必须发往对话框自己记住的项目 2，而不是上一次打开的项目 1',
    );
    assert.equal(dispatch.body.instruction, '把 beta 的结算逻辑修一下');
  });

  await t.test('没有打开过项目详情时，派工仍然可用', async () => {
    const client = await loadClient();
    await client.settle();

    const body = client.element('projects-body');
    const buttons = body.querySelectorAll('[data-action]')
      .filter((b) => b.dataset.action === 'dispatch' && b.dataset.project === '1');
    client.click(buttons[0]);
    client.element('dispatch-instruction').value = 'x';
    client.element('dispatch-form').dispatchEvent({ type: 'submit', preventDefault() {} });
    await client.settle();

    const dispatch = client.calls.find((c) => c.url.startsWith('/api/dispatch') && c.method === 'POST');
    assert.equal(dispatch.body.projectId, 1);
  });

  await t.test('项目详情跟随 SSE 更新重新拉取', async () => {
    const client = await loadClient();
    await client.navigate('#/project/1');
    await client.settle();

    const before = client.calls.filter((c) => c.url.startsWith('/api/projects/1')).length;
    assert.ok(before > 0, '进入项目详情应拉取一次');

    client.fireSse('update', OVERVIEW);
    await client.settle();

    const after = client.calls.filter((c) => c.url.startsWith('/api/projects/1')).length;
    assert.ok(after > before, 'SSE 更新后应重新拉取项目详情');
  });

  await t.test('离开项目详情再回来会重新拉取', async () => {
    const client = await loadClient();
    await client.navigate('#/project/1');
    await client.settle();
    const before = client.calls.filter((c) => c.url.startsWith('/api/projects/1')).length;

    await client.navigate('#/overview');
    await client.settle();
    await client.navigate('#/project/1');
    await client.settle();

    const after = client.calls.filter((c) => c.url.startsWith('/api/projects/1')).length;
    assert.ok(after > before, '回到项目详情应重新拉取，而不是显示旧数据');
  });

  await t.test('「去回答」把答案交给派工通道，而不是只弹提示', async () => {
    const client = await loadClient();
    await client.settle();

    const inbox = client.element('inbox-list');
    // No items rendered, so the button is absent — the point is that the action handler
    // routes to the dispatch dialog. Drive it directly with a synthetic element.
    void inbox;
    const synthetic = new ShimElement('button', {
      'data-action': 'open-session',
      'data-project': '1',
      'data-session': 'mvs_q1',
      'data-body': '是否继续？',
    });
    client.click(synthetic);

    assert.match(client.element('dispatch-target').textContent, /alpha/);
    assert.match(client.element('dispatch-instruction').value, /是否继续？/);
  });

  await t.test('大哥正常交班时，看板说「值班中」', async () => {
    overviewOverride = {
      ...OVERVIEW,
      duty: {
        lastRunAt: Date.now() - 5 * 60_000,
        intervalMinutes: 15,
        findings: 0,
        openFindings: 0,
        staleAfterMinutes: 45,
        stale: false,
        neverRan: false,
        ageMinutes: 5,
      },
    };
    try {
      const client = await loadClient();
      await client.settle();

      const duty = client.element('duty-status');
      assert.match(duty.textContent, /大哥值班中/, '正常交班应显示值班中');
      assert.match(duty.textContent, /上次巡检/);
      assert.equal(duty.getAttribute('data-duty-state'), null, '正常状态不应标成掉线');
    } finally {
      overviewOverride = null;
    }
  });

  await t.test('大哥长时间没交班时，看板明说「可能掉线」', async () => {
    overviewOverride = {
      ...OVERVIEW,
      duty: {
        lastRunAt: Date.now() - 4 * 60 * 60_000,
        intervalMinutes: 15,
        findings: 2,
        openFindings: 1,
        staleAfterMinutes: 45,
        stale: true,
        neverRan: false,
        ageMinutes: 240,
      },
    };
    try {
      const client = await loadClient();
      await client.settle();

      const duty = client.element('duty-status');
      assert.match(duty.textContent, /大哥可能掉线/, '掉线必须写成人话，而不是只给时间戳');
      assert.match(duty.textContent, /1 条结论待你过目/, '掉线时未过目的结论仍然要显示');
      assert.equal(duty.getAttribute('data-duty-state'), 'stale');
    } finally {
      overviewOverride = null;
    }
  });

  await t.test('大哥在休息时，看板说「休息中」而不是「可能掉线」', async () => {
    overviewOverride = {
      ...OVERVIEW,
      duty: {
        lastRunAt: Date.now() - 4 * 60 * 60_000,
        intervalMinutes: 15,
        findings: 1,
        openFindings: 1,
        staleAfterMinutes: 45,
        stale: true,
        neverRan: false,
        ageMinutes: 240,
        // 休息是一个带理由的决定，不是漏交班：交班戳照样会旧，但旧不等于掉线。
        mode: 'resting',
        resting: true,
        since: Date.now() - 60 * 60_000,
        requestedBy: '大老板',
      },
    };
    try {
      const client = await loadClient();
      await client.settle();

      const duty = client.element('duty-status');
      assert.match(duty.textContent, /大哥休息中/, '休息要说人话');
      assert.doesNotMatch(duty.textContent, /可能掉线/, '休息不是故障，不该报掉线');
      assert.match(duty.textContent, /召唤才醒/, '要说清楚它是被召唤才醒');
      assert.match(duty.textContent, /1 条结论待你过目/, '休息时待过目的结论仍然要显示');
      assert.equal(duty.getAttribute('data-duty-state'), 'resting');
    } finally {
      overviewOverride = null;
    }
  });

  await t.test('大哥从没交过班时，看板说「尚未巡检」而不是「值班中」', async () => {
    overviewOverride = {
      ...OVERVIEW,
      duty: {
        lastRunAt: null,
        intervalMinutes: 15,
        findings: 0,
        openFindings: 0,
        staleAfterMinutes: 45,
        stale: true,
        neverRan: true,
        ageMinutes: null,
      },
    };
    try {
      const client = await loadClient();
      await client.settle();

      const duty = client.element('duty-status');
      assert.match(duty.textContent, /尚未巡检/);
      assert.doesNotMatch(duty.textContent, /大哥值班中/, '没交过班不能说成值班中');
      assert.equal(duty.getAttribute('data-duty-state'), 'stale');
    } finally {
      overviewOverride = null;
    }
  });

  await t.test('大哥撤回过结论时，值班行要说出来', async () => {
    overviewOverride = {
      ...OVERVIEW,
      duty: {
        lastRunAt: Date.now() - 5 * 60_000,
        intervalMinutes: 15,
        dutyIntervalMinutes: 30,
        findings: 12,
        openFindings: 9,
        withdrawn: 2,
        staleAfterMinutes: 45,
        stale: false,
        neverRan: false,
        ageMinutes: 5,
        missedRounds: 0,
      },
    };
    try {
      const client = await loadClient();
      await client.settle();

      const duty = client.element('duty-status');
      assert.match(duty.textContent, /9 条结论待你过目/);
      assert.match(duty.textContent, /2 条已由大哥撤回/, '大哥撤回过结论必须让大老板知道');
    } finally {
      overviewOverride = null;
    }
  });

  await t.test('大哥撤回自己的结论时，收件箱要说明为什么', async () => {
    inboxOverride = {
      items: [
        {
          id: 'patrol:patrol_old_1',
          kind: 'patrol',
          severity: 'high',
          projectId: 10,
          projectName: 'Contra-Survivor',
          sessionId: null,
          sessionTitle: null,
          title: '4 个会话全部以 2056 额度上限中断',
          body: '需要你升级 Token Plan 套餐。',
          createdAt: Date.now() - 3600_000,
          ageMinutes: 60,
          acknowledged: true,
          handledBy: 'boss',
          handledReason: '账号并未被额度卡住，这条结论已过期',
        },
        {
          id: 'patrol:patrol_old_2',
          kind: 'patrol',
          severity: 'medium',
          projectId: 3,
          projectName: 'Mimic Tear',
          sessionId: null,
          sessionTitle: null,
          title: '需要你定的是巡检的定位',
          body: '巡检要不要升格为正式派工通道。',
          createdAt: Date.now() - 7200_000,
          ageMinutes: 120,
          acknowledged: true,
          handledBy: 'user',
          handledReason: '',
        },
      ],
    };
    try {
      const client = await loadClient();
      await client.navigate('#/inbox');
      await client.settle();

      // "只看未确认" is on by default, so a retracted item is hidden — that is the point.
      assert.equal(
        client.element('inbox-list').innerHTML.includes('大哥已处理'),
        false,
        '默认视图不该出现已确认的条目',
      );

      // Turn it off: now the reason must be visible, and it must say WHO closed it.
      const toggle = client.element('inbox-pending-only');
      toggle.checked = false;
      toggle.dispatchEvent({ type: 'change' });
      await client.settle();

      const html = client.element('inbox-list').innerHTML;
      assert.match(html, /大哥已处理：账号并未被额度卡住/, '处理必须写清理由');
      assert.match(html, /你已标记已知/, '大老板自己确认的要和大哥处理的区分开');
    } finally {
      inboxOverride = null;
    }
  });

  await t.test('大哥排除掉的原始项，收件箱要报出数量', async () => {
    overviewOverride = {
      ...OVERVIEW,
      duty: {
        lastRunAt: Date.now() - 5 * 60_000,
        intervalMinutes: 15,
        dutyIntervalMinutes: 30,
        findings: 12,
        openFindings: 9,
        withdrawn: 2,
        dismissed: 4,
        staleAfterMinutes: 45,
        stale: false,
        neverRan: false,
        ageMinutes: 5,
        missedRounds: 0,
      },
    };
    inboxOverride = { items: [] };
    try {
      const client = await loadClient();
      await client.navigate('#/inbox');
      await client.settle();

      assert.match(
        client.element('inbox-count').textContent,
        /4 条已由大哥排除/,
        '大哥排除了多少条必须让大老板知道——不然它能悄悄清场',
      );
    } finally {
      overviewOverride = null;
      inboxOverride = null;
    }
  });

  await t.test('进入看板先看到对话面板', async () => {
    const client = await loadClient();
    await client.settle();

    assert.equal(client.element('view-chat').hidden, false, '对话应该是落地页——大哥才是产品');
    assert.equal(client.element('view-overview').hidden, true);
    assert.match(client.element('chat-log').innerHTML, /大哥在/, '空对话要给一句话的引导');
  });

  await t.test('给大哥发消息：我的气泡出现，并请求一次 /api/chat', async () => {
    const client = await loadClient();
    await client.settle();

    client.element('chat-input').value = '盯紧 Dungeon-Chesser';
    client.element('chat-form').dispatchEvent({ type: 'submit', preventDefault() {} });
    await client.settle();

    assert.match(client.element('chat-log').innerHTML, /盯紧 Dungeon-Chesser/, '我发的消息要出现在对话里');

    const call = client.calls.find((c) => c.url.startsWith('/api/chat') && c.method === 'POST');
    assert.ok(call, '应该向 /api/chat 发一次请求');
    assert.equal(call.body.text, '盯紧 Dungeon-Chesser');
  });

  await t.test('大哥的回复边来边显示，结束后落成一条消息', async () => {
    const client = await loadClient();
    await client.settle();

    client.fireSse('chat.delta', { text: '收到' });
    client.fireSse('chat.delta', { text: '，我去看看' });
    await client.settle();
    assert.match(client.element('chat-log').innerHTML, /收到，我去看看/, '流式内容要实时出现在气泡里');

    client.fireSse('chat.done', { status: 'finished', text: '收到，我去看看' });
    await client.settle();
    const html = client.element('chat-log').innerHTML;
    assert.match(html, /收到，我去看看/);
    assert.equal(html.includes('chat__msg--streaming'), false, '结束后不该还留着进行中的气泡');
  });

  await t.test('大哥调工具时能看到他在做什么', async () => {
    const client = await loadClient();
    await client.settle();

    client.fireSse('chat.tool', { name: 'bash', phase: 'started' });
    client.fireSse('chat.tool', { name: 'bash', phase: 'finished', ok: true });
    await client.settle();

    assert.match(client.element('chat-log').innerHTML, /bash/, '工具名要出现在对话里——这是"看到大哥在干什么"的关键');
  });

  await t.test('大哥卡在问卷上时，选项能在对话里选并提交', async () => {
    const client = await loadClient();
    await client.settle();

    client.fireSse('chat.question', {
      requestId: 'ask_1',
      mode: 'questionnaire',
      request: {
        title: '需要你确认',
        steps: [{
          id: 's1',
          question: '要不要现在开工？',
          selectionMode: 'single',
          options: [{ id: 'yes', label: '开工' }, { id: 'no', label: '再等等' }],
        }],
      },
    });
    await client.settle();

    const html = client.element('chat-log').innerHTML;
    assert.match(html, /要不要现在开工？/, '问卷要渲染出来');
    assert.match(html, /开工/);

    // Pick "开工" and submit.
    const option = client.element('chat-log').querySelectorAll('[data-action]')
      .find((node) => node.dataset.option === 'yes');
    assert.ok(option, '选项按钮要在 DOM 里');
    client.click(option);
    await client.settle();

    const submit = client.element('chat-log').querySelectorAll('[data-action]')
      .find((node) => node.dataset.action === 'chat-answer');
    assert.ok(submit, '提交按钮要在 DOM 里');
    client.click(submit);
    await client.settle();

    const call = client.calls.find((c) => c.url.startsWith('/api/chat/answer') && c.method === 'POST');
    assert.ok(call, '应该向 /api/chat/answer 提交回答');
    assert.equal(call.body.requestId, 'ask_1');
    assert.equal(call.body.answers[0].stepId, 's1');
    assert.deepEqual(call.body.answers[0].selectedOptionIds, ['yes']);
  });

  await t.test('「在侧栏打开」真的调用宿主的 agent.open，并带上大哥的会话 id', async () => {
    // The Host renders agent turns (streaming, tools, permissions, questionnaires) far better
    // than a Mini App can re-implement them, so the page must be able to hand the conversation
    // to the Host's own chat side panel. A string-match test cannot prove the call happens
    // with the right id; this one clicks the button and watches the Host API.
    const opened = [];
    const client = await loadClient({
      mcode: {
        miniapp: {
          agent: {
            async open(sessionId) { opened.push(sessionId); },
          },
        },
      },
    });
    await client.settle();

    const button = client.element('chat-open-host');
    assert.ok(button, '侧栏按钮要存在');

    button.dispatchEvent({ type: 'click', preventDefault() {} });
    await client.settle();

    // Exactly one call with the right id: "not called" and "called twice" are both failures,
    // and an optional call (`agent.open?.(...)`) must not pass for a real call.
    assert.equal(opened.length, 1, '应恰好调用一次 agent.open');
    assert.deepEqual(opened, ['mvs_boss_1'], '应传入大哥的会话 id');
    const sessionCall = client.calls.find((c) => c.url.startsWith('/api/chat/session'));
    assert.ok(sessionCall, '会话 id 应来自服务端');
  });

  await t.test('宿主没有侧栏能力时给出可见提示，不静默失败', async () => {
    const client = await loadClient({ mcode: { miniapp: { agent: {} } } });
    await client.settle();

    client.element('chat-open-host').dispatchEvent({ type: 'click', preventDefault() {} });
    await client.settle();

    const host = client.element('toast-host');
    assert.ok(host, '提示容器要存在');
    // The shim's `textContent` is a plain property, so the message lives on the child node.
    const shown = host.children.map((node) => node.textContent).join(' ');
    assert.match(shown, /侧栏/, '应该告诉用户为什么打不开');
  });

  await t.test('值班交班汇报渲染在对话上方，且与大哥的对话区分得开', async () => {
    const client = await loadClient();
    await client.settle();

    // The rounds arrive over SSE: the duty boss runs in its own process, so the board only
    // learns about a round when the server tells it.
    client.fireSse('duty', {
      rounds: [{
        startedAt: 1792507304400,
        findings: [{ id: 'p1', severity: 'high', title: 'Dungeon-Chesser 的派系轴交付了', projectName: 'Dungeon-Chesser', acknowledged: false, acknowledgedBy: null }],
        counts: { high: 1, medium: 0, low: 0 },
      }],
    });
    await client.settle();

    const duty = client.element('chat-duty');
    assert.ok(duty, '交班汇报区要存在');
    const html = duty.innerHTML;
    assert.match(html, /派系轴交付了/, '交班结论要渲染出来');
    assert.match(html, /Dungeon-Chesser/, '要标出是哪个项目');
    assert.match(html, /chat__duty/, '交班汇报要有自己的样式类（不能混进对话气泡）');

    // And it must not be a chat bubble: a duty round is something the boss did on its own.
    const log = client.element('chat-log');
    assert.doesNotMatch(log.innerHTML, /派系轴交付了/, '交班汇报不该混进对话记录');
  });

  await t.test('值班交班：只有最新一轮展开，旧的折叠成一行（别把对话挤出屏幕）', async () => {
    const client = await loadClient();
    await client.settle();

    client.fireSse('duty', {
      rounds: [
        {
          startedAt: 1792507304400,
          findings: [{ id: 'p1', severity: 'high', title: '最新一轮的结论', projectName: 'alpha', acknowledged: false, acknowledgedBy: null }],
          counts: { high: 1, medium: 0, low: 0 },
        },
        {
          startedAt: 1792503704400,
          findings: [{ id: 'p2', severity: 'low', title: '上一轮的结论', projectName: 'beta', acknowledged: false, acknowledgedBy: null }],
          counts: { high: 0, medium: 0, low: 1 },
        },
      ],
    });
    await client.settle();

    const html = client.element('chat-duty').innerHTML;
    // Native details/summary: keyboard reachable, screen-reader friendly, no JS.
    assert.match(html, /<details[^>]*\sopen[^>]*>/, '最新一轮要默认展开');
    assert.match(html, /<summary/, '折叠态要有可点的摘要行');
    // And exactly one round is open: two open rounds is the layout that pushed the
    // conversation off the screen.
    const openCount = (html.match(/<details[^>]*\sopen[^>]*>/g) || []).length;
    assert.equal(openCount, 1, '只有最新一轮展开');
  });

  await t.test('侧栏里说的话，Mini App 也能看到（两边是同一个会话）', async () => {
    // The Host chat side panel and the Mini App show the same runtime session. The page
    // must therefore show what was said in the panel — otherwise the two views disagree
    // about the conversation, which is worse than either one alone.
    const client = await loadClient();
    await client.settle();

    // The server pushes the transcript when the session changes.
    client.fireSse('chat.history', {
      messages: [
        { id: 'm1', role: 'user', text: '从宿主侧栏说的话', source: 'communication', createdAt: 1000 },
        { id: 'm2', role: 'assistant', text: '大哥在侧栏里的回复', source: 'communication', createdAt: 1100 },
      ],
    });
    await client.settle();

    const html = client.element('chat-log').innerHTML;
    assert.match(html, /从宿主侧栏说的话/, '侧栏里说的话要出现在 Mini App 里');
    assert.match(html, /大哥在侧栏里的回复/, '侧栏里大哥的回复也要出现');
    // And it is marked, so the user can tell which view it came from.
    assert.match(html, /chat__from-host/, '侧栏来的消息要有标记');
  });

  await t.test('页面刷新后对话记录还在（记录在运行时会话里，不在页面里）', async () => {
    const client = await loadClient();
    await client.settle();

    // The page reads the transcript back on load.
    const historyCall = client.calls.find((c) => c.url.startsWith('/api/chat/history'));
    assert.ok(historyCall, '页面启动时必须拉一次会话历史');
  });

  await t.test('?theme=light 能强制浅色主题（发布出去的 CSS 本来就有这个钩子）', async () => {    const client = await loadClient({ search: '?theme=light' });
    await client.settle();

    assert.equal(
      documentShim.documentElement.getAttribute('data-theme'),
      'light',
      '根元素上必须落 data-theme="light"，CSS 才有浅色变量可用',
    );
  });

  await t.test('?theme= 给了非法值时不乱改主题', async () => {
    const client = await loadClient({ search: '?theme=neon' });
    await client.settle();

    assert.equal(
      documentShim.documentElement.getAttribute('data-theme'),
      null,
      '非法主题值要当作没给，不能落到任意一个主题上',
    );
    void client;
  });

  await t.test('看门狗告警：日志把时间、类型、持续时长和送达状态都说出来', async () => {
    alertsOverride = {
      alerts: [
        {
          at: Date.now() - 30 * 60_000,
          action: 'stale',
          title: '仿身泪滴 · 大哥掉线',
          body: '已 30 分钟没有交班（超过 20 分钟阈值）。',
          delivered: false,
          error: '通知没送出去',
          note: null,
          gapTo: null,
        },
        {
          at: Date.now() - 5 * 60_000,
          action: 'recovered',
          title: '仿身泪滴 · 大哥已归位',
          body: '已恢复交班。掉线持续约 12 分钟。',
          delivered: true,
          error: null,
          note: null,
          gapTo: null,
        },
      ],
    };
    try {
      const client = await loadClient();
      await client.navigate('#/alerts');
      await client.settle();

      const body = client.element('alerts-body');
      assert.ok(body, '告警面板要存在');
      const html = body.innerHTML;
      assert.match(html, /掉线/, '要标出告警类型');
      assert.match(html, /归位/, '恢复也要有自己的说法');
      assert.match(html, /30 分钟/, '要给出持续时长');
      assert.match(html, /12 分钟/, '恢复告警也要有持续时长');
      assert.match(html, /未送达/, '没送到的通知要说出来');
      assert.match(html, /已送达/, '送到的通知也要说出来');
      assert.match(html, /通知没送出去/, '没送达的原因要写出来');
      assert.match(html, /仿身泪滴 · 大哥掉线/, '告警标题要渲染出来');
      assert.match(client.element('alerts-count').textContent, /2 条/, '计数要说清楚');
    } finally {
      alertsOverride = null;
    }
  });

  await t.test('看门狗告警：告警里的运行时文本必须转义', async () => {
    alertsOverride = {
      alerts: [{
        at: Date.now(),
        action: 'stale',
        title: '<script>alert(1)</script>',
        body: '已 5 分钟没有交班',
        delivered: false,
        error: '<img src=x onerror=alert(1)>',
        note: null,
      }],
    };
    try {
      const client = await loadClient();
      await client.navigate('#/alerts');
      await client.settle();

      const html = client.element('alerts-body').innerHTML;
      assert.equal(html.includes('<script>'), false, '标题里的标签不能被当成标签渲染');
      assert.match(html, /&lt;script&gt;/, '标题要转义后显示');
      assert.equal(html.includes('<img src=x'), false, '错误信息里的标签不能被当成标签渲染');
    } finally {
      alertsOverride = null;
    }
  });

  await t.test('看门狗告警：加载中、空和读失败说得不是同一句话', async () => {
    // 读取一直没回来：这是「正在加载」。
    const loading = await loadClient({ hang: ['/api/watchdog/alerts'] });
    await loading.navigate('#/alerts');
    await loading.settle();
    assert.match(
      loading.element('alerts-body').innerHTML,
      /正在加载告警日志/,
      '读取没回来时说「正在加载」',
    );

    // 日志里一条都没有：这是「没有告警」。
    alertsOverride = { alerts: [] };
    try {
      const empty = await loadClient();
      await empty.navigate('#/alerts');
      await empty.settle();
      assert.match(
        empty.element('alerts-body').innerHTML,
        /看门狗还没有报过警/,
        '没有告警时说「还没有报过警」',
      );
    } finally {
      alertsOverride = null;
    }

    // 读取失败：这和「没有告警」是两件事，必须分开说。
    const broken = await loadClient({ fail: ['/api/watchdog/alerts'] });
    await broken.navigate('#/alerts');
    await broken.settle();
    assert.match(
      broken.element('alerts-body').innerHTML,
      /告警日志读取失败/,
      '读失败要说失败，不能装作没有告警',
    );
  });

  await t.test('刷新页面后，在途的派工会被读回来', async () => {
    dispatchStatusOverride = { id: 'd1', status: 'done', text: '好，交给你了', error: null };
    const store = createStorage();

    // 第一页：下达一条指令，页面自己记住派工 id。
    const first = await loadClient({ storage: store });
    await first.settle();
    await dispatchToAlpha(first, '把 alpha 的结算逻辑修一下');

    // 第二页：相当于刷新页面。同一个存储，派工 id 还在。
    const second = await loadClient({ storage: store, keepStorage: true });
    await second.settle();

    const read = second.calls.find((call) => call.url.startsWith('/api/dispatch/'));
    assert.ok(read, '刷新后必须把派工记录读回来');
    assert.match(read.url, /\/api\/dispatch\/d1$/, '读回的是刚才那条派工');
    assert.match(toastText(second), /指令已投递给目标会话/, '读回来的结果要告诉大老板');
  });

  await t.test('恢复出来的派工结果，和 SSE 派工事件说同一句话', async () => {
    // 现场：SSE 派工事件。
    const live = await loadClient();
    await live.settle();
    live.fireSse('dispatch', {
      dispatchId: 'd1',
      status: 'done',
      delivered: true,
      text: '好，交给你了',
      error: null,
    });
    await live.settle();
    const liveText = toastText(live);
    assert.match(liveText, /指令已投递给目标会话/);

    // 恢复：先下达一条指令（页面记住 id），再刷新，从服务端读回同一条。
    dispatchStatusOverride = { id: 'd1', status: 'done', text: '好，交给你了', error: null };
    const store = createStorage();
    const first = await loadClient({ storage: store });
    await first.settle();
    await dispatchToAlpha(first, '把 alpha 的结算逻辑修一下');

    const second = await loadClient({ storage: store, keepStorage: true });
    await second.settle();
    const restoredText = toastText(second);

    assert.equal(
      restoredText,
      liveText,
      '恢复出来的结果必须和现场事件一模一样——同一个派工不能有两种说法',
    );
  });

  await t.test('刷新后派工还在跑，看板说「仍在投递中」，跑完了才报结果', async () => {
    // 第一次读到「还在跑」，第二次才拿到结果。
    let reads = 0;
    dispatchStatusOverride = () => {
      reads += 1;
      return reads === 1
        ? { id: 'd1', status: 'running', text: '', error: null }
        : { id: 'd1', status: 'done', text: '好，交给你了', error: null };
    };

    const store = createStorage();
    const first = await loadClient({ storage: store });
    await first.settle();
    await dispatchToAlpha(first, '把 alpha 的结算逻辑修一下');

    const second = await loadClient({ storage: store, keepStorage: true });
    await second.settle();
    assert.match(
      toastText(second),
      /指令仍在投递中/,
      '还在跑要说还在跑——不能把在途说成失败',
    );

    // 页面会继续盯着：跑完了才报结果。
    await new Promise((resolve) => setTimeout(resolve, 1700));
    await second.settle();
    assert.match(toastText(second), /指令已投递给目标会话/, '派工跑完了要说结果');
  });
});
