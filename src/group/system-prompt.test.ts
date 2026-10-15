import assert from "node:assert/strict";
import test from "node:test";

import { buildSystemPrompt } from "./system-prompt.ts";

test("fills the user tag, the other members and the agent's own name", () => {
  const prompt = buildSystemPrompt({
    username: "alice",
    self: "claude",
    others: ["codex", "grok"],
  });
  assert.match(prompt, /^In this group chat, your name is `claude`\.$/mu);
  assert.match(prompt, /your own tag is\nnot included:/u);
  assert.match(prompt, /^- <alice>: the user\.\n- <codex>\n- <grok>\n\nTags are flat/mu);
  assert.doesNotMatch(prompt, /<claude>/u);
  assert.match(prompt, /^- Reply with the message body only\. Do not add your own member tag/mu);
  assert.doesNotMatch(prompt, /working directory/u);
  assert.match(prompt, /temporary previews[\s\S]*`~\/preview`/u);
  assert.match(prompt, /without creating subdirectories/u);
  assert.match(prompt, /project name and your own name, such as\n\s+`myapp-logo-claude-1\.svg`/u);
  assert.match(prompt, /an agent's own config directory or `\/tmp`/u);
  assert.match(prompt, /`\/view` previews only Markdown documents and images/u);
  assert.match(prompt, /Do not provide HTML or other executable\s+formats as previews/u);
  assert.match(prompt, /`\/view\?path=`[\s\S]*URL-encoded absolute path/u);
  assert.match(prompt, /"alice sent an attachment"/u);
  assert.doesNotMatch(prompt, /\{(username|self|other_members)\}/u);
});

test("drops the member line when there are no other AIs", () => {
  const prompt = buildSystemPrompt({ username: "host", self: "claude", others: [] });
  assert.match(prompt, /^- <host>: the user\.\n\nTags are flat/mu);
});

test("does not expand placeholders that appear inside filled values", () => {
  const prompt = buildSystemPrompt({ username: "host", self: "{other_members}", others: ["{username}"] });
  assert.match(prompt, /your name is `\{other_members\}`\./u);
  assert.match(prompt, /^- <\{username\}>$/mu);
});

test("appends the user's collaboration rules under their own heading", () => {
  const prompt = buildSystemPrompt({
    username: "host",
    self: "claude",
    others: [],
    collaboration: "\n  - Keep the first round short.\n\n",
  });
  assert.match(prompt, /just say so\.\n\n# User's collaboration rules\n\n[^\n]+\n\n- Keep the first round short\.\n$/u);
});

test("omits the collaboration section when it is blank", () => {
  const base = buildSystemPrompt({ username: "host", self: "claude", others: [] });
  assert.equal(buildSystemPrompt({ username: "host", self: "claude", others: [], collaboration: " \n\t" }), base);
  assert.doesNotMatch(base, /collaboration rules/u);
});
