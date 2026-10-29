import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { hasSensitiveFileName, textNamesSensitiveFile } from "../../security/sensitive-files.ts";

import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";


/** Read-only tools allowed unconditionally. */
export const READ_ONLY_TOOLS = ["Read", "Glob", "Grep", "WebSearch", "WebFetch"] as const;
const READ_ONLY_TOOL_SET = new Set<string>(READ_ONLY_TOOLS);

export type ToolDecision =
  | { behavior: "allow"; reason: string }
  | { behavior: "deny"; message: string }
  | { behavior: "ask" };

export type ToolPolicyInput = {
  toolName: string;
  input: Record<string, unknown>;
  cwd: string;
};

export function isReadOnlyTool(toolName: string): boolean {
  return READ_ONLY_TOOL_SET.has(toolName);
}

function claudeConfigDirectory(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR;
  return configured && configured.trim() ? configured.trim() : path.join(homedir(), ".claude");
}

export function credentialsFilePath(): string {
  return path.join(claudeConfigDirectory(), ".credentials.json");
}

/** Login credential and private key files used on this machine or commonly seen; only these specific files are blocked, not whole directories. */
function protectedFilePaths(): Set<string> {
  const home = homedir();
  return new Set([
    credentialsFilePath(),
    path.join(home, ".config", "gh", "token"),
    path.join(home, ".config", "gh", "hosts.yml"),
    path.join(home, ".config", "git", "github-credentials"),
    path.join(home, ".netrc"),
    path.join(home, ".ssh", "id_rsa"),
    path.join(home, ".ssh", "id_ed25519"),
    path.join(home, ".ssh", "id_ecdsa"),
    path.join(home, ".ssh", "id_dsa"),
  ].map((entry) => path.normalize(entry)));
}

/**
 * Fixed decision order: hard-deny sensitive files and tokens → allow read-only tools → everything else goes to the group owner for confirmation each time.
 * Later rules can't bypass an earlier denial.
 */
export async function decideToolUse(policy: ToolPolicyInput): Promise<ToolDecision> {
  if (
    containsConfiguredToken(policy.input) ||
    (typeof policy.input.command === "string" && commandDumpsEnvironment(policy.input.command)) ||
    await targetsSensitiveFile(policy.toolName, policy.input, policy.cwd)
  ) {
    return { behavior: "deny", message: "This service never lets tools read secret files or tokens." };
  }
  if (isReadOnlyTool(policy.toolName)) {
    return { behavior: "allow", reason: "Read-only tools are allowed by policy." };
  }
  return { behavior: "ask" };
}

/**
 * `permissionMode: "default"` auto-allows low-risk commands like pwd without calling canUseTool at all.
 * So this returns an explicit deny or ask for every call: the allow decision is left to
 * canUseTool, which also checks the call belongs to the active round; the hook can't allow early and bypass it.
 */
export function createPreToolUseHook(
  context: {
    cwd: string;
    onDenied?: (toolName: string, message: string) => void;
  },
): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") {
      return { continue: false, stopReason: "The origin of the tool call cannot be confirmed." };
    }
    const decision = await decideToolUse({
      toolName: input.tool_name,
      input: isObject(input.tool_input) ? input.tool_input : {},
      cwd: context.cwd,
    });
    if (decision.behavior === "deny") context.onDenied?.(input.tool_name, decision.message);
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision.behavior === "deny" ? "deny" : "ask",
        permissionDecisionReason: decision.behavior === "deny"
          ? decision.message
          : "Deferring to the host permission policy.",
      },
    };
  };
}

function containsConfiguredToken(input: Record<string, unknown>): boolean {
  const serialized = JSON.stringify(input);
  if (!serialized) return false;
  return [
    process.env.ACCESS_TOKEN,
    process.env.CLAUDE_CODE_OAUTH_TOKEN,
    process.env.ANTHROPIC_API_KEY,
    process.env.GH_TOKEN,
    process.env.GITHUB_TOKEN,
  ].some((token) => typeof token === "string" && token.length >= 8 && serialized.includes(token));
}

