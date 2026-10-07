import assert from "node:assert/strict";
import test from "node:test";

import { PathRedactor } from "./redact.ts";

const redactor = new PathRedactor(new Map([
  ["/data/blobs/ab/abc123", "screen.png"],
  ["/data/blobs/ab/abc123-long", "notes.txt"],
]));

test("paths in text and nested values become file names, longest first", () => {
  assert.equal(redactor.redact("read /data/blobs/ab/abc123-long and /data/blobs/ab/abc123"), "read notes.txt and screen.png");
  assert.deepEqual(redactor.redactDeep({ kind: "tool", detail: "file_path: /data/blobs/ab/abc123", n: 1 }), {
    kind: "tool",
    detail: "file_path: screen.png",
    n: 1,
  });
});

test("a path split across streamed deltas never reaches the output", () => {
  const stream = redactor.stream();
  const pieces = ["Looking at /data/bl", "obs/ab/abc12", "3 now", " — done."];
  let output = "";
  for (const piece of pieces) {
    const chunk = stream.push(piece);
    assert.ok(!chunk.includes("/data/"), chunk);
    output += chunk;
  }
  output += stream.flush();
  assert.equal(output, "Looking at screen.png now — done.");
});

test("without paths the stream passes deltas through unchanged", () => {
  const stream = new PathRedactor(new Map()).stream();
  assert.equal(stream.push("abc"), "abc");
  assert.equal(stream.flush(), "");
});
