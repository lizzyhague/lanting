import { readFileSync } from "node:fs";
import vm from "node:vm";

/**
 * Interface text the browser shows in its own language: a key from public/strings.js plus parameters.
 * The backend never picks a language for these; it sends the key and keeps the English form for logs.
 */
export type LocalText = { key: string; params?: Record<string, string | number> };

type Translation = string | { one: string; other: string };

const STRINGS_URL = new URL("../../public/strings.js", import.meta.url);
const context: { window: { lantingStrings?: Record<string, Record<string, Translation>> } } = { window: {} };
vm.runInNewContext(readFileSync(STRINGS_URL, "utf8"), context);
const strings = context.window.lantingStrings ?? {};

export function localText(key: string, params?: Record<string, string | number>): LocalText {
  return params ? { key, params } : { key };
}

/** Whether public/strings.js defines the key. */
export function hasText(key: string): boolean {
  return Object.hasOwn(strings, key);
}

/** The English form of the text, filled in the same way as lantingI18n.t in the browser. */
export function englishText(text: LocalText): string {
  const entry = strings[text.key];
  let template = entry?.en ?? text.key;
  if (typeof template === "object") template = text.params?.count === 1 ? template.one : template.other;
  const params = text.params;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/gu, (match, name: string) => Object.hasOwn(params, name) ? String(params[name]) : match);
}

export function isLocalText(value: unknown): value is LocalText {
  if (typeof value !== "object" || value === null) return false;
  const { key, params } = value as { key?: unknown; params?: unknown };
  return typeof key === "string" && (params === undefined || (typeof params === "object" && params !== null &&
    Object.values(params).every((item) => typeof item === "string" || typeof item === "number")));
}

/** An error whose message the browser shows in its own language; the message is the English form. */
export class LocalizedError extends Error {
  readonly text: LocalText;

  constructor(text: LocalText) {
    super(englishText(text));
    this.name = "LocalizedError";
    this.text = text;
  }
}

/** The translatable text an error carries, if any (LocalizedError, GroupError and the like). */
export function textOf(error: unknown): LocalText | undefined {
  const text = error instanceof Error ? (error as { text?: unknown }).text : undefined;
  return isLocalText(text) ? text : undefined;
}
