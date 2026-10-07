import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";


/** 无条件放行的只读工具。 */
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

/** 本机明确使用或常见的登录凭证、私钥文件；只挡这些具体文件，不扩大到整个目录。 */
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
 * 判定顺序固定：敏感文件与令牌硬拒绝 → 只读工具放行 → 其余交给群主逐次确认。
 * 后面的规则不能绕过前面的拒绝。
 */
export async function decideToolUse(policy: ToolPolicyInput): Promise<ToolDecision> {
  if (
    containsConfiguredToken(policy.input) ||
    (typeof policy.input.command === "string" && commandDumpsEnvironment(policy.input.command)) ||
    await targetsSensitiveFile(policy.toolName, policy.input, policy.cwd)
  ) {
    return { behavior: "deny", message: "本服务不会允许工具读取秘密文件或令牌。" };
  }
  if (isReadOnlyTool(policy.toolName)) {
    return { behavior: "allow", reason: "只读工具按规格直接放行。" };
  }
  return { behavior: "ask" };
}

/**
 * `permissionMode: "default"` 会自行放行 pwd 这类低风险命令，根本不调用 canUseTool。
 * 因此这里对每次调用明确返回 deny 或 ask：允许的判断留给
 * canUseTool，那里还要检查调用是否属于进行中的一轮，hook 不能提前 allow 绕过它。
 */
export function createPreToolUseHook(
  context: {
    cwd: string;
    onDenied?: (toolName: string, message: string) => void;
  },
): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") {
      return { continue: false, stopReason: "无法确认工具调用来源。" };
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
          : "交给宿主的权限策略确认。",
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

  // Glob 的 pattern 自身也可以明确点名秘密文件；Grep 的 pattern 是内容模式，
  // 不能因为它提到“.env”就扩大为文件路径禁令。
  if (toolName === "Glob" && typeof input.pattern === "string") {
    pathCandidates.push(input.pattern);
  }
  // Bash 的 command 不是结构化路径；检查整段文字，不能只按空白切词，
  // 否则 `open(".env")`、`cat <.env` 之类会漏掉。
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
      // 不存在或含通配符的路径已由上面的明确文件名规则覆盖，无需放宽拒绝范围。
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
 * 会把文件内容取出来的命令。命中这一类时，只看**引号外**的部分：
 * `grep -n "^\.env" .gitignore` 找的是模式，不是那个文件。
 */
const READING_COMMANDS = new Set([
  "cat", "bat", "tac", "nl", "head", "tail", "less", "more", "most", "od", "xxd", "hexdump",
  "strings", "source", ".", "grep", "rg", "egrep", "fgrep", "awk", "sed", "cut", "sort", "uniq",
  "wc", "diff", "cmp", "cp", "install", "rsync", "scp", "base64", "gpg", "jq", "yq", "tee", "dd",
  "tr", "split", "column", "paste", "join", "comm", "file", "md5sum", "sha256sum", "shasum",
  "openssl", "xargs", "readlink", "realpath", "stat",
]);

/** 解释器可以在字符串里读文件，所以对这一类要连引号内一起看。 */
const INTERPRETERS = new Set([
  "node", "python", "python3", "perl", "ruby", "php", "sh", "bash", "zsh", "deno", "bun", "eval",
]);

/** 不改变"这条命令在干什么"的前缀词，跳过它们再判断真正的命令名。 */
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
    // `< 秘密文件` 是读取，不管前面那个命令叫什么。
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
 * 把整个环境打印出来的命令。运行时继承了服务的环境，令牌就在里面。
 * 只挡整体打印：`env FOO=1 cmd` 借 env 运行别的程序、`printenv PATH` 取单个变量都不算。
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

/** `env` 后面只有选项和变量赋值、没有要运行的程序时，它就是在打印环境。 */
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

/** 命令文本里是否点名了受保护的文件。只判文本，不判意图。 */
function namesSensitiveTarget(text: string, protectedPaths: Set<string>): boolean {
  if (/(?:^|[\s'"`=<>()[\]{},;:|&\\/])\.env(?:\.[^\s'"`<>()[\]{},;:|&\\/]*)?(?=$|[\s'"`<>()[\]{},;:|&\\/])/u.test(text)) {
    return true;
  }
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
  return /(?:^|[\s'"`=<>()[\]{},;:|&\\/])\.credentials\.json(?=$|[\s'"`<>()[\]{},;:|&\\/])/u.test(
    text,
  );
}

/**
 * 去掉 heredoc 的正文。写文档、写代码时正文里常常提到这些文件名，那是在写，不是在读；
 * `cat > note.md <<'EOF'` 的 `cat` 也不该因为正文提到而被当成读取。
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

/** 按管道、分号、逻辑运算符和子 shell 边界切开，每段各自判断自己的命令名。 */
function splitCommandSegments(command: string): string[] {
  return command
    .split(/\|\||&&|[|;\n]|\$\(|`/u)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

/** 跳过前置变量赋值和 sudo 这类透明前缀，取真正的命令名。 */
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

/** `<` 之后紧跟的那个词，也就是被当成输入读进来的文件。 */
function readRedirectTargets(segment: string): string {
  return [...segment.matchAll(/<\s*([^\s<|;&]+)/gu)].map((match) => match[1]).join(" ");
}

/** 去掉成对引号里的内容，只留引号外的部分。 */
function stripQuotedSpans(segment: string): string {
  return segment.replaceAll(/'[^']*'|"[^"]*"/gu, " ");
}

function expandHome(candidate: string): string {
  if (candidate === "~") return homedir();
  if (candidate.startsWith("~/")) return path.join(homedir(), candidate.slice(2));
  return candidate;
}

function hasSensitiveFileName(candidate: string): boolean {
  return candidate.split(/[\\/]/u).some((segment) =>
    segment === ".env" || segment.startsWith(".env.") ||
    segment === ".env*" || segment.startsWith(".env.*")
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
