import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { t } from "./i18n.test-support.js";
import vm from "node:vm";

import { createSelectionBar, trashRemainingText } from "./selection-bar.js";

const source = await readFile(new URL("./app.js", import.meta.url), "utf8");

function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `missing section ${start}`);
  return source.slice(from, to);
}

const plain = (value) => JSON.parse(JSON.stringify(value));

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.textContent = "";
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = "";
    this.id = "";
    this.title = "";
    this.type = "";
    this.className = "";
    this.tabIndex = 0;
    this.classList = { add() {}, toggle() {} };
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  emit(name, event = {}) { return this.listeners[name]?.(event); }
  get text() {
    return [this.textContent, ...this.children.map((child) => child.text)].join(" ").trim();
  }
  *walk() {
    for (const child of this.children) {
      yield child;
      yield* child.walk();
    }
  }
}

function summary(id, overrides = {}) {
  return {
    id,
    title: id.toUpperCase(),
    directory: "one",
    members: [],
    updatedAt: 1,
    pinned: false,
    archived: false,
    busy: false,
    busyStatus: null,
    trashedAt: null,
    purgeAt: null,
    deleting: false,
    ...overrides,
  };
}

function harness({ view = "groups", groups = [] } = {}) {
  const requests = [];
  const responders = [];
  const notices = [];
  const confirmations = [];
  const elements = new Proxy({}, {
    get(target, key) {
      if (!target[key]) target[key] = new FakeElement();
      return target[key];
    },
  });
  elements.directorySelect.value = "one";
  const context = vm.createContext({
    t,
    GROUP_SELECTION_RESTORE_DELETING_MESSAGE: "选中的群里有正在永久删除的，不能恢复。",
    state: {
      authenticated: true,
      listView: view,
      groups: new Map(groups.map((group) => [group.id, group])),
      currentGroupId: null,
    },
    elements,
    document: {
      createElement: (tagName) => new FakeElement(tagName),
      createElementNS: (_namespace, tagName) => new FakeElement(tagName),
      createTextNode(text) {
        const node = new FakeElement("#text");
        node.textContent = text;
        return node;
      },
    },
    agentDot: () => new FakeElement("span"),
    groupRenameIcon: () => new FakeElement("svg"),
    groupPinIcon: () => new FakeElement("svg"),
    openRenameDialog() {},
    toggleGroupPin() {},
    openListedGroup() {},
    trashRemainingText,
    request(type, payload) {
      requests.push({ type, payload });
      const respond = responders.shift();
      if (!respond) return Promise.reject(new Error(`unexpected request ${type}`));
      return respond();
    },
  });
  vm.runInContext([
    section("function localText(", "const RECONNECT_DELAY_MS"),
    section("function visibleGroups()", "function groupRenameIcon("),
    section("function setListView(view)", "function agentDot("),
  ].join("\n"), context);

  const views = {
    groups: { actions: [
      { id: "archive", labelKey: "selection.archive", doneKey: "selection.doneArchive", icon: "archive" },
      { id: "trash-active", labelKey: "common.delete", doneKey: "selection.doneTrash", icon: "delete", danger: true },
    ] },
    archived: { actions: [
      { id: "unarchive", labelKey: "selection.unarchive", doneKey: "selection.doneUnarchive", icon: "unarchive" },
      { id: "trash-archived", labelKey: "common.delete", doneKey: "selection.doneTrash", icon: "delete", danger: true },
    ] },
    trash: { actions: [
      { id: "restore-trash", labelKey: "selection.restore", doneKey: "selection.doneRestore", icon: "restore" },
      { id: "delete-trash", labelKey: "selection.purge", doneKey: "selection.donePurge", icon: "purge", danger: true, permanent: true },
    ] },
  };
  const selectionBar = createSelectionBar({
    container: elements.selectionHeading,
    views,
    initialView: view,
    getId: (group) => group.id,
    getTitle: (group) => group.title,
    isSelectable: (group) => context.groupSelectable(group),
    isPinned: (group) => Boolean(group.pinned),
    getActionUnavailableReason: (action, group) =>
      context.groupActionUnavailableReason(action, group),
    executeAction: (action, ids) => context.executeGroupSelectionAction(action, ids),
    refreshItems: async () => context.renderGroupList(),
    confirm: async (message, options) => {
      confirmations.push({ message, options });
      return true;
    },
    notify: (message, tone) => notices.push({ message, tone }),
    onSelectionChange: () => context.renderGroupList(),
    onBusyChange: () => context.renderGroupList(),
    document: context.document,
  });
  context.selectionBar = selectionBar;
  context.renderGroupList();

  return {
    context,
    elements,
    selectionBar,
    requests,
    notices,
    confirmations,
    respond(value) {
      responders.push(() => value instanceof Error ? Promise.reject(value) : Promise.resolve(value));
    },
    byId(id) {
      return [elements.selectionHeading, ...elements.selectionHeading.walk()]
        .find((element) => element.id === id);
    },
    checkboxes() {
      return [...elements.groupList.walk()].filter((element) => element.type === "checkbox");
    },
  };
}

