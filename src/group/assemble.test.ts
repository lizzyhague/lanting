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

test("the author receives delivery results without its own reply text for every outcome", () => {
  for (const status of ["completed", "interrupted", "failed"] as const) {
    const entry = agent("claude", "original reply", status);
    entry.deliveries = [{ path: "/work/result.txt", name: "result.txt", status: "failed", reason: "interrupted" }];
    assert.equal(assembleMessage([entry], "claude", "host"),
      '<lanting>\nDelivery results for "claude": "result.txt": failed (Reply interrupted; not delivered)\n</lanting>');
    assert.equal(assembleMessage([entry], "codex", "host"), status === "completed"
      ? '<claude>\noriginal reply\n</claude>\n\n<lanting>\nDelivery results for "claude": "result.txt": failed (Reply interrupted; not delivered)\n</lanting>'
      : "");
  }
});

test("successful and failed delivery results follow the speaker as a separate platform block", () => {
  const entry = agent("claude", "original reply");
  entry.deliveries = [
    { path: "/work/a.txt", name: "a.txt", status: "available", attachmentId: "id", size: 5, expiresAtMs: 100,
      binding: { caller: "lanting", projectId: "demo", sessionId: "group" } },
    { path: "/work/b.txt", name: "b.txt", status: "failed", reason: "file_changed" },
  ];
  const result = assembleMessage([entry, host("next")], "codex", "host");
  assert.equal(result, '<claude>\noriginal reply\n</claude>\n\n<lanting>\nDelivery results for "claude": "a.txt": delivered; "b.txt": failed (File changed while being saved)\n</lanting>\n\n<host>\nnext\n</host>');
  assert.doesNotMatch(result, /binding|expiresAtMs|attachmentId|\/work/);
});
