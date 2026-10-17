import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const COOKIE_NAME = "lanting-session";

export function secretsEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Changing the access token invalidates all issued cookies immediately, with no in-memory session table needed. */
export class CookieAuth {
  readonly #key: Buffer;

  constructor(token: string) {
    this.#key = createHmac("sha256", token).update("lanting/cookie-key/v1").digest();
  }

  #sign(payload: string): string {
    return createHmac("sha256", this.#key).update(payload).digest("base64url");
  }

  issue(): string {
    const payload = `v1.${randomBytes(32).toString("base64url")}`;
    return `${payload}.${this.#sign(payload)}`;
  }

  read(header: string | undefined): string | null {
    const entries = (header ?? "")
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part.startsWith(`${COOKIE_NAME}=`));
    if (entries.length !== 1) return null;
    const value = entries[0]!.slice(COOKIE_NAME.length + 1);
    if (!/^v1\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/u.test(value)) return null;
    const dot = value.lastIndexOf(".");
    return secretsEqual(value.slice(dot + 1), this.#sign(value.slice(0, dot))) ? value : null;
  }

  header(value: string): string {
    // Major browsers cap the lifetime of persistent cookies; authenticated HTTP requests renew it.
    return `${COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=34560000`;
  }
}
