import { readFile } from "node:fs/promises";
import vm from "node:vm";

/*
 * Loads the real strings.js and i18n.js with Chinese selected and installs lantingI18n globally, so modules and
 * app.js excerpts under test show the same text as the page. Import it before the modules under test.
 */
const [strings, i18n] = await Promise.all([
  readFile(new URL("./strings.js", import.meta.url), "utf8"),
  readFile(new URL("./i18n.js", import.meta.url), "utf8"),
]);

const window = { addEventListener() {}, dispatchEvent() {} };
const context = {
  window,
  navigator: { languages: ["zh-CN"], language: "zh-CN" },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  document: { readyState: "complete", documentElement: { setAttribute() {} }, querySelectorAll: () => [] },
  Event: class { constructor(type) { this.type = type; } },
};
vm.runInNewContext(`${strings}\n${i18n}`, context);

export const lantingI18n = window.lantingI18n;
export const t = lantingI18n.t;
globalThis.lantingI18n = lantingI18n;
