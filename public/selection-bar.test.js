import assert from "node:assert/strict";
import test from "node:test";

import { createSelectionBar, trashRemainingText } from "./selection-bar.js";

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.attributes = {};
    this.listeners = new Map();
    this.hidden = false;
    this.disabled = false;
    this.textContent = "";
    this.title = "";
    this.id = "";
    this.type = "";
    this.className = "";
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  emit(type) {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
  *walk() {
    for (const child of this.children) {
      yield child;
      yield* child.walk();
    }
  }
}

const document = {
  createElement: (tagName) => new FakeElement(tagName),
  createElementNS: (_namespace, tagName) => new FakeElement(tagName),
};

function remoteViews() {
  return {
    active: { actions: [
      { id: "archive", label: "归档", resultLabel: "归档", icon: "archive" },
      { id: "trash-active", label: "删除", resultLabel: "删除", icon: "delete", danger: true, retention: true },
    ] },
    archived: { actions: [
      { id: "unarchive", label: "取消归档", resultLabel: "取消归档", icon: "unarchive" },
      { id: "trash-archived", label: "删除", resultLabel: "删除", icon: "delete", danger: true, retention: true },
    ] },
    trash: { actions: [
      { id: "restore-trash", label: "恢复", resultLabel: "恢复", icon: "restore" },
      { id: "delete-trash", label: "永久删除", resultLabel: "永久删除", icon: "purge", danger: true, permanent: true },
    ] },
  };
}

function groupViews() {
  return {
    active: { actions: [
      { id: "trash-active", label: "删除", resultLabel: "删除", icon: "delete", danger: true, retention: true },
    ] },
    trash: { actions: [
      { id: "restore-trash", label: "恢复", resultLabel: "恢复", icon: "restore" },
      { id: "delete-trash", label: "永久删除", resultLabel: "永久删除", icon: "purge", danger: true, permanent: true },
    ] },
  };
}

function item(id, overrides = {}) {
  return { id, title: id.toUpperCase(), selectable: true, pinned: false, ...overrides };
}

function harness({
  views = remoteViews(),
  initialView = "active",
  noun = "会话",
  backLabel = "返回最近会话",
  permanentDeleteDetail = "会话原文会一并删除",
  getActionUnavailableReason = () => "",
} = {}) {
  const container = new FakeElement();
  const executions = [];
  const notices = [];
  const confirmations = [];
  const busyChanges = [];
  let result = { succeeded: [], failed: [] };
  let confirmResult = true;
  let renders = 0;
  let refreshes = 0;
  const controller = createSelectionBar({
    container,
    views,
    initialView,
    noun,
    backLabel,
    untitledLabel: noun === "群" ? "未命名群" : "新会话",
    permanentDeleteDetail,
    getId: (entry) => entry.id,
    getTitle: (entry) => entry.title,
    isSelectable: (entry) => entry.selectable,
    isPinned: (entry) => entry.pinned,
    getActionUnavailableReason,
    executeAction: async (action, ids) => {
      executions.push({ action, ids });
      return result;
    },
    refreshItems: async () => { refreshes++; },
    confirm: async (message, options) => {
      confirmations.push({ message, options });
      return confirmResult;
    },
    notify: (message, tone) => notices.push({ message, tone }),
    onSelectionChange: () => { renders++; },
    onBusyChange: (busy) => busyChanges.push(busy),
    document,
  });
  const byId = (id) => [container, ...container.walk()].find((element) => element.id === id);
  return {
    controller,
    container,
    executions,
    notices,
    confirmations,
    busyChanges,
    byId,
    get renders() { return renders; },
    get refreshes() { return refreshes; },
    setResult(next) { result = next; },
    rejectConfirm() { confirmResult = false; },
  };
}

