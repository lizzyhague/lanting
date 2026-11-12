import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { proxyAvailable, proxyEnvironment } from "./proxy.ts";

test("direct children omit every proxy variable without changing the parent environment", async () => {
  const environment = { ...process.env, HTTP_PROXY: "http://localhost:8080", https_proxy: "http://localhost:8080", ALL_PROXY: "socks5://localhost:8080", NO_PROXY: "localhost", LANTING_PROBE: "kept" };
  const child = proxyEnvironment(false, environment);
  const { stdout } = await promisify(execFile)(process.execPath, ["-e", 'console.log(JSON.stringify({ keys: Object.keys(process.env).filter(k => /^(https?|all|no)_proxy$/i.test(k)), probe: process.env.LANTING_PROBE }))'], { env: child });
  assert.deepEqual(JSON.parse(stdout), { keys: [], probe: "kept" });
  assert.equal(environment.HTTP_PROXY, "http://localhost:8080");
  assert.deepEqual(proxyEnvironment(undefined, environment), environment);
  assert.deepEqual(proxyEnvironment(true, environment), environment);
});

test("deployment availability requires a nonempty forwarding proxy", () => {
  assert.equal(proxyAvailable({ NO_PROXY: "localhost", HTTPS_PROXY: " " }), false);
  assert.equal(proxyAvailable({ https_proxy: "http://localhost:8080" }), true);
});
