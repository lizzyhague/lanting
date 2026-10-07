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

test("attachments go to the agents called in that round; later agents only see a note with name and path", () => {
  const attachment = { id: "a1", originalName: "screen.png", mimeType: "image/png", kind: "image" as const, size: 3, path: "/blobs/a1" };
  const entries = [{
    seq: 1,
    at: "",
    from: { role: "host" as const },
    text: "look",
    attachments: [attachment],
    recipients: ["claude"],
  }];
  const forClaude = assembleMessage(entries, "claude", "host");
  assert.match(forClaude, /^<host>\nlook\n\n\[LANTING_ATTACHMENTS_V1\]/u);
  assert.ok(forClaude.includes('"path":"/blobs/a1"'));
  assert.equal(
    assembleMessage(entries, "grok", "host"),
    "<host>\nlook\n\nhost sent an attachment: screen.png (path: /blobs/a1)\n</host>",
  );
});