test("generates fixed buttons for both Remote and lanting parameter sets", () => {
  const remote = harness();
  for (const id of [
    "selection-action-archive",
    "selection-action-trash-active",
    "selection-action-unarchive",
    "selection-action-trash-archived",
    "selection-action-restore-trash",
    "selection-action-delete-trash",
    "selection-select-all-button",
    "selection-select-none-button",
  ]) assert.ok(remote.byId(id), id);
  assert.equal(remote.byId("selection-action-archive").hidden, false);
  assert.equal(remote.byId("selection-action-unarchive").hidden, true);

  const lanting = harness({
    views: groupViews(),
    noun: "群",
    backLabel: "返回最近群会话",
    permanentDeleteDetail: "群聊中涉及的每个 CLI 会话原文一并删除",
  });
  assert.equal(lanting.byId("selection-action-archive"), undefined);
  assert.ok(lanting.byId("selection-action-trash-active"));
  assert.ok(lanting.byId("selection-action-delete-trash"));
  assert.equal(lanting.byId("selection-back-button").title, "返回最近群会话");
});

test("trash derives selection mode while ordinary views use the manual flag", () => {
  const h = harness();
  assert.equal(h.controller.isSelecting(), false);
  h.controller.setManualSelection(true);
  assert.equal(h.controller.isSelecting(), true);
  h.controller.setView("trash");
  assert.equal(h.controller.isSelecting(), true);
  assert.equal(h.byId("selection-back-button").hidden, false);
  assert.equal(h.byId("selection-cancel-button").hidden, true);
  h.controller.setView("active");
  assert.equal(h.controller.isSelecting(), false);
});

test("select all uses every visible selectable unpinned item without a front-end limit", () => {
  const h = harness();
  const items = Array.from({ length: 150 }, (_, index) => item(`item-${index}`));
  items.push(item("pinned", { pinned: true }), item("busy", { selectable: false }));
  h.controller.setManualSelection(true);
  h.controller.reconcile(items);
  h.controller.toggle("pinned");
  h.byId("selection-select-all-button").emit("click");

  assert.equal(h.controller.selectedIds().length, 151);
  assert.equal(h.controller.isSelected("pinned"), true);
  assert.equal(h.controller.isSelected("busy"), false);
  assert.equal(h.byId("selection-select-all-button").hidden, true);
  assert.equal(h.byId("selection-select-none-button").hidden, false);

  h.byId("selection-select-none-button").emit("click");
  assert.deepEqual(h.controller.selectedIds(), []);
});

test("reconcile drops missing and newly unavailable selections", () => {
  const h = harness();
  h.controller.setManualSelection(true);
  h.controller.reconcile([item("a"), item("b")]);
  h.controller.toggle("a");
  h.controller.toggle("b");
  h.controller.reconcile([item("b", { selectable: false }), item("c")]);
  assert.deepEqual(h.controller.selectedIds(), []);
});

test("a project-wide busy reason disables selection actions without hiding trash selection", () => {
  const h = harness({ initialView: "trash" });
  h.controller.reconcile([item("a")]);
  h.controller.toggle("a");
  h.controller.setDisabled(true, "这个项目有正在执行的任务，暂时不能整理会话。");
  assert.equal(h.container.hidden, false);
  assert.equal(h.byId("selection-action-restore-trash").disabled, true);
  assert.equal(h.byId("selection-select-none-button").disabled, true);
  assert.equal(
    h.byId("selection-action-restore-trash").title,
    "这个项目有正在执行的任务，暂时不能整理会话。",
  );
  assert.equal(h.controller.toggle("a"), false);
});

test("an item can disable only one action and expose its reason", async () => {
  const reason = "选中的会话里有正在永久删除的，不能恢复。";
  const h = harness({
    initialView: "trash",
    getActionUnavailableReason: (action, entry) =>
      action.id === "restore-trash" && entry.deleting ? reason : "",
  });
  h.controller.reconcile([item("a"), item("deleting", { deleting: true })]);
  h.controller.toggle("a");
  h.controller.toggle("deleting");

  assert.equal(h.byId("selection-action-restore-trash").disabled, true);
  assert.equal(h.byId("selection-action-restore-trash").title, reason);
  assert.equal(h.byId("selection-action-delete-trash").disabled, false);
  assert.equal(await h.controller.runAction("restore-trash"), null);
  assert.deepEqual(h.executions, []);
});

