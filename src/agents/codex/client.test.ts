import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { AppServerClient, type JsonObject, type RequestId } from "./client.ts";

test("responds to a server-initiated request over JSONL", async (context) => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "lanting-codex-client-"));
  context.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const fakeServer = path.join(temporaryDirectory, "fake-app-server.mjs");
  await writeFile(fakeServer, `#!/usr/bin/env node
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    console.log(JSON.stringify({
      id: message.id,
      result: {
        userAgent: "fake-app-server",
        codexHome: "/tmp/fake-codex",
        platformFamily: "unix",
        platformOs: "linux"
      }
    }));
  } else if (message.method === "initialized") {
    console.log(JSON.stringify({
      id: "server-approval",
      method: "item/fileChange/requestApproval",
      params: {}
    }));
  } else if (message.id === "server-approval") {
    console.log(JSON.stringify({
      method: "test/received",
      params: { result: message.result }
    }));
  }
});
`, "utf8");
  await chmod(fakeServer, 0o700);

  let client!: AppServerClient;
  let resolveReceived!: (message: JsonObject) => void;
  const received = new Promise<JsonObject>((resolve) => {
    resolveReceived = resolve;
  });
  client = new AppServerClient({
    codexBinary: fakeServer,
    onServerRequest: (message) => {
      client.respondToServerRequest(message.id as RequestId, {
        decision: "accept",
      });
    },
    onNotification: (message) => {
      if (message.method === "test/received") {
        resolveReceived(message);
      }
    },
  });

  try {
    await client.initialize({
      clientInfo: {
        name: "codex_remote_test",
        title: "lanting test",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
      },
    });
    const message = await Promise.race([
      received,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("等待双向 JSONL 响应超时。")), 2_000);
      }),
    ]);
    assert.deepEqual(message.params, {
      result: { decision: "accept" },
    });
  } finally {
    await client.close();
  }
});

test("does not pass the web access token to app-server", async (context) => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "lanting-codex-env-"));
  context.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const fakeServer = path.join(temporaryDirectory, "fake-app-server.mjs");
  await writeFile(fakeServer, `#!/usr/bin/env node
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method !== "initialize") return;
  console.log(JSON.stringify({
    id: message.id,
    result: {
      userAgent: JSON.stringify({
        remoteToken: process.env.ACCESS_TOKEN ?? null,
        inherited: process.env.LANTING_ENV_PROBE ?? null
      }),
      codexHome: "/tmp/fake-codex",
      platformFamily: "unix",
      platformOs: "linux"
    }
  }));
});
`, "utf8");
  await chmod(fakeServer, 0o700);

  const client = new AppServerClient({
    codexBinary: fakeServer,
    environment: {
      ...process.env,
      ACCESS_TOKEN: "web-access-token-must-not-be-inherited",
      LANTING_ENV_PROBE: "still-inherited",
    },
  });
  try {
    const initialized = await client.initialize({
      clientInfo: {
        name: "codex_remote_test",
        title: "lanting test",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
      },
    });
    assert.deepEqual(JSON.parse(initialized.userAgent), {
      remoteToken: null,
      inherited: "still-inherited",
    });
  } finally {
    await client.close();
  }
});

test("closes descendants left in a Worker process group", async (context) => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "lanting-codex-group-"));
  const pidFile = path.join(temporaryDirectory, "descendant.pid");
  let descendantPid: number | null = null;
  context.after(async () => {
    if (descendantPid && processExists(descendantPid)) {
      try {
        process.kill(descendantPid, "SIGKILL");
      } catch {
        // 已经退出。
      }
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  });
  const fakeServer = path.join(temporaryDirectory, "fake-worker.mjs");
  await writeFile(fakeServer, `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
const pidFile = ${JSON.stringify(pidFile)};
const lines = createInterface({ input: process.stdin });
lines.on("line", async (line) => {
  const message = JSON.parse(line);
  if (message.method !== "initialize") return;
  const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore"
  });
  descendant.unref();
  await writeFile(pidFile, String(descendant.pid));
  console.log(JSON.stringify({
    id: message.id,
    result: {
      userAgent: "fake-worker",
      codexHome: "/tmp/fake-codex",
      platformFamily: "unix",
      platformOs: "linux"
    }
  }));
});
`, "utf8");
  await chmod(fakeServer, 0o700);
  const client = new AppServerClient({
    codexBinary: fakeServer,
    processGroup: true,
  });
  try {
    await client.initialize({
      clientInfo: {
        name: "codex_remote_test",
        title: "lanting test",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
      },
    });
    descendantPid = Number(await readFile(pidFile, "utf8"));
    assert.equal(processExists(descendantPid), true);
  } finally {
    await client.close();
  }
  await waitFor(() => !processExists(descendantPid!), 3_000);
});

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("等待进程退出超时。");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
