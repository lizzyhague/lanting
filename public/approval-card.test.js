import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { t } from "./i18n.test-support.js";
import vm from "node:vm";

const [source, styles] = await Promise.all([
  readFile(new URL("./app.js", import.meta.url), "utf8"),
  readFile(new URL("./styles.css", import.meta.url), "utf8"),
]);

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.listeners = new Map();
    this.textContent = "";
  }

  append(...children) {
    this.children.push(...children);
  }

  addEventListener(name, listener) {
    this.listeners.set(name, listener);
  }

  replaceChildren(...children) {
    this.children = children;
  }

  querySelectorAll() {
    return [];
  }
}

test("approvals use the Relayu three-part card without losing the agent color", () => {
  const approvalList = new FakeElement("div");
  const context = vm.createContext({
    t,
    state: {
      current: {
        group: {},
        approvals: new Map([["approval-1", {
          approvalId: "approval-1",
          agent: "codex",
          toolName: "Shell",
          detail: "command: npm test",
          deadline: 1234,
        }]]),
      },
    },
    elements: { approvalList, composerStatus: { textContent: "" } },
    document: {
      createElement: (tagName) => new FakeElement(tagName),
      createTextNode: (textContent) => ({ textContent }),
    },
    agentDot: () => new FakeElement("span"),
    memberColor: () => "#123456",
    paintAgent: (element, color) => { element.agentColor = color; },
    request: async () => ({}),
    errorMessage: (error) => error.message,
    startCountdown() {},
    stopCountdown() {},
  });
  vm.runInContext(
    source.slice(source.indexOf("function renderApprovals("), source.indexOf("function startCountdown(")) +
      source.slice(source.indexOf("function localText("), source.indexOf("const RECONNECT_DELAY_MS")) +
      source.slice(source.indexOf("/** A tool name the backend sent"), source.indexOf("/**\n * The first option shows")),
    context,
  );
  context.renderApprovals();

  const card = approvalList.children[0];
  assert.equal(card.className, "permission-card");
  assert.equal(card.agentColor, "#123456");
  assert.deepEqual(card.children.map((child) => child.className), [
    "permission-card-title",
    "permission-card-body",
    "permission-card-actions",
  ]);
  assert.equal(card.children[1].children[0].textContent, "command: npm test");
  assert.deepEqual(card.children[2].children.slice(1).map((button) => button.textContent), ["拒绝", "允许"]);
});

test("approval cards match the composer width with a 16px gap", () => {
  assert.match(styles, /\.approval-list\s*\{[^}]*max-width:\s*calc\(var\(--max-width\) \+ 2rem\);[^}]*margin:\s*0 auto 1rem;/su);
  assert.match(styles, /\.approval-list\s*\{[^}]*gap:\s*0\.5rem;[^}]*padding:\s*0 calc\(1rem \+ var\(--scrollbar-width, 0px\)\);/su);
  assert.match(styles, /\.permission-card\s*\{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\) auto;[^}]*border:\s*1px solid var\(--agent, var\(--theme\)\);/su);
  assert.match(styles, /\.permission-card-body\s*\{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;/su);
});
