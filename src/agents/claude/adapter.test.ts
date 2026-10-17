import assert from "node:assert/strict";
import test from "node:test";

import { modelOptions, usageParts } from "./adapter.ts";

test("Claude model options keep the SDK catalog order and carry effort levels", () => {
  assert.deepEqual(modelOptions([
    { value: "default", displayName: "Default", description: "recommended", supportsEffort: true, supportedEffortLevels: ["low", "high"] },
    { value: " haiku ", displayName: "Haiku", description: "", supportsEffort: false },
    { value: "haiku", displayName: "Duplicate", description: "" },
    { value: "", displayName: "Empty", description: "" },
    { value: "opus", displayName: "", description: "" },
  ]), [
    { id: "default", label: "Default", description: "recommended", efforts: ["low", "high"] },
    { id: "haiku", label: "Haiku", description: "", efforts: [] },
    { id: "opus", label: "opus", description: "", efforts: ["low", "medium", "high", "xhigh", "max"] },
  ]);
});

test("Claude usage parts follow Relayu's metrics line", () => {
  const rateLimits = {
    five_hour: { utilization: 40, resets_at: "2026-10-10T12:00:00Z" },
    seven_day: { utilization: null, resets_at: null },
    seven_day_opus: null,
  };
  assert.deepEqual(usageParts({ percentage: 12.345 }, { rate_limits_available: true, rate_limits: rateLimits }), [
    { kind: "context", percent: 12.345 },
    { kind: "quota", window: { minutes: 300 }, left: 60, resetsAt: "2026-10-10T12:00:00Z" },
    { kind: "quota", window: { minutes: 10_080 }, left: null },
  ]);
  assert.deepEqual(usageParts({ percentage: 5 }, null), [{ kind: "context", percent: 5 }, { kind: "unavailable" }]);
  assert.deepEqual(
    usageParts({ percentage: 5 }, { rate_limits_available: false, rate_limits: null }),
    [{ kind: "context", percent: 5 }, { kind: "unavailable" }],
  );
});
