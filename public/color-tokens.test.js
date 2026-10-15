import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const styles = await readFile(new URL("./styles.css", import.meta.url), "utf8");

test("visible colors are declared in the color module", () => {
  const rootEnd = styles.indexOf("\n}");
  assert.notEqual(rootEnd, -1);

  const rules = styles.slice(rootEnd + 2).replaceAll(/\/\*[\s\S]*?\*\//gu, "");
  const mask = /(?:-webkit-)?mask-image:\s*linear-gradient\(to right, #000 calc\(100% - 1\.25rem\), transparent\);/gu;
  assert.equal(rules.match(mask)?.length, 2);
  assert.doesNotMatch(rules.replaceAll(mask, ""), /#[\da-f]{3,8}\b|(?:rgb|rgba|hsl|hsla)\(/iu);
});
