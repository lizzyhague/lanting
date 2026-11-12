import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const source = await readFile(new URL("./app.js", import.meta.url), "utf8");
const controls = source.slice(source.indexOf("function proxyControls("), source.indexOf("async function saveProxy("));
class Element {
  children = [];
  attributes = {};
  listeners = {};
  append(...children) { this.children.push(...children); }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(key, listener) { this.listeners[key] = listener; }
}
function setup(available) {
  const saves = [];
  const context = vm.createContext({
    document: { createElement: () => new Element(), createTextNode: (text) => text },
    state: { settings: { proxyAvailable: available } }, t: (key) => key,
    statusLine: (text) => text,
    saveProxy: (...args) => saves.push(args),
  });
  vm.runInContext(controls, context);
  return { render: (agent, locked = false) => context.proxyControls(agent, locked), saves };
}
test("proxy radios default to the deployment proxy and save an explicit direct choice", () => {
  const { render, saves } = setup(true);
  const row = render({ id: "member" });
  assert.equal(row.attributes.role, "radiogroup");
  const [direct, proxy] = row.children[1].children.map((label) => label.children[0]);
  assert.equal(direct.type, "radio");
  assert.equal(direct.name, proxy.name);
  assert.equal(proxy.checked, true);
  assert.equal(proxy.disabled, false);
  direct.checked = true;
  direct.listeners.change();
  assert.deepEqual(saves, [["member", false]]);
});
test("a deployment without a proxy disables that choice and explains why", () => {
  const { render } = setup(false);
  const row = render({ id: "member", useProxy: true });
  const [direct, proxy] = row.children[1].children.map((label) => label.children[0]);
  assert.equal(direct.checked, true);
  assert.equal(direct.disabled, false);
  assert.equal(proxy.checked, false);
  assert.equal(proxy.disabled, true);
  assert.equal(row.children[2], "setting.noProxy");
  const locked = render({ id: "member" }, true);
  assert.equal(locked.children[1].children[0].children[0].disabled, true);
});
