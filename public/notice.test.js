import assert from "node:assert/strict";
import test from "node:test";

import { createNoticeController, NOTICE_DURATION_MS } from "./notice.js";

class FakeTarget {
  hidden = false;
  disabled = false;
  textContent = "";
  dataset = {};
  #listeners = new Map();
  #children = new Set();

  add(child) {
    this.#children.add(child);
  }

  contains(target) {
    return target === this || this.#children.has(target);
  }

  addEventListener(type, listener) {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.#listeners.get(type)?.delete(listener);
  }

  emit(type, event = {}) {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

class FakeClock {
  time = 0;
  #nextId = 0;
  #timers = new Map();

  now = () => this.time;

  setTimeout = (callback, delay) => {
    const id = ++this.#nextId;
    this.#timers.set(id, { callback, at: this.time + delay });
    return id;
  };

  clearTimeout = (id) => {
    this.#timers.delete(id);
  };

  advance(milliseconds) {
    const end = this.time + milliseconds;
    while (true) {
      const next = [...this.#timers.entries()]
        .filter(([, timer]) => timer.at <= end)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!next) break;
      const [id, timer] = next;
      this.#timers.delete(id);
      this.time = timer.at;
      timer.callback();
    }
    this.time = end;
  }
}

function harness(onActionError = () => {}) {
  const element = new FakeTarget();
  const textElement = new FakeTarget();
  const actionButton = new FakeTarget();
  const closeButton = new FakeTarget();
  element.add(actionButton);
  element.add(closeButton);
  const document = new FakeTarget();
  document.visibilityState = "visible";
  const clock = new FakeClock();
  const controller = createNoticeController({
    element,
    textElement,
    actionButton,
    closeButton,
    document,
    clock,
    onActionError,
  });
  return { controller, element, textElement, actionButton, closeButton, document, clock };
}

test("temporary notices use tone defaults and hide after visible time", () => {
  const h = harness();
  h.controller.show("完成", { lifetime: "temporary", tone: "info" });
  h.clock.advance(NOTICE_DURATION_MS.info - 1);
  assert.equal(h.element.hidden, false);
  h.clock.advance(1);
  assert.equal(h.element.hidden, true);
});

test("an older timer cannot hide a replacement notice", () => {
  const h = harness();
  h.controller.show("A", { lifetime: "temporary", tone: "info" });
  h.clock.advance(4_000);
  h.controller.show("B", { lifetime: "temporary", tone: "error" });
  h.clock.advance(1_000);
  assert.equal(h.textElement.textContent, "B");
  h.clock.advance(NOTICE_DURATION_MS.error - 1_001);
  assert.equal(h.element.hidden, false);
  h.clock.advance(1);
  assert.equal(h.element.hidden, true);
});

test("state notices clear only for their own key", () => {
  const h = harness();
  h.controller.show("重连中", { lifetime: "state", tone: "warning", key: "connection" });
  assert.equal(h.controller.clear("another-state"), false);
  assert.equal(h.element.hidden, false);
  assert.equal(h.controller.clear("connection"), true);
  assert.equal(h.element.hidden, true);
});

test("manual dismissal suppresses the same state until it resolves", () => {
  const h = harness();
  const options = { lifetime: "state", tone: "warning", key: "approval:one" };
  h.controller.show("等待审批", options);
  h.closeButton.emit("click");
  assert.equal(h.element.hidden, true);
  assert.equal(h.controller.show("等待审批", options), null);
  h.controller.clear("approval:one");
  assert.notEqual(h.controller.show("新的审批", options), null);
  assert.equal(h.textElement.textContent, "新的审批");
});

test("temporary time pauses while hidden, hovered, or focused", () => {
  const h = harness();
  h.controller.show("稍后消失", { lifetime: "temporary", tone: "info" });
  h.clock.advance(1_000);
  h.document.visibilityState = "hidden";
  h.document.emit("visibilitychange");
  h.clock.advance(20_000);
  assert.equal(h.element.hidden, false);
  h.document.visibilityState = "visible";
  h.document.emit("visibilitychange");
  h.clock.advance(1_000);
  h.element.emit("pointerenter");
  h.clock.advance(20_000);
  assert.equal(h.element.hidden, false);
  h.element.emit("pointerleave");
  h.clock.advance(1_000);
  h.element.emit("focusin");
  h.clock.advance(20_000);
  assert.equal(h.element.hidden, false);
  h.element.emit("focusout", { relatedTarget: null });
  h.clock.advance(1_999);
  assert.equal(h.element.hidden, false);
  h.clock.advance(1);
  assert.equal(h.element.hidden, true);
});

test("an action runs once and its rejection is reported as a new error", async () => {
  const errors = [];
  const h = harness((error) => errors.push(error));
  let calls = 0;
  h.controller.show("可以撤销", {
    lifetime: "temporary",
    tone: "info",
    durationMs: NOTICE_DURATION_MS.undo,
    action: {
      label: "撤销",
      run: async () => {
        calls += 1;
        throw new Error("撤销失败");
      },
    },
  });
  h.actionButton.emit("click");
  h.actionButton.emit("click");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(h.element.hidden, true);
  assert.equal(errors[0]?.message, "撤销失败");
});

test("replacement removes stale actions and button state", () => {
  const h = harness();
  h.controller.show("第一条", {
    lifetime: "persistent",
    tone: "error",
    key: "retry",
    action: { label: "重试", run() {} },
  });
  h.actionButton.disabled = true;
  h.controller.show("第二条", { lifetime: "temporary", tone: "info" });
  assert.equal(h.actionButton.hidden, true);
  assert.equal(h.actionButton.disabled, false);
  assert.equal(h.actionButton.textContent, "");
  assert.equal(h.closeButton.hidden, false);
  assert.equal(h.element.dataset.lifetime, "temporary");
});
