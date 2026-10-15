import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [html, styles, app, boot] = await Promise.all([
  readFile(new URL("./index.html", import.meta.url), "utf8"),
  readFile(new URL("./styles.css", import.meta.url), "utf8"),
  readFile(new URL("./app.js", import.meta.url), "utf8"),
  readFile(new URL("./boot.js", import.meta.url), "utf8"),
]);

test("the login card keeps its content aligned to the visible lanting mark", () => {
  assert.match(styles, /\.login-card > :not\(\.login-brand\)\s*\{[^}]*margin-inline:\s*0\.375rem;/su);
  assert.match(styles, /\.login-card input\s*\{[^}]*width:\s*auto;/su);
  assert.match(styles, /\.login-card button\s*\{[^}]*width:\s*auto;/su);
});

test("the login label is compact and browser validation does not intercept submission", () => {
  assert.match(html, /访问令牌<span class="login-label-hint">（登录状态存于浏览器）<\/span>/u);
  assert.doesNotMatch(html, /class="login-hint"/u);
  assert.doesNotMatch(html, /id="token-input"[^>]*\srequired(?:\s|>)/u);
});

test("login progress is yellow while login errors are red", () => {
  assert.match(styles, /#login-status:not\(\[data-tone="error"\]\):not\(\[data-tone="progress"\]\)/u);
  assert.match(styles, /#login-status\[data-tone="progress"\]\s*\{[^}]*color:\s*var\(--warning\) !important;/su);
  assert.match(app, /setLoginStatus\("请输入访问令牌。", "error"\)/u);
  assert.match(app, /setLoginStatus\("访问令牌有误，请重新输入。", "error"\)/u);
  assert.match(app, /setLoginStatus\("正在连接主机……", "progress"\)/u);
  assert.match(boot, /status\.dataset\.tone = "progress";[\s\S]*页面正在启动/u);
  assert.match(boot, /页面仍在启动，请稍候/u);
  assert.match(boot, /delete status\.dataset\.tone/u);
});
