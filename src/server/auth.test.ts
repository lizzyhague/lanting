import assert from "node:assert/strict";
import test from "node:test";

import { CookieAuth, COOKIE_NAME } from "./auth.ts";

test("signed cookies survive a new server instance and are revoked by token rotation", () => {
  const token = "test-login-credential-at-least-32-chars";
  const auth = new CookieAuth(token);
  const value = auth.issue();
  const cookie = `${COOKIE_NAME}=${value}`;
  assert.equal(new CookieAuth(token).read(cookie), value);
  assert.equal(new CookieAuth(`${token}-rotated`).read(cookie), null);
  assert.equal(cookie.includes(token), false);
  assert.notEqual(auth.issue(), value);
  assert.equal(auth.read(`other=value; ${cookie}`), value);
  assert.equal(auth.read(`${cookie}; ${cookie}`), null);
  assert.equal(auth.read(`${COOKIE_NAME}=${value.slice(0, -1)}!`), null);
  assert.equal(auth.read(`${COOKIE_NAME}=v1.${"a".repeat(43)}.${"b".repeat(43)}`), null);
  assert.equal(auth.read(`${COOKIE_NAME}=${token}`), null);
  assert.equal(auth.read(undefined), null);
  for (const attribute of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/", "Max-Age="]) {
    assert.ok(auth.header(value).includes(attribute));
  }
});
