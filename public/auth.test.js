import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./app.js", import.meta.url), "utf8");
const connectSource = source.slice(
  source.indexOf("async function connect("),
  source.indexOf("function scheduleReconnect("),
);

function harness(fetch, search = "") {
  const sockets = [];
  const actions = [];
  const context = vm.createContext({
    fetch,
    URL,
    URLSearchParams,
    location: {
      protocol: "https:",
      host: "example.com",
      origin: "https://example.com",
      search,
      replace: (href) => actions.push(["redirect", href]),
    },
    state: {
      generation: 0,
      reconnectTimer: null,
      reconnectAllowed: true,
      authenticated: false,
      socket: null,
      currentGroupId: null,
      groups: new Map(),
    },
    elements: {
      tokenInput: { value: "credential" },
      loginStatus: { textContent: "" },
      connectButton: { disabled: false },
    },
    clearTimeout() {},
    rejectPending() {},
    showLogin: () => actions.push(["login"]),
    showApp: () => actions.push(["app"]),
    setConnectionStatus() {},
    errorMessage: (error) => error.message,
    scheduleReconnect() {},
    loadAppState: async () => {},
    request: async () => {},
    closeGroup() {},
    openGroup: async () => {},
    handleSocketMessage() {},
    renderComposer() {},
    WebSocket: class {
      listeners = {};
      readyState = 1;
      static OPEN = 1;
      constructor(url) {
        this.url = url;
        sockets.push(this);
      }
      addEventListener(name, listener) { this.listeners[name] = listener; }
      close() {}
    },
  });
  vm.runInContext(connectSource, context);
  return { context, sockets, actions };
}

test("successful login returns only to a same-origin viewer", async () => {
  for (const target of [
    "/view?path=%2Fprojects%2Fdemo%2Fnote.md",
    "https://attacker.example/view?path=note.md",
    "//attacker.example/view?path=note.md",
  ]) {
    const { context, actions } = harness(
      async () => new Response("{}"),
      `?${new URLSearchParams({ returnTo: target })}`,
    );
    await context.connect();
    assert.equal(
      actions.some(([action]) => action === "redirect"),
      target.startsWith("/view?"),
    );
  }
});
