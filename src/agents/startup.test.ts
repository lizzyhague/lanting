import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createConfiguredAdapters } from "./startup.ts";

test("missing and non-executable CLIs are retried and skipped while healthy CLIs remain", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "lanting-startup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "fake-cli");
  const blocked = path.join(directory, "blocked-cli");
  await writeFile(executable, "#!/bin/sh\n", { mode: 0o700 });
  await writeFile(blocked, "#!/bin/sh\n", { mode: 0o600 });
  let waits = 0;
  const warnings: string[] = [];
  const adapters = await createConfiguredAdapters({ agents: {
    claude: { executable: path.join(directory, "missing-cli") },
    codex: { executable: blocked },
    cursor: { executable },
  } }, directory, { wait: async () => { waits += 1; }, warn: (message) => warnings.push(message) });
  assert.deepEqual(adapters.map((adapter) => adapter.kind), ["cursor"]);
  assert.equal(waits, 4);
  assert.equal(warnings.length, 6);
  assert.equal(warnings.filter((message) => message.includes("Skipping this CLI")).length, 2);
});

test("an executable restored during retries is registered", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "lanting-startup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "fake-cli");
  await writeFile(executable, "#!/bin/sh\n", { mode: 0o600 });
  let waits = 0;
  const adapters = await createConfiguredAdapters({ agents: { cursor: { executable } } }, directory, {
    wait: async () => { waits += 1; await chmod(executable, 0o700); },
    warn: () => {},
  });
  assert.deepEqual(adapters.map((adapter) => adapter.kind), ["cursor"]);
  assert.equal(waits, 1);
});

test("startup can continue with no available CLIs", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "lanting-startup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.deepEqual(await createConfiguredAdapters({ agents: {
    cursor: { executable: path.join(directory, "missing-cli") },
  } }, directory, { wait: async () => {}, warn: () => {} }), []);
});

test("malformed CLI configuration still fails without retries", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "lanting-startup-invalid-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "fake-antigravity");
  await writeFile(executable, "#!/bin/sh\n", { mode: 0o700 });
  for (const section of [{}, { executable: "relative-cli" }]) {
    await assert.rejects(createConfiguredAdapters({ agents: { cursor: section } }, "/nonexistent-data", {
      wait: async () => { assert.fail("invalid configuration must not be retried"); },
      warn: () => { assert.fail("invalid configuration must not be skipped"); },
    }), /must be/u);
  }
  await assert.rejects(createConfiguredAdapters({
    agents: { antigravity: { executable, additionalDirectories: ["relative-dir"] } },
  }, directory, {
    wait: async () => { assert.fail("invalid configuration must not be retried"); },
    warn: () => { assert.fail("invalid configuration must not be skipped"); },
  }), /must be an absolute path/u);
});
