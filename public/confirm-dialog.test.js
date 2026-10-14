import assert from "node:assert/strict";
import test from "node:test";

import { createConfirmDialog } from "./confirm-dialog.js";

class FakeClassList {
  values = new Set();
  toggle(name, enabled) {
    if (enabled) this.values.add(name);
    else this.values.delete(name);
  }
  contains(name) { return this.values.has(name); }
}

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.listeners = new Map();
    this.classList = new FakeClassList();
    this.textContent = "";
    this.focused = false;
  }
  replaceChildren(...children) { this.children = children; }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  emit(type) {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
  focus() { this.focused = true; }
}

class FakeDialog extends FakeElement {
  open = false;
  returnValue = "";
  showModal() { this.open = true; }
  close(value = "") {
    this.returnValue = value;
    this.open = false;
    this.emit("close");
  }
}

function harness() {
  const dialog = new FakeDialog("dialog");
  const titleElement = new FakeElement("h2");
  const messageElement = new FakeElement();
  const acceptButton = new FakeElement("button");
  const cancelButton = new FakeElement("button");
  const controller = createConfirmDialog({
    dialog,
    titleElement,
    messageElement,
    acceptButton,
    cancelButton,
    document: { createElement: (tagName) => new FakeElement(tagName) },
  });
  return { controller, dialog, titleElement, messageElement, acceptButton, cancelButton };
}

test("shows paragraphs and resolves true only for the confirm return value", async () => {
  const h = harness();
  const result = h.controller.show("第一段\n\n第二段", {
    title: "永久删除会话",
    confirmLabel: "永久删除",
    danger: true,
  });

  assert.equal(h.dialog.open, true);
  assert.equal(h.titleElement.textContent, "永久删除会话");
  assert.deepEqual(h.messageElement.children.map((child) => child.textContent), ["第一段", "第二段"]);
  assert.equal(h.acceptButton.textContent, "永久删除");
  assert.equal(h.acceptButton.classList.contains("danger"), true);
  assert.equal(h.acceptButton.classList.contains("primary"), false);
  assert.equal(h.cancelButton.focused, true);

  h.dialog.close("confirm");
  assert.equal(await result, true);
});

test("cancel button closes the dialog and resolves false", async () => {
  const h = harness();
  const result = h.controller.show("确定吗？");
  h.cancelButton.emit("click");
  assert.equal(await result, false);
});

test("a replacement settles the previous prompt as cancelled", async () => {
  const h = harness();
  const first = h.controller.show("第一个");
  const second = h.controller.show("第二个");
  assert.equal(await first, false);
  h.dialog.close("confirm");
  assert.equal(await second, true);
});
