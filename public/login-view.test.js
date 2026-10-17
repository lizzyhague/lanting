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

test("the wordmark uses Chinese calligraphy and Marck Script in English", () => {
  assert.equal((html.match(/class="brand-wordmark"/gu) ?? []).length, 3);
  assert.equal((html.match(/class="brand-wordmark-en" aria-hidden="true">Lanting<\/span>/gu) ?? []).length, 3);
  assert.match(styles, /@font-face\s*\{[^}]*font-family:\s*"Marck Script";[^}]*url\("marck-script\.ttf"\)/su);
  assert.match(styles, /:root\[lang="en"\] \.brand-wordmark-zh\s*\{[^}]*display:\s*none;/su);
  assert.match(styles, /:root\[lang="en"\] \.brand-wordmark-en\s*\{[^}]*display:\s*block;/su);
  assert.match(styles, /--brand-wordmark-color:\s*#f4f4f5;/u);
  assert.match(styles, /:root\[data-theme="light"\][^{]*\{[^}]*--brand-wordmark-color:\s*#242426;/su);
});

test("the login label is compact and browser validation does not intercept submission", () => {
  assert.match(html, /<label for="token-input"><span data-i18n="login\.tokenLabel">[^<]*<\/span><span class="login-label-hint" data-i18n="login\.tokenHint">/u);
  assert.doesNotMatch(html, /class="login-hint"/u);
  assert.doesNotMatch(html, /id="token-input"[^>]*\srequired(?:\s|>)/u);
});

test("login progress is yellow while login errors are red", () => {
  assert.match(styles, /#login-status:not\(\[data-tone="error"\]\):not\(\[data-tone="progress"\]\)/u);
  assert.match(styles, /#login-status\[data-tone="progress"\]\s*\{[^}]*color:\s*var\(--warning\) !important;/su);
  assert.match(app, /setLoginStatus\(t\("login\.tokenMissing"\), "error"\)/u);
  assert.match(app, /setLoginStatus\(t\("login\.tokenInvalid"\), "error"\)/u);
  assert.match(app, /setLoginStatus\(t\("login\.connecting"\), "progress"\)/u);
  assert.match(boot, /status\.dataset\.tone = "progress";[\s\S]*t\("boot\.starting"\)/u);
  assert.match(boot, /t\("boot\.stillStarting"\)/u);
  assert.match(boot, /delete status\.dataset\.tone/u);
});
