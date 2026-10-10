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
    { text: "上下文 12.3%" },
    { text: "5 小时剩余 60.0%，{time} 重置", time: "2026-10-10T12:00:00Z" },
    { text: "7 天剩余 未知" },
  ]);
  assert.deepEqual(usageParts({ percentage: 5 }, null), [{ text: "上下文 5.0%" }, { text: "额度查询不可用" }]);
  assert.deepEqual(
    usageParts({ percentage: 5 }, { rate_limits_available: false, rate_limits: null }),
    [{ text: "上下文 5.0%" }, { text: "额度查询不可用" }],
  );
});
