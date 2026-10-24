import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const STORE_KEY = "dsh-recent-sessions:store:v1";
const LEGACY_KEY = "dsh-project-radar:store:v1";
const DAY = 86400000;

let loaded = null;
const storage = new Map();
let failWrites = false;

const localStorageMock = {
  getItem(key) {
    return storage.has(key) ? storage.get(key) : null;
  },
  setItem(key, value) {
    if (failWrites) throw new Error("quota exceeded");
    storage.set(key, String(value));
  },
  removeItem(key) {
    storage.delete(key);
  },
};

const fakeWindow = {
  __ModuleLoader__: {
    load(config) {
      loaded = config;
    },
  },
};

const fakeDocument = {
  head: { appendChild() {} },
  getElementById() {
    return null;
  },
  createElement() {
    return { id: "", textContent: "", remove() {} };
  },
};

const fakeConsole = { log() {}, warn() {}, error() {} };

const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  Component: class {
    constructor(props) {
      this.props = props;
      this.state = {};
    }
  },
  useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
  useEffect: () => {},
};

vm.runInNewContext(fs.readFileSync(new URL("../lib/client.js", import.meta.url), "utf8"), {
  window: fakeWindow,
  document: fakeDocument,
  localStorage: localStorageMock,
  console: fakeConsole,
  process: { env: { NODE_ENV: "test" } },
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  AbortController,
  navigator: { clipboard: { writeText: async () => {} } },
});

const bundle = loaded.factory((name) => {
  if (name === "react") return fakeReact;
  throw new Error(`unexpected require(${name})`);
});
const api = bundle.__test;

let hookIndex = 0;
let hookValues = [];
fakeReact.useState = (initial) => {
  const index = hookIndex;
  hookIndex += 1;
  if (!(index in hookValues)) {
    hookValues[index] = typeof initial === "function" ? initial() : initial;
  }
  const set = (value) => {
    hookValues[index] = typeof value === "function" ? value(hookValues[index]) : value;
  };
  return [hookValues[index], set];
};
fakeReact.useEffect = () => {
  hookIndex += 1;
};

function renderWithHooks(component, props) {
  hookIndex = 0;
  hookValues = [];
  return component(props);
}

/** 第二次渲染：保留 hook 状态（模拟 setState 之后的重渲染）。 */
function rerenderWithHooks(component, props) {
  hookIndex = 0;
  return component(props);
}

function walk(node, visit) {
  if (node == null) return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node !== "object") return;
  visit(node);
  for (const child of node.children || []) walk(child, visit);
}

function collectText(node, out = []) {
  if (node == null) return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out);
    return out;
  }
  if (typeof node === "object") {
    for (const child of node.children || []) collectText(child, out);
  }
  return out;
}

function makePanelProps(overrides = {}) {
  const now = Date.now();
  const list = {
    ids: ["s1", "s2", "s3", "s4"],
    byId: {
      s1: { title: "settled", cwd: "C:\\work\\a", updatedAt: now - 1000 },
      s2: { title: "unknown", cwd: "C:\\work\\b", updatedAt: now - 2000 },
      s3: { title: "with thought", cwd: "C:\\work\\c", updatedAt: now - 3000 },
      s4: { title: "delivered thought", cwd: "C:\\work\\d", updatedAt: now - 4000 },
    },
    projectionsBySession: {
      s1: { values: { turnOutline: [{ prompt: "question", response: "answer" }] } },
      s4: { values: { turnOutline: [{ prompt: "old question", response: "old answer" }] } },
    },
    phase: "ready",
  };
  const statuses = new Map([["s1", {}], ["s2", {}], ["s3", {}], ["s4", {}]]);
  const ws = {
    items: [
      { path: "C:\\work\\a", sessionIds: ["s1"] },
      { path: "C:\\work\\b", sessionIds: ["s2"] },
      { path: "C:\\work\\c", sessionIds: ["s3"] },
      { path: "C:\\work\\d", sessionIds: ["s4"] },
    ],
    pinnedSessionIds: new Set(),
    archivedSessionIds: new Set(),
  };
  return {
    useSessions: () => list,
    useSessionStatus: () => statuses,
    useWorkspaces: () => ws,
    t: tZh,
    openSession() {},
    refreshProjections: async () => {},
    searchSessions: async () => ({ items: [] }),
    canOpenWorkspacePath: async () => false,
    openWorkspacePath: async () => {},
    ...overrides,
  };
}

