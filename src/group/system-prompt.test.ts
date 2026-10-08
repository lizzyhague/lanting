import assert from "node:assert/strict";
import test from "node:test";

import { buildSystemPrompt } from "./system-prompt.ts";

test("fills the host tag and the other members", () => {
  const prompt = buildSystemPrompt({
    username: "alice",
    others: ["codex", "grok"],
  });
  assert.match(prompt, /^- <alice>: the host, i\.e\. the user\.\n- <codex>\n- <grok>\n\n## How/mu);
  assert.doesNotMatch(prompt, /working directory/u);
  assert.match(prompt, /temporary previews[\s\S]*`~\/preview`/u);
  assert.match(prompt, /without creating subdirectories/u);
  assert.match(prompt, /an agent's own config directory or `\/tmp`/u);
  assert.match(prompt, /`\/view\?path=`[\s\S]*URL-encoded absolute path/u);
  assert.match(prompt, /"alice sent an attachment"/u);
  assert.doesNotMatch(prompt, /\{(username|other_members)\}/u);
});

test("drops the member line when there are no other AIs", () => {
  const prompt = buildSystemPrompt({ username: "host", others: [] });
  assert.match(prompt, /^- <host>: the host, i\.e\. the user\.\n\n## How/mu);
});

test("does not expand placeholders that appear inside filled values", () => {
  const prompt = buildSystemPrompt({ username: "host", others: ["{username}"] });
  assert.match(prompt, /^- <\{username\}>$/mu);
});
