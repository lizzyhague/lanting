import assert from "node:assert/strict";
import test from "node:test";

import { modelOptions } from "./adapter.ts";

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