const tZh = (key, vars) => {
  const raw = api.DICT.zh[key] !== undefined ? api.DICT.zh[key] : key;
  return vars
    ? String(raw).replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m))
    : raw;
};
const tEn = (key, vars) => {
  const raw = api.DICT.en[key] !== undefined ? api.DICT.en[key] : key;
  return vars
    ? String(raw).replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m))
    : raw;
};

function resetStorage() {
  api.resetStore();
  storage.clear();
  failWrites = false;
}

test("test-only API is exposed", () => {
  assert.ok(api);
  assert.equal(typeof bundle.apply, "function");
  assert.equal(bundle.inject.join(","), "slots,locale,sessions,remote,uiWorkspace,uiSession");
});

test("dictionary fallback and tOf", () => {
  assert.equal(api.fallbackT("justNow"), "刚刚");
  assert.equal(api.fallbackT("minutesAgo", { n: 5 }), "5 分钟前");
  assert.equal(api.fallbackT("lastAnswer", { text: "ok" }), "它的结论：ok");
  assert.equal(api.fallbackT("missing-key"), "missing-key");
  assert.equal(api.tOf({ t: (key) => `bound:${key}` })("panel"), "bound:panel");
  assert.equal(api.tOf({})("panel"), "最近会话");
});

test("relative time is localized", () => {
  const now = 1_700_000_000_000;
  assert.equal(api.relTime(0, now, tZh), "—");
  assert.equal(api.relTime(now - 30_000, now, tZh), "刚刚");
  assert.equal(api.relTime(now - 5 * 60_000, now, tZh), "5 分钟前");
  assert.equal(api.relTime(now - 3 * 3_600_000, now, tZh), "3 小时前");
  assert.equal(api.relTime(now - DAY, now, tZh), "昨天");
  assert.equal(api.relTime(now - 3 * DAY, now, tZh), "3 天前");
  assert.equal(api.relTime(now - 10 * DAY, now, tZh), "1 周前");
  assert.equal(api.relTime(now - 61 * DAY, now, tZh), "2 个月前");
  assert.equal(api.relTime(now - 5 * 60_000, now, tEn), "5 min ago");
});

test("time buckets use local midnight and a rolling seven days", () => {
  const now = new Date(2026, 9, 22, 12, 0, 0).getTime();
  const start = new Date(now).setHours(0, 0, 0, 0);
  assert.equal(api.bucketOf(now - 3_600_000, now), "today");
  assert.equal(api.bucketOf(start - 3_600_000, now), "yesterday");
  assert.equal(api.bucketOf(start - 3 * DAY, now), "week");
  assert.equal(api.bucketOf(start - 6 * DAY, now), "week");
  assert.equal(api.bucketOf(start - 6 * DAY - 1, now), "earlier");
  assert.equal(api.bucketOf(0, now), "earlier");
});

test("directory labels handle Windows, POSIX and empty paths", () => {
  const t = (key) => (key === "unregisteredDir" ? "(unregistered)" : key);
  assert.equal(api.dirLabel("C:\\Users\\me\\proj", t), "proj");
  assert.equal(api.dirLabel("/a/b/", t), "b");
  assert.equal(api.dirLabel("", t), "(unregistered)");
  assert.equal(api.dirLabel("plain", t), "plain");
});

test("turnOutlineOf distinguishes unknown from empty", () => {
  const turns = [{ prompt: "hello" }];
  assert.equal(api.turnOutlineOf({ values: { turnOutline: turns } }), turns);
  assert.equal(api.turnOutlineOf({ values: {} }), null);
  assert.equal(api.turnOutlineOf({ values: { turnOutline: "nope" } }), null);
  assert.equal(api.turnOutlineOf(null), null);
});

test("has supports Sets and arrays", () => {
  assert.equal(api.has(new Set(["a"]), "a"), true);
  assert.equal(api.has(["a"], "a"), true);
  assert.equal(api.has(["a"], "b"), false);
  assert.equal(api.has(null, "a"), false);
  assert.equal(api.has({ a: true }, "a"), false);
});

test("addThought persists and trims trailing whitespace", () => {
  resetStorage();
  const result = api.addThought("s1", "  hello  ");
  assert.equal(result.persisted, true);
  assert.equal(result.entry.text, "  hello");
  assert.equal(result.entry.status, "pending");
  assert.equal(api.storeLoad().thoughts.length, 1);
  assert.equal(JSON.parse(storage.get(STORE_KEY)).thoughts.length, 1);
});

