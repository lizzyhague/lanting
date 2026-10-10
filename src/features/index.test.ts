import assert from "node:assert/strict";
import test from "node:test";

import { featureIds } from "./index.ts";

test("lists implemented agent features in fixed order", () => {
  assert.deepEqual(featureIds({
    permissions: async () => [],
    compact: async () => {},
    models: async () => [],
  }), ["compact", "models", "permissions"]);
  assert.deepEqual(featureIds({}), []);
});
