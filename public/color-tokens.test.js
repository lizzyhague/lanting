import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const styles = await readFile(new URL("./styles.css", import.meta.url), "utf8");

test("visible colors are declared in the color module", () => {
  // Color module = the leading :root (dark) + the light rules right after it, each starting with :root[data-theme="light"].
  const rootEnd = styles.indexOf("\n}");
  assert.notEqual(rootEnd, -1);
  const light = ':root[data-theme="light"]';
  const lightStart = styles.indexOf(light, rootEnd);
  assert.ok(lightStart !== -1 && styles.slice(rootEnd + 2, lightStart).trim().startsWith("/*"), "浅色块应紧跟在 :root 之后");
  const lastLight = styles.lastIndexOf(light);
  const moduleEnd = styles.indexOf("}", lastLight);
  const lightRules = styles.slice(lightStart, moduleEnd + 1).replaceAll(/\/\*[\s\S]*?\*\//gu, "");
  for (const rule of lightRules.match(/^[^\s}][^{]*\{/gmu) ?? []) assert.ok(rule.startsWith(light), rule);

  const rules = styles.slice(moduleEnd + 1).replaceAll(/\/\*[\s\S]*?\*\//gu, "");
  const mask = /(?:-webkit-)?mask-image:\s*linear-gradient\(to right, #000 calc\(100% - 1\.25rem\), transparent\);/gu;
  assert.equal(rules.match(mask)?.length, 2);
  assert.doesNotMatch(rules.replaceAll(mask, ""), /#[\da-f]{3,8}\b|(?:rgb|rgba|hsl|hsla)\(/iu);
});
