import assert from "node:assert/strict";
import test from "node:test";

import { buildSystemPrompt } from "./system-prompt.ts";

test("fills the host tag, the other members, and the working directory", () => {
  const prompt = buildSystemPrompt({
    username: "alice",
    cwd: "/work/demo",
    others: [{ tag: "codex", name: "Codex" }, { tag: "grok", name: "Grok" }],
  });
  assert.match(prompt, /^- <alice>: the host, i\.e\. the user\.\n- <codex>: Codex\n- <grok>: Grok\n\n## How/mu);
  assert.match(prompt, /The working directory is \/work\/demo\./u);
  assert.match(prompt, /"<alice> sent an attachment"/u);
  assert.doesNotMatch(prompt, /\{(username|other_members|cwd)\}/u);
});

test("drops the member line when there are no other AIs", () => {
  const prompt = buildSystemPrompt({ username: "host", cwd: "/w", others: [] });
  assert.match(prompt, /^- <host>: the host, i\.e\. the user\.\n\n## How/mu);
});

test("does not expand placeholders that appear inside filled values", () => {
  const prompt = buildSystemPrompt({ username: "host", cwd: "/w/{username}", others: [] });
  assert.match(prompt, /The working directory is \/w\/\{username\}\./u);
});
