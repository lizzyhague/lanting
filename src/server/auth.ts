import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const COOKIE_NAME = "lanting-session";

export function secretsEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 更换访问令牌会让所有已签发的 cookie 立即失效，不需要内存会话表。 */
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
    // 主流浏览器会限制持久 cookie 的最长寿命；已鉴权 HTTP 请求会续期。
    return `${COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=34560000`;
  }
}
