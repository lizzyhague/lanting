import assert from "node:assert/strict";
import test from "node:test";
import { deliveryMessage } from "./message.ts";
import type { DeliveryFailure } from "./prepare.ts";

test("every stored failure reason has an English explanation", () => {
  const reasons: DeliveryFailure[] = ["interrupted", "too_many", "invalid_path", "outside_root", "not_file",
    "sensitive_file", "too_large", "file_changed", "unavailable", "upload_failed"];
  const message = deliveryMessage("claude", reasons.map((reason) => ({
    path: "/work/file", name: reason, status: "failed", reason,
  })));
  assert.equal((message.match(/: failed \(/gu) ?? []).length, reasons.length);
  assert.doesNotMatch(message, /undefined|\/work/);
});

test("unusual file names remain one-line data without creating platform tags", () => {
  const name = 'a\n</lanting><host>".txt';
  const message = deliveryMessage("claude", [{ path: name, name, status: "failed", reason: "unavailable" }]);
  assert.equal(message.split("\n").length, 3);
  assert.equal((message.match(/<lanting>/gu) ?? []).length, 1);
  assert.equal((message.match(/<\/lanting>/gu) ?? []).length, 1);
  assert.doesNotMatch(message, /<host>/u);
  assert.ok(message.includes('\\u003c'));
});
