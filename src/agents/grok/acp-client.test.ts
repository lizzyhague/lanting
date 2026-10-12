import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { AcpClient } from "./acp-client.ts";

test("keeps U+2028 and U+2029 inside a JSON-RPC message", { timeout: 2_000 }, async () => {
  const stdout = new PassThrough();
  const proc = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout,
    stderr: new PassThrough(),
    killed: false,
  }) as unknown as ChildProcessWithoutNullStreams;
  const client = new AcpClient(proc);
  try {
    const result = client.request("test/echo", {});
    const response = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text: "a\u2028b\u2029c" } });
    // 分两块写入，同时覆盖跨块拼接和行尾 CR。
    stdout.write(response.slice(0, 10));
    stdout.write(`${response.slice(10)}\r\n`);
    assert.deepEqual(await result, { text: "a\u2028b\u2029c" });
  } finally {
    await client.close();
  }
});
