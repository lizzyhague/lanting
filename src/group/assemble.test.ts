import assert from "node:assert/strict";
import test from "node:test";

import { assembleMessage } from "./assemble.ts";
import type { TranscriptEntry } from "./types.ts";

let seq = 0;
function host(text: string): TranscriptEntry {
  return { seq: ++seq, at: "", from: { role: "host" }, text };
}
function agent(name: string, text: string, status: TranscriptEntry["status"] = "completed"): TranscriptEntry {
  return { seq: ++seq, at: "", from: { role: "agent", agent: name }, text, status };
}

test("wraps each speaker in flat tags and skips the recipient's own replies", () => {
  const entries = [
    host("first question"),
    agent("claude", "claude answer"),
    agent("codex", "codex answer"),
    host("follow-up"),
  ];
  assert.equal(
    assembleMessage(entries, "codex", "lizard"),
    [
      "<lizard>\nfirst question\n</lizard>",
      "<claude>\nclaude answer\n</claude>",
      "<lizard>\nfollow-up\n</lizard>",
    ].join("\n\n"),
  );
});

test("does not forward interrupted or failed replies", () => {
  const entries = [
    host("q"),
    agent("claude", "half", "interrupted"),
    agent("grok", "", "failed"),
  ];
  assert.equal(assembleMessage(entries, "codex", "host"), "<host>\nq\n</host>");
});

test("returns an empty string when nothing is new", () => {
  assert.equal(assembleMessage([], "codex", "host"), "");
  assert.equal(assembleMessage([agent("codex", "mine")], "codex", "host"), "");
});