async function targetsSensitiveFile(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): Promise<boolean> {
  const protectedPaths = protectedFilePaths();
  const pathCandidates = collectPathValues(input);

  // A Glob pattern can itself name a secret file explicitly; a Grep pattern is a content pattern,
  // so mentioning ".env" must not turn into a file path ban.
  if (toolName === "Glob" && typeof input.pattern === "string") {
    pathCandidates.push(input.pattern);
  }
  // A Bash command isn't a structured path; check the whole text rather than splitting on whitespace,
  // or things like `open(".env")` and `cat <.env` would slip through.
  if (typeof input.command === "string" && commandNamesSensitiveFile(input.command, protectedPaths)) {
    return true;
  }

  for (const candidate of pathCandidates) {
    if (!candidate) continue;
    if (hasSensitiveFileName(candidate)) return true;

    const expanded = expandHome(candidate);
    const absolute = path.isAbsolute(expanded)
      ? path.normalize(expanded)
      : path.resolve(cwd, expanded);
    if (protectedPaths.has(absolute)) return true;

    try {
      const resolved = path.normalize(await realpath(absolute));
      if (protectedPaths.has(resolved) || hasSensitiveFileName(resolved)) return true;
    } catch {
      // Nonexistent or wildcard paths are already covered by the explicit filename rules above; no need to widen the denial.
    }
  }
  return false;
}

function collectPathValues(value: unknown, key = ""): string[] {
  if (typeof value === "string") {
    return /(?:^|_)(?:file_)?path$/iu.test(key) || /paths?$/iu.test(key) ? [value] : [];
  }
  if (Array.isArray(value)) return value.flatMap((entry) => collectPathValues(entry, key));
  if (!isObject(value)) return [];
  return Object.entries(value).flatMap(([childKey, child]) => collectPathValues(child, childKey));
}

/**
 * Commands that extract file contents. When one of these matches, only the part **outside quotes** is checked:
 * `grep -n "^\.env" .gitignore` is searching for a pattern, not reading that file.
 */
const READING_COMMANDS = new Set([
  "cat", "bat", "tac", "nl", "head", "tail", "less", "more", "most", "od", "xxd", "hexdump",
  "strings", "source", ".", "grep", "rg", "egrep", "fgrep", "awk", "sed", "cut", "sort", "uniq",
  "wc", "diff", "cmp", "cp", "install", "rsync", "scp", "base64", "gpg", "jq", "yq", "tee", "dd",
  "tr", "split", "column", "paste", "join", "comm", "file", "md5sum", "sha256sum", "shasum",
  "openssl", "xargs", "readlink", "realpath", "stat",
]);

/** Interpreters can read files inside strings, so for these the quoted parts are checked too. */
const INTERPRETERS = new Set([
  "node", "python", "python3", "perl", "ruby", "php", "sh", "bash", "zsh", "deno", "bun", "eval",
]);

/** Prefix words that don't change "what this command does"; skip them before judging the real command name. */
const TRANSPARENT_PREFIXES = new Set(["sudo", "command", "time", "nice", "nohup", "env", "exec"]);

function commandNamesSensitiveFile(command: string, protectedPaths: Set<string>): boolean {
  const withoutHeredocs = stripHeredocBodies(command);
  for (const segment of splitCommandSegments(withoutHeredocs)) {
    const name = leadingCommandName(segment);
    if (name !== null && INTERPRETERS.has(name)) {
      if (namesSensitiveTarget(segment, protectedPaths)) return true;
      continue;
    }
    const bare = stripQuotedSpans(segment);
    // `< secret file` is a read, whatever the preceding command is called.
    if (/<\s*[^\s<|;&]*\S/u.test(bare) && namesSensitiveTarget(readRedirectTargets(bare), protectedPaths)) {
      return true;
    }
    if (name !== null && READING_COMMANDS.has(name) && namesSensitiveTarget(bare, protectedPaths)) {
      return true;
    }
  }
  return false;
}

/**
 * Commands that print the whole environment. The runtime inherits the service's environment, token included.
 * Only full dumps are blocked: `env FOO=1 cmd` running another program via env and `printenv PATH` fetching one variable don't count.
 */