test("an adapter cancellation keeps the current selection without refreshing or notifying", async () => {
  const h = harness();
  h.controller.setManualSelection(true);
  h.controller.reconcile([item("a")]);
  h.controller.toggle("a");
  h.setResult({ cancelled: true });

  assert.deepEqual(await h.controller.runAction("archive"), { cancelled: true });
  assert.equal(h.controller.isSelecting(), true);
  assert.deepEqual(h.controller.selectedIds(), ["a"]);
  assert.equal(h.refreshes, 0);
  assert.deepEqual(h.notices, []);
});

test("trash keeps only failed items selected and reports the first reason", async () => {
  const h = harness({ initialView: "trash" });
  h.controller.reconcile([item("a"), item("b")]);
  h.controller.toggle("a");
  h.controller.toggle("b");
  h.setResult({ succeeded: ["a"], failed: [{ id: "b", reason: "仍在删除" }] });
  await h.controller.runAction("restore-trash");

  assert.deepEqual(h.controller.selectedIds(), ["b"]);
  assert.deepEqual(h.executions, [{ action: "restore-trash", ids: ["a", "b"] }]);
  assert.deepEqual(h.notices, [{ message: "已完成 1 项，1 项失败：仍在删除", tone: "error" }]);
  assert.deepEqual(h.busyChanges, [true, false]);
  assert.equal(h.refreshes, 1);
});

test("ordinary-view success exits selection and uses the retention notice", async () => {
  const h = harness();
  h.controller.setManualSelection(true);
  h.controller.reconcile([item("a"), item("b")]);
  h.controller.toggle("a");
  h.controller.toggle("b");
  h.setResult({ succeeded: ["a", "b"], failed: [] });
  await h.controller.runAction("trash-active");

  assert.equal(h.controller.isSelecting(), false);
  assert.deepEqual(h.controller.selectedIds(), []);
  assert.deepEqual(h.notices, [{
    message: "已删除 2 个会话，30 天后自动永久删除。",
    tone: "info",
  }]);
});

for (const scenario of [
  {
    label: "Remote",
    options: {},
    expectedTitle: "永久删除会话",
    expectedDetail: "会话原文会一并删除",
  },
  {
    label: "lanting",
    options: {
      views: groupViews(),
      noun: "群",
      permanentDeleteDetail: "群聊中涉及的每个 CLI 会话原文一并删除",
    },
    expectedTitle: "永久删除群",
    expectedDetail: "群聊中涉及的每个 CLI 会话原文一并删除",
  },
]) {
  test(`${scenario.label} permanent deletion uses its parameterized copy`, async () => {
    const h = harness({ initialView: "trash", ...scenario.options });
    h.controller.reconcile([item("a", { title: "标题" })]);
    h.controller.toggle("a");
    h.rejectConfirm();
    await h.controller.runAction("delete-trash");
    assert.equal(h.executions.length, 0);
    assert.equal(h.confirmations[0].options.title, scenario.expectedTitle);
    assert.match(h.confirmations[0].message, new RegExp(scenario.expectedDetail, "u"));
  });
}

test("trash remaining text accepts seconds, milliseconds, ISO text and expired values", () => {
  const now = Date.UTC(2026, 0, 1);
  assert.equal(trashRemainingText((now + 25 * 60 * 60_000) / 1_000, now), "2 天后自动删除");
  assert.equal(trashRemainingText(now + 60 * 60_000, now), "1 天后自动删除");
  assert.equal(trashRemainingText(new Date(now + 3 * 86_400_000).toISOString(), now), "3 天后自动删除");
  assert.equal(trashRemainingText(now - 1, now), "即将自动删除");
  assert.equal(trashRemainingText(null, now), "30 天后自动删除");
});