test("empty thoughts are ignored", () => {
  resetStorage();
  assert.equal(api.addThought("s1", "   \n\t"), null);
  assert.equal(api.storeLoad().thoughts.length, 0);
});

test("addThought rolls back when localStorage rejects the write", () => {
  resetStorage();
  failWrites = true;
  const result = api.addThought("s1", "hello");
  assert.equal(result.entry, null);
  assert.equal(result.persisted, false);
  assert.equal(api.storeLoad().thoughts.length, 0);
  assert.equal(storage.has(STORE_KEY), false);
});

test("legacy project-radar store migrates once", () => {
  resetStorage();
  storage.set(LEGACY_KEY, JSON.stringify({
    thoughts: [{ id: "old", sessionId: "s", text: "old", createdAt: 1, status: "pending" }],
    view: { sort: "stale" },
  }));
  const store = api.storeLoad();
  assert.equal(store.thoughts.length, 1);
  assert.equal(store.view.sort, "stale");
  assert.equal(storage.has(LEGACY_KEY), false);
  assert.equal(JSON.parse(storage.get(STORE_KEY)).thoughts.length, 1);
});

test("malformed thought entries are ignored", () => {
  resetStorage();
  storage.set(STORE_KEY, JSON.stringify({
    thoughts: [
      { text: "no session" },
      { sessionId: "s", text: "ok" },
      null,
    ],
  }));
  assert.equal(api.storeLoad().thoughts.length, 1);
  assert.equal(api.storeLoad().thoughts[0].text, "ok");
});

test("apply registers the panel, sidebar entry and dock", () => {
  const registrations = [];
  const ctx = {
    get(service) {
      if (service === "uiWorkspace") return { openSession() {} };
      if (service === "sessions") return { refreshProjections: async () => {}, search: async () => ({ items: [] }) };
      if (service === "remote") {
        return { session: { canOpenWorkspacePath: async () => false, openWorkspacePath: async () => {} } };
      }
      return null;
    },
    locale: {
      bind: () => (key) => key,
      register: () => () => {},
    },
    slots: {
      inject(name, factory) {
        return factory();
      },
      register(meta, component) {
        registrations.push({ meta, component });
        return () => {};
      },
    },
    effect(fn) {
      const disposer = fn();
      return () => {
        if (typeof disposer === "function") disposer();
      };
    },
  };

  bundle.apply(ctx);
  assert.deepEqual(
    registrations.map((item) => item.meta.name),
    ["main", "sidebar.panellist", "conversation.input.dock"],
  );
  const sidebar = registrations.find((item) => item.meta.name === "sidebar.panellist");
  assert.equal(sidebar.meta.label(), "panel");
  assert.equal(registrations.find((item) => item.meta.name === "main").component.name, "RecentPanelSlot");
  assert.equal(registrations.find((item) => item.meta.name === "conversation.input.dock").component.name, "ThoughtDockSlot");
});

test("only unfinished keeps unknown projections visible and hides settled ones", () => {
  resetStorage();
  storage.set(STORE_KEY, JSON.stringify({
    view: { onlyUnfinished: true },
    thoughts: [
      { id: "t1", sessionId: "s3", text: "remember", createdAt: 1, status: "pending" },
      { id: "t2", sessionId: "s4", text: "already delivered", createdAt: 2, status: "delivered" },
    ],
  }));
  api.resetStore();

  const tree = renderWithHooks(api.RecentPanel, makePanelProps());
  const rowIds = [];
  walk(tree, (node) => {
    if (node.type === api.RecentRow) rowIds.push(node.props.row.id);
  });
  assert.deepEqual(rowIds.sort(), ["s2", "s3"]);
  assert.match(collectText(tree).join(" "), /正在核对未收尾状态/);
});

function findOne(node, predicate) {
  let found = null;
  walk(node, (item) => {
    if (!found && predicate(item)) found = item;
  });
  return found;
}