function commandDumpsEnvironment(command: string): boolean {
  return splitCommandSegments(stripHeredocBodies(command)).some((segment) => {
    const words = stripQuotedSpans(segment).replaceAll(/[()]/gu, " ").split(/\s+/u).filter(Boolean);
    const end = words.findIndex((word) => /^\d*[<>&]/u.test(word));
    const rest = end === -1 ? words : words.slice(0, end);
    const start = rest.findIndex((word) =>
      !/^[A-Za-z_]\w*=/u.test(word) && (word === "env" || !TRANSPARENT_PREFIXES.has(word))
    );
    if (start === -1) return false;
    const [name, ...args] = rest.slice(start);
    switch (name) {
      case "env":
        return envRunsNoCommand(args);
      case "printenv":
        return args.every((arg) => arg.startsWith("-"));
      case "export":
        return args.every((arg) => arg === "-p");
      case "declare":
      case "typeset":
        return args.every((arg) => /^-[px]+$/u.test(arg));
      case "set":
        return args.length === 0;
      default:
        return false;
    }
  });
}

/** When `env` is followed only by options and variable assignments, with no program to run, it is printing the environment. */
function envRunsNoCommand(args: string[]): boolean {
  let skipValue = false;
  for (const arg of args) {
    if (skipValue) {
      skipValue = false;
      continue;
    }
    if (arg === "-u" || arg === "--unset" || arg === "-C" || arg === "--chdir") {
      skipValue = true;
      continue;
    }
    if (arg === "-S" || arg.startsWith("--split-string")) return false;
    if (arg.startsWith("-") || /^[A-Za-z_]\w*=/u.test(arg)) continue;
    return false;
  }
  return true;
}

/** Whether the command text names a protected file. Judges the text only, not the intent. */
function namesSensitiveTarget(text: string, protectedPaths: Set<string>): boolean {
  if (textNamesSensitiveFile(text)) return true;
  const normalized = text.replaceAll("\\", "/");
  for (const protectedPath of protectedPaths) {
    const relativeToHome = path.relative(homedir(), protectedPath);
    const homeVariant = !path.isAbsolute(relativeToHome) && !relativeToHome.startsWith("..")
      ? `~/${relativeToHome.replaceAll("\\", "/")}`
      : "";
    const variants = [protectedPath, protectedPath.replaceAll("\\", "/"), homeVariant]
      .filter(Boolean);
    if (variants.some((candidate) => normalized.includes(candidate))) return true;
  }
  return false;
}

/**
 * Strips heredoc bodies. Docs and code being written often mention these filenames; that is writing, not reading,
 * and the `cat` in `cat > note.md <<'EOF'` shouldn't count as a read because the body mentions them.
 */
function stripHeredocBodies(command: string): string {
  const lines = command.split("\n");
  const kept: string[] = [];
  let delimiter: string | null = null;
  for (const line of lines) {
    if (delimiter !== null) {
      if (line.trim() === delimiter) delimiter = null;
      continue;
    }
    kept.push(line);
    const opener = /<<-?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][\w-]*))/u.exec(line);
    if (opener) delimiter = opener[1] ?? opener[2] ?? opener[3] ?? null;
  }
  return kept.join("\n");
}

/** Splits on pipes, semicolons, logical operators and subshell boundaries; each segment judges its own command name. */
function splitCommandSegments(command: string): string[] {
  return command
    .split(/\|\||&&|[|;\n]|\$\(|`/u)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

/** Skips leading variable assignments and transparent prefixes like sudo to get the real command name. */
function leadingCommandName(segment: string): string | null {
  for (const word of segment.split(/\s+/u)) {
    if (!word) continue;
    if (/^[A-Za-z_][\w]*=/u.test(word)) continue;
    const name = word.replace(/^[({]+/u, "").replace(/^.*\//u, "").replaceAll(/['"]/gu, "");
    if (!name) continue;
    if (TRANSPARENT_PREFIXES.has(name)) continue;
    return name;
  }
  return null;
}

/** The word right after `<`, i.e. the file read in as input. */
function readRedirectTargets(segment: string): string {
  return [...segment.matchAll(/<\s*([^\s<|;&]+)/gu)].map((match) => match[1]).join(" ");
}

/** Removes the contents of paired quotes, keeping only what's outside them. */
function stripQuotedSpans(segment: string): string {
  return segment.replaceAll(/'[^']*'|"[^"]*"/gu, " ");
}

function expandHome(candidate: string): string {
  if (candidate === "~") return homedir();
  if (candidate.startsWith("~/")) return path.join(homedir(), candidate.slice(2));
  return candidate;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
