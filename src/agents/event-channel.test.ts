import assert from "node:assert/strict";
import test from "node:test";

import { EventChannel } from "./event-channel.ts";

test("delivers items pushed before and after iteration starts, then ends", async () => {
  const channel = new EventChannel<number>();
  channel.push(1);
  const seen: number[] = [];
  const done = (async () => {
    for await (const item of channel) seen.push(item);
  })();
  await new Promise((resolve) => setImmediate(resolve));
  channel.push(2);
  channel.end();
  channel.push(3);
  await done;
  assert.deepEqual(seen, [1, 2]);
});

test("can only be iterated once", async () => {
  const channel = new EventChannel<number>();
  channel.end();
  for await (const _ of channel) assert.fail();
  await assert.rejects(async () => {
    for await (const _ of channel) assert.fail();
  }, /只能被迭代一次/u);
});
