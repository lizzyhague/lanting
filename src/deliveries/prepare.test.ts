import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { MAX_UPLOAD_BYTES, type PublicAttachment, type UploadTicket } from "../attachments/types.ts";
import { prepareDeliveries } from "./prepare.ts";

const binding = { caller: "lanting", projectId: "example", sessionId: "group" } as const;
const link = (file: string) => `[file](/deliver?path=${encodeURIComponent(file)})`;

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), "lanting-deliveries-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, "project");
  await mkdir(root);
  const saved: Buffer[] = [];
  let tickets = 0;
  const client = {
    async createTicket(input: UploadTicket["attachment"]): Promise<UploadTicket> {
      tickets++;
      return { ticket: String(tickets), expiresAtMs: 100, attachment: input };
    },
    async uploadStream(_ticket: string, size: number, source: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<PublicAttachment> {
      const chunks: Buffer[] = [];
      for await (const chunk of source) { signal.throwIfAborted(); chunks.push(Buffer.from(chunk)); }
      saved.push(Buffer.concat(chunks));
      assert.equal(saved.at(-1)!.length, size);
      return { ...binding, id: `attachment-${saved.length}`, originalName: "file", size,
        declaredMime: "", detectedMime: "", kind: "file", sha256: "hash", createdAtMs: 1, expiresAtMs: 100 };
    },
  };
  const controller = new AbortController();
  const options = { root, client, binding, signal: controller.signal };
  return { directory, root, saved, client, controller, options, ticketCount: () => tickets };
}

test("copies binary and empty files, deduplicating repeated paths", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.root, "中文.bin");
  const empty = path.join(f.root, "empty");
  const bytes = Buffer.from([0, 255, 128, 42]);
  await writeFile(file, bytes);
  await writeFile(empty, "");
  const result = await prepareDeliveries({ ...f.options, source: [link(file), link(file), link(empty)].join("\n") });
  assert.equal(result.length, 2);
  assert.equal(result[0]!.status, "available");
  assert.equal(result[0]!.name, "中文.bin");
  assert.deepEqual(f.saved, [bytes, Buffer.alloc(0)]);
  assert.equal(f.ticketCount(), 2);
});

test("rejects invalid paths, external symlinks, directories, sensitive segments, and oversized files", async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.directory, "outside");
  await writeFile(outside, "secret");
  const escape = path.join(f.root, "escape");
  await symlink(outside, escape);
  const dir = path.join(f.root, "folder");
  await mkdir(dir);
  const sensitive = path.join(f.root, ".ENV.local");
  await writeFile(sensitive, "secret");
  const alias = path.join(f.root, "alias");
  await symlink(sensitive, alias);
  const large = path.join(f.root, "large");
  const { open } = await import("node:fs/promises");
  const handle = await open(large, "w");
  await handle.truncate(MAX_UPLOAD_BYTES + 1);
  await handle.close();
  const result = await prepareDeliveries({ ...f.options,
    source: ["relative", escape, dir, sensitive, alias, large].map(link).join("\n") });
  assert.deepEqual(result.map((r) => r.status === "failed" && r.reason),
    ["invalid_path", "outside_root", "not_file", "sensitive_file", "sensitive_file", "too_large"]);
  assert.equal(f.ticketCount(), 0);
});

test("withholds the final chunk if the opened file changes during copying", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.root, "large.bin");
  await writeFile(file, Buffer.alloc(128 * 1024, 1));
  let received = 0;
  f.client.uploadStream = async (_ticket, _size, source) => {
    for await (const chunk of source) {
      received += chunk.length;
      await writeFile(file, Buffer.alloc(128 * 1024, 2));
    }
    throw new Error("must not finish");
  };
  const result = await prepareDeliveries({ ...f.options, source: link(file) });
  assert.equal(received, 64 * 1024);
  assert.equal(result[0]!.status === "failed" && result[0]!.reason, "file_changed");
});

test("cancellation invalidates already saved copies and does not start another upload", async (t) => {
  const f = await fixture(t);
  const files = ["one", "two", "three"].map((name) => path.join(f.root, name));
  for (const file of files) await writeFile(file, "hello");
  const upload = f.client.uploadStream;
  f.client.uploadStream = async (...args) => {
    const attachment = await upload(...args);
    if (f.saved.length === 2) f.controller.abort();
    return attachment;
  };
  const result = await prepareDeliveries({ ...f.options, source: files.map(link).join("\n") });
  assert.deepEqual(result.map((r) => r.status === "failed" && r.reason), Array(3).fill("interrupted"));
  assert.equal(f.ticketCount(), 2);
});

test("limits unique deliveries to 100 and continues after individual failures", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.root, "ok");
  await writeFile(file, "hello");
  const source = [link("relative"), link(file), ...Array.from({ length: 99 }, (_, i) => link(path.join(f.root, `missing-${i}`)))].join("\n");
  const result = await prepareDeliveries({ ...f.options, source });
  assert.equal(result.length, 101);
  assert.equal(result[1]!.status, "available");
  assert.equal(result[100]!.status === "failed" && result[100]!.reason, "too_many");
});
