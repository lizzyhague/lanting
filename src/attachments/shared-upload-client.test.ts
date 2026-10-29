import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SharedUploadClient } from "./shared-upload-client.ts";
import { SharedUploadError } from "./types.ts";

async function fixture(t: test.TestContext, handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const directory = await mkdtemp(path.join(tmpdir(), "lanting-upload-client-"));
  const socket = path.join(directory, "api.sock");
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  return new SharedUploadClient(socket);
}

const binding = { caller: "lanting", projectId: "projects/example", sessionId: "group" } as const;

test("uploads streamed bytes and retrieves a streaming response over an isolated socket", async (t) => {
  const bytes = Buffer.alloc(200_000, 42);
  const client = await fixture(t, (request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      if (request.url === "/v1/uploads") {
        assert.equal(request.headers["x-upload-ticket"], "ticket");
        assert.equal(request.headers["content-length"], String(bytes.length));
        assert.deepEqual(Buffer.concat(chunks), bytes);
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ attachment: { id: "attachment" } }));
      } else {
        assert.equal(request.url, "/v1/attachments/attachment/content");
        assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), binding);
        response.writeHead(200, { "content-type": "application/octet-stream", "content-length": bytes.length });
        response.end(bytes);
      }
    })().catch((error: unknown) => response.destroy(error as Error));
  });
  const result = await client.uploadStream("ticket", bytes.length, (async function* () {
    yield bytes.subarray(0, 100_000); yield bytes.subarray(100_000);
  })(), new AbortController().signal);
  assert.equal(result.id, "attachment");
  const response = await client.getContent(binding, "attachment");
  const chunks: Buffer[] = [];
  for await (const chunk of response) chunks.push(Buffer.from(chunk));
  assert.deepEqual(Buffer.concat(chunks), bytes);
});

test("decodes content errors using the shared error shape", async (t) => {
  const client = await fixture(t, (request, response) => {
    request.resume();
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "attachment_unavailable", message: "Unavailable" } }));
  });
  await assert.rejects(client.getContent(binding, "missing"), (error: unknown) => {
    assert.ok(error instanceof SharedUploadError);
    assert.equal(error.code, "attachment_unavailable");
    assert.equal(error.status, 404);
    return true;
  });
});

test("aborts an in-progress stream without completing the upload", async (t) => {
  const controller = new AbortController();
  let disconnected!: () => void;
  const closed = new Promise<void>((resolve) => { disconnected = resolve; });
  const client = await fixture(t, (request) => {
    request.once("data", () => controller.abort());
    request.once("close", disconnected);
    request.on("error", () => {});
  });
  let finalized = false;
  const source = (async function* () {
    try {
      yield Buffer.alloc(1024);
      await new Promise<void>((resolve) => controller.signal.addEventListener("abort", () => resolve(), { once: true }));
      controller.signal.throwIfAborted();
      yield Buffer.alloc(1024);
    } finally { finalized = true; }
  })();
  await assert.rejects(client.uploadStream("ticket", 2048, source, controller.signal));
  await closed;
  assert.equal(finalized, true);
});

test("propagates a source failure and closes the upload request", async (t) => {
  const client = await fixture(t, (request) => {
    request.resume();
    request.on("error", () => {});
  });
  await assert.rejects(client.uploadStream("ticket", 2048, (async function* () {
    yield Buffer.alloc(1024);
    throw new Error("file changed");
  })(), new AbortController().signal), /file changed/);
});