test("busy groups cannot be selected while pins remain manual-only", () => {
  const h = harness({ groups: [
    summary("busy", { busy: true, updatedAt: 3 }),
    summary("ordinary", { updatedAt: 2 }),
    summary("pinned", { directory: "two", pinned: true, updatedAt: 4 }),
  ] });
  h.selectionBar.setManualSelection(true);

  const [pinned, busy, ordinary] = h.checkboxes();
  assert.equal(pinned.disabled, false);
  assert.equal(busy.disabled, true);
  assert.equal(ordinary.disabled, false);

  h.byId("selection-select-all-button").emit("click");
  assert.deepEqual(h.selectionBar.selectedIds(), ["ordinary"]);
  assert.equal(h.selectionBar.toggle("busy"), false);
  assert.equal(h.selectionBar.toggle("pinned"), true);
  assert.deepEqual(h.selectionBar.selectedIds(), ["ordinary", "pinned"]);
});

test("deleting trash groups can be purged but block restore", async () => {
  const purgeAt = new Date(Date.now() + 3 * 86_400_000).toISOString();
  const h = harness({ view: "trash", groups: [
    summary("deleting", { trashedAt: new Date().toISOString(), purgeAt, deleting: true }),
    summary("ordinary", { trashedAt: new Date().toISOString(), purgeAt, updatedAt: 2 }),
  ] });

  assert.match(h.elements.groupList.text, /正在删除/u);
  assert.match(h.elements.groupList.text, /3 天后自动删除/u);
  h.byId("selection-select-all-button").emit("click");
  assert.deepEqual(h.selectionBar.selectedIds(), ["ordinary", "deleting"]);
  assert.equal(h.byId("selection-action-restore-trash").disabled, true);
  assert.equal(
    h.byId("selection-action-restore-trash").title,
    "选中的群里有正在永久删除的，不能恢复。",
  );
  assert.equal(h.byId("selection-action-delete-trash").disabled, false);

  h.respond({
    done: ["ordinary"],
    failed: [{ groupId: "deleting", message: "这个群正在删除。" }],
  });
  await h.selectionBar.runAction("delete-trash");
  assert.deepEqual(plain(h.requests), [{
    type: "groups.purge",
    payload: { groupIds: ["ordinary", "deleting"] },
  }]);
  assert.deepEqual(h.selectionBar.selectedIds(), ["deleting"]);
  assert.deepEqual(h.notices, [{
    message: "已完成 1 项，1 项失败：这个群正在删除。",
    tone: "error",
  }]);
  assert.equal(h.confirmations[0].options.title, "永久删除群");
  assert.match(h.confirmations[0].message, /每个 CLI 会话原文一并删除/u);
});

test("archived groups open in selection mode and use archive actions", async () => {
  const h = harness({ view: "archived", groups: [
    summary("active", { updatedAt: 3 }),
    summary("archived", { archived: true, updatedAt: 2 }),
    summary("trashed-archive", { archived: true, trashedAt: new Date().toISOString() }),
  ] });

  assert.equal(h.selectionBar.isSelecting(), true);
  assert.match(h.elements.groupList.text, /ARCHIVED/u);
  assert.doesNotMatch(h.elements.groupList.text, /ACTIVE/u);
  assert.doesNotMatch(h.elements.groupList.text, /TRASHED-ARCHIVE/u);
  h.byId("selection-select-all-button").emit("click");
  h.respond({ done: ["archived"], failed: [] });
  await h.selectionBar.runAction("unarchive");
  assert.deepEqual(plain(h.requests), [{
    type: "groups.unarchive",
    payload: { groupIds: ["archived"] },
  }]);
  assert.equal(h.selectionBar.isSelecting(), true);
});

test("directory changes and group creation both return to recent groups", () => {
  const directoryChange = section(
    'elements.directorySelect.addEventListener("change"',
    'elements.groupSearchInput.addEventListener("input"',
  );
  const groupCreation = section(
    'elements.createForm.addEventListener("submit"',
    "/* ---------- Group list, selection, archive and trash ---------- */",
  );
  assert.match(directoryChange, /state\.listView = "groups";[\s\S]*selectionBar\.setView\("groups"\)/u);
  assert.match(groupCreation, /setListView\("groups"\)/u);

  const h = harness({ view: "trash", groups: [
    summary("trashed", { trashedAt: new Date().toISOString(), deleting: false }),
  ] });
  h.selectionBar.toggle("trashed");
  h.context.setListView("groups");
  assert.equal(h.context.state.listView, "groups");
  assert.equal(h.selectionBar.isSelecting(), false);
  assert.deepEqual(h.selectionBar.selectedIds(), []);
});