function makeStore(initial) {
  let value = initial;
  const listeners = new Set();
  return {
    getSnapshot: () => value,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next) {
      value = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

test("a session that finishes while you are elsewhere is marked unread", () => {
  resetStorage();
  const status = makeStore(new Map([["s1", { running: true }], ["s2", {}]]));
  const current = makeStore({ key: "s2" });
  const dispose = api.watchCompletions({ sessionStatus: status, current });
  assert.equal(typeof dispose, "function");
  assert.equal(api.finishedWhileAway.has("s1"), false);

  status.set(new Map([["s1", { running: false }], ["s2", {}]]));
  assert.equal(api.finishedWhileAway.has("s1"), true);

  // 打开 1 号会话 → 不再算未看
  current.set({ key: "s1" });
  assert.equal(api.finishedWhileAway.has("s1"), false);

  // 又跑起来 → 清掉；跑完时如果人就在这个会话里，也不标
  status.set(new Map([["s1", { running: true }], ["s2", {}]]));
  assert.equal(api.finishedWhileAway.has("s1"), false);
  status.set(new Map([["s1", { running: false }], ["s2", {}]]));
  assert.equal(api.finishedWhileAway.has("s1"), false);

  dispose();
});

test("completion watch falls back to the session row's running flag", () => {
  resetStorage();
  const status = makeStore(new Map([["s9", {}]]));
  const list = makeStore({ byId: { s9: { running: true } } });
  const current = makeStore({ key: "s2" });
  const dispose = api.watchCompletions({ sessionStatus: status, current }, { list });
  list.set({ byId: { s9: { running: false } } });
  assert.equal(api.finishedWhileAway.has("s9"), true);
  dispose();
  api.finishedWhileAway.clear();
});

test("the panel turns a locally-marked completion into the done dot", () => {
  resetStorage();
  api.finishedWhileAway.set("s2", Date.now());
  const tree = renderWithHooks(api.RecentPanel, makePanelProps());
  const row = findOne(tree, (node) => node.type === api.RecentRow && node.props.row.id === "s2");
  assert.equal(row.props.row.status.completionUnread, true);
  assert.equal(api.statusState(row.props.row.status), "done");
});

test("status slot follows the native session status rules", () => {
  const mark = (status, blank = false) => {
    const tree = api.StatusMark({ status, blank, t: tZh });
    return {
      dot: findOne(tree, (node) => node.props && node.props.className === "dsh-recent-dot"),
      spinner: findOne(tree, (node) => node.props && node.props.className === "dsh-recent-spinner"),
      slot: findOne(tree, (node) => node.props && node.props.className === "dsh-recent-status"),
      text: collectText(tree).join(""),
    };
  };

  // 空闲：原生不画点，只留空槽
  const idle = mark({});
  assert.ok(idle.slot);
  assert.equal(idle.dot, null);
  assert.equal(idle.spinner, null);
  assert.equal(idle.text, "");
  assert.equal(mark(undefined).dot, null);

  // 运行中：转圈，不是绿点
  const running = mark({ running: true });
  assert.equal(running.dot, null);
  assert.ok(running.spinner);
  assert.equal(running.text, "进行中");

  // 未读完成：绿点（done）
  const done = mark({ completionUnread: true });
  assert.equal(done.dot.props["data-state"], "done");
  assert.equal(done.spinner, null);
  assert.equal(done.text, "已完成");

  // 待处理交互：warning 点，且压过运行中
  const pending = mark({ pendingInteraction: { kind: "approval" } });
  assert.equal(pending.dot.props["data-state"], "warning");
  assert.equal(pending.text, "等待审批");
  assert.equal(mark({ running: true, pendingInteraction: { kind: "question" } }).dot.props["data-state"], "warning");

  // 空会话不显示状态
  assert.equal(mark({ running: true }, true).spinner, null);

  assert.equal(api.statusState({ running: true, completionUnread: true }), "ongoing");
  assert.equal(api.statusState({ completionUnread: true }), "done");
  // 子会话在跑 = 运行中；未知 pending 类型按原生规则忽略
  assert.equal(api.statusState({ runningSubagentCount: 1 }), "ongoing");
  assert.equal(api.statusState({ pendingInteraction: { kind: "made-up" } }), "idle");
});

test("a parent whose subagent is running counts as running", () => {
  resetStorage();
  const props = makePanelProps();
  const list = props.useSessions();
  list.projectionsBySession.s1 = {
    values: {
      turnOutline: [{ prompt: "question", response: "answer" }],
      subagentCatalog: [{ id: "c1" }, { id: "c2" }],
    },
  };
  const statuses = new Map([["s1", {}], ["c1", { running: true }], ["c2", { running: false }]]);
  props.useSessionStatus = () => statuses;

  const tree = renderWithHooks(api.RecentPanel, props);
  const row = findOne(tree, (node) => node.type === api.RecentRow && node.props.row.id === "s1");
  assert.equal(row.props.row.status.runningSubagentCount, 1);
  assert.equal(api.statusState(row.props.row.status), "ongoing");
  assert.equal(api.statusLabel(row.props.row.status, tZh), "1 个子会话运行中");
});

test("pending sessions show the native trailing label instead of a relative time", () => {
  const baseRow = {
    id: "s1",
    title: "A session",
    dir: "C:\\work\\a",
    dirLabel: "a",
    at: Date.now() - 5 * 60 * 1000,
    pinned: false,
    lastPrompt: "",
    lastResponse: "",
  };
  const render = (status) => renderWithHooks(api.RecentRow, {
    row: { ...baseRow, status },
    t: tZh,
    now: Date.now(),
    thoughts: [],
    openSession() {},
    onFilterDir() {},
    onReveal() {},
    onCopyPath() {},
    onStorageError() {},
    canReveal: false,
  });

  const pendingTime = findOne(render({ pendingInteraction: { kind: "plan-review" } }), (node) => node.props && node.props.className === "dsh-recent-time");
  assert.equal(collectText(pendingTime).join(""), "计划待审");
  assert.equal(pendingTime.props["aria-hidden"], true);

  const idleTime = findOne(render({}), (node) => node.props && node.props.className === "dsh-recent-time");
  assert.match(collectText(idleTime).join(""), /分钟前/);
  assert.equal(idleTime.props["aria-hidden"], undefined);
});

test("row uses a title button instead of a nested-button container", () => {
  const row = {
    id: "s1",
    title: "A session",
    dir: "C:\\work\\a",
    dirLabel: "a",
    at: Date.now(),
    pinned: false,
    status: {},
    lastPrompt: "hello",
    lastResponse: "hi",
  };
  const tree = renderWithHooks(api.RecentRow, {
    row,
    t: tZh,
    now: Date.now(),
    thoughts: [],
    openSession() {},
    onFilterDir() {},
    onReveal() {},
    onCopyPath() {},
    onStorageError() {},
    canReveal: false,
  });

  let container = null;
  const buttons = [];
  walk(tree, (node) => {
    if (node.props && node.props.className === "dsh-recent-item") container = node;
    if (node.type === "button") buttons.push(node);
  });
  assert.ok(container);
  assert.equal(container.props.role, undefined);
  assert.equal(container.props.tabIndex, undefined);
  assert.equal(container.props.onKeyDown, undefined);

  const titleButton = buttons.find((node) => node.props.className === "dsh-recent-ttl");
  assert.ok(titleButton);
  assert.match(titleButton.props["aria-label"], /打开会话：A session/);
});

test("dock renders pending thoughts and ignores delivered ones", () => {
  resetStorage();
  storage.set(STORE_KEY, JSON.stringify({
    thoughts: [
      { id: "t1", sessionId: "s1", text: "pending thought", createdAt: 1, status: "pending" },
      { id: "t2", sessionId: "s1", text: "already delivered", createdAt: 2, status: "delivered" },
    ],
  }));
  api.resetStore();

  const tree = renderWithHooks(api.ThoughtDock, {
    sessionId: "s1",
    t: tZh,
    inputActions: {},
  });
  const text = collectText(tree).join(" ");
  assert.match(text, /pending thought/);
  assert.match(text, /1 条想法/);
  assert.doesNotMatch(text, /already delivered/);
});

test("projection requests are cached per session", async () => {
  api.resetStore();
  let calls = 0;
  await api.ensureProjection("p1", async () => {
    calls += 1;
  });
  await api.ensureProjection("p1", async () => {
    calls += 1;
  });
  assert.equal(calls, 1);
});

test("thought updates roll back when localStorage rejects the write", () => {
  resetStorage();
  const added = api.addThought("s1", "hello");
  const id = added.entry.id;

  failWrites = true;
  assert.equal(api.patchThought(id, { status: "delivered" }), false);
  assert.equal(api.storeLoad().thoughts[0].status, "pending");
  assert.equal(api.removeThought(id), false);
  assert.equal(api.storeLoad().thoughts.length, 1);
  assert.equal(api.muteDock("s1"), false);
  assert.equal(api.storeLoad().dockMuted.s1, undefined);

  failWrites = false;
  assert.equal(api.patchThought(id, { status: "delivered" }), true);
  assert.equal(api.storeLoad().thoughts[0].status, "delivered");
  assert.equal(api.removeThought(id), true);
  assert.equal(api.storeLoad().thoughts.length, 0);
  assert.equal(api.muteDock("s1"), true);
  assert.equal(typeof api.storeLoad().dockMuted.s1, "number");
});

test("runWithConcurrency respects its limit", async () => {
  let active = 0;
  let maxActive = 0;
  const items = [1, 2, 3, 4, 5, 6];
  await api.runWithConcurrency(items, 2, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
  }, () => true);
  assert.equal(maxActive, 2);
});

test("pinned sessions stay above newer unpinned ones", () => {
  resetStorage();
  const now = Date.now();
  const props = makePanelProps();
  props.useSessions = () => ({
    ids: ["oldPinned", "fresh"],
    byId: {
      oldPinned: { title: "old but pinned", cwd: "C:\\a", updatedAt: now - 40 * DAY },
      fresh: { title: "fresh", cwd: "C:\\b", updatedAt: now - 60_000 },
    },
    projectionsBySession: {},
    phase: "ready",
  });
  props.useSessionStatus = () => new Map([["oldPinned", {}], ["fresh", {}]]);
  props.useWorkspaces = () => ({
    items: [],
    pinnedSessionIds: new Set(["oldPinned"]),
    archivedSessionIds: new Set(),
  });

  const tree = renderWithHooks(api.RecentPanel, props);
  const order = [];
  walk(tree, (node) => {
    if (node.type === api.RecentRow) order.push(node.props.row.id);
  });
  assert.deepEqual(order, ["oldPinned", "fresh"]);
  // 置顶组不再按时间桶拆开：它自己就是一个分组
  assert.match(collectText(tree).join(" "), /已置顶 · 1/);
  assert.doesNotMatch(collectText(tree).join(" "), /今天 · 2/);
});

test("the completion watch stays silent when the active session is unreadable", () => {
  resetStorage();
  const status = makeStore(new Map([["s1", { running: true }]]));
  // 只有 subscribe、没有 getSnapshot：拿不到「你正在看谁」就别判，免得误标你正盯着的会话
  const current = { subscribe: () => () => {} };
  const dispose = api.watchCompletions({ sessionStatus: status, current });
  status.set(new Map([["s1", { running: false }]]));
  assert.equal(api.finishedWhileAway.has("s1"), false);
  dispose();
});

test("a thought that is already gone is not reported as a storage failure", () => {
  resetStorage();
  assert.equal(api.patchThought("does-not-exist", { status: "delivered" }), true);
});

test("view changes roll back when the write is rejected", () => {
  resetStorage();
  assert.equal(api.storeSetView({ sort: "stale" }), true);
  assert.equal(api.storeLoad().view.sort, "stale");

  failWrites = true;
  assert.equal(api.storeSetView({ onlyUnfinished: true }), false);
  assert.equal(api.storeLoad().view.onlyUnfinished, undefined);
  assert.equal(api.storeLoad().view.sort, "stale");
});

test("legacy thoughts survive a rejected migration write", () => {
  resetStorage();
  storage.set(LEGACY_KEY, JSON.stringify({
    thoughts: [{ id: "old", sessionId: "s", text: "keep me", createdAt: 1, status: "pending" }],
  }));
  failWrites = true;

  assert.equal(api.storeLoad().thoughts[0].text, "keep me");
  assert.equal(storage.has(STORE_KEY), false);

  // 配额恢复后，下一次加载会重做迁移，并把旧键清掉
  failWrites = false;
  api.resetStore();
  assert.equal(api.storeLoad().thoughts.length, 1);
  assert.equal(storage.has(LEGACY_KEY), false);
});

test("a thought counts as inserted when the host returns void", () => {
  resetStorage();
  storage.set(STORE_KEY, JSON.stringify({
    thoughts: [{ id: "t1", sessionId: "s1", text: "carry on", createdAt: 1, status: "pending" }],
  }));
  api.resetStore();

  const calls = [];
  const inputActions = {
    captureInsertion: () => ({ from: 0, to: 0 }),
    insertText(text, span) {
      calls.push({ text, span }); // 宿主实现返回 void
    },
  };
  const props = { sessionId: "s1", t: tZh, inputActions };

  let tree = renderWithHooks(api.ThoughtDock, props);
  const expand = findOne(tree, (node) => node.type === "button" && collectText([node]).join("") === "展开");
  expand.props.onClick();

  tree = rerenderWithHooks(api.ThoughtDock, props);
  const insert = findOne(tree, (node) => node.type === "button" && collectText([node]).join("") === "填入输入框");
  insert.props.onClick();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, "carry on");
  assert.deepEqual(calls[0].span, { from: 0, to: 0 });
  assert.equal(api.storeLoad().thoughts[0].status, "delivered");
  assert.equal(typeof api.storeLoad().dockMuted.s1, "number");
});
