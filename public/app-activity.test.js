import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./app.js", import.meta.url), "utf8");
const start = source.indexOf('    case "agent.activity.updated":');
const end = source.indexOf('    case "entry.appended":', start);
assert.ok(start >= 0 && end > start);
const handler = `function handle(event) { switch (event.type) { ${source.slice(start, end)} } }`;

test("late tool details replace one row without clearing the reply or adding rows", () => {
  let renders = 0;
  const current = { round: { text: "Answer", activities: [
    { kind: "tool", toolName: "bash", detail: "" },
    { kind: "tool", toolName: "Read", detail: "file.ts" },
  ] } };
  const context = vm.createContext({ current, renderLive: () => { renders++; } });
  vm.runInContext(handler, context);
  const activity = { kind: "tool", toolName: "bash", detail: "pwd" };
  context.handle({ type: "agent.activity.updated", index: 0, activity });
  assert.equal(current.round.text, "Answer");
  assert.equal(current.round.activities.length, 2);
  assert.equal(current.round.activities[0], activity);
  assert.equal(current.round.activities[1].detail, "file.ts");
  assert.equal(renders, 1);
  context.handle({ type: "agent.activity.updated", index: 2, activity });
  assert.equal(renders, 1);
  current.round = null;
  context.handle({ type: "agent.activity.updated", index: 0, activity });
  assert.equal(renders, 1);
});
