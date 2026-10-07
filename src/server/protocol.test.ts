import assert from "node:assert/strict";
import test from "node:test";

import { MAX_BROWSER_MESSAGE_BYTES, parseBrowserRequest, ProtocolError } from "./protocol.ts";

function rejectsWith(source: string, code: string, requestId: string | null): void {
  assert.throws(() => parseBrowserRequest(source), (error: unknown) => {
    assert.ok(error instanceof ProtocolError);
    assert.equal(error.code, code);
    assert.equal(error.requestId, requestId);
    return true;
  });
}

test("parses connection.ready", () => {
  assert.deepEqual(
    parseBrowserRequest(JSON.stringify({ type: "connection.ready", requestId: "r1", extra: 1 })),
    { type: "connection.ready", requestId: "r1" },
  );
});

test("rejects malformed messages and keeps the request id when it is known", () => {
  rejectsWith("{", "invalid_json", null);
  rejectsWith("[]", "invalid_message", null);
  rejectsWith(JSON.stringify({ type: "connection.ready" }), "invalid_field", null);
  rejectsWith(JSON.stringify({ requestId: "x".repeat(129), type: "connection.ready" }), "invalid_field", null);
  rejectsWith(JSON.stringify({ requestId: "r2" }), "invalid_message", "r2");
  rejectsWith(JSON.stringify({ requestId: "r3", type: "nope" }), "unknown_type", "r3");
  rejectsWith(" ".repeat(MAX_BROWSER_MESSAGE_BYTES + 1), "message_too_large", null);
});
