import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

/**
 * Process exit barrier for closing the runtime, with one implementation shared by Linux and macOS.
 *
 * Two points, both required:
 * - **The whole process tree must go**: Claude Code spawns bash and other tool subprocesses; killing only the CLI
 *   leaves orphans, which may still hold the working directory or keep writing session files, exactly what this barrier prevents
 * - **One signal doesn't mean it's over**: poll every 20ms for up to 2000ms;
 *   if it still hasn't exited, escalate to `SIGKILL` and wait another 1000ms
 *
 * The approach is `detached: true`: the child becomes leader of a new POSIX process group, its pid is also the process group id,
 * and signaling the negative pid covers the whole group. The system process table isn't enumerated, so there is no dependency on `/proc` or `ps`.
 *
 * Limit: a tool that calls `setsid` to leave the process group again is outside this barrier's reach. Service stop,
 * idle reclamation and in-app deletion must all clean up actively; systemd or launchd can't be relied on to finish up after the host exits.
 */

const POLL_INTERVAL_MS = 20;
const TERM_WAIT_MS = 2_000;
const KILL_WAIT_MS = 1_000;
const STDERR_TAIL_LIMIT = 8_192;

type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;
type ErrorListener = (error: Error) => void;

/** One instance per long-lived Query: holds the process group it started and is responsible for confirming that group has exited. */
export class ProcessGroup {
  #processGroupId: number | null = null;
  #stderrTail = "";

  /**
   * Passed to the SDK's `Options.spawnClaudeCodeProcess`. The command, arguments, working directory and environment are all
   * the SDK's values; only two things change: it runs in its own process group, and signals go to the whole group.
   *
   * Note: once this callback is provided, the SDK no longer adds its own `--debug-file` automatically.
   */
  readonly spawn = (options: SpawnOptions): SpawnedProcess => {
    const child = spawn(options.command, options.args, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      windowsHide: true,
    });
    // A failed spawn yields no pid, so there is no started process group to wait for.
    this.#processGroupId = child.pid ?? null;

    // `SpawnedProcess` has no stderr, and the SDK doesn't read it for a custom spawn; if nobody reads it the pipe fills up
    // and stalls the CLI. Only a bounded tail is kept for server failure logs.
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.#stderrTail = `${this.#stderrTail}${chunk}`.slice(-STDERR_TAIL_LIMIT);
    });
    child.stderr.on("error", () => {
      // Pipe read failures while the child exits are normal and shouldn't take down the backend.
    });

    // This signal is forwarded by the SDK and only aborts after its own stdin EOF plus grace period,
    // so kill the whole group outright. It can't be left to Node's `spawn({ signal })`, which only kills the leader.
    options.signal.addEventListener("abort", () => {
      signalGroup(this.#processGroupId, "SIGKILL");
    }, { once: true });

    return {
      stdin: child.stdin,
      stdout: child.stdout,
      get killed(): boolean {
        return child.killed;
      },
      get exitCode(): number | null {
        return child.exitCode;
      },
      get signalCode(): NodeJS.Signals | null {
        return child.signalCode;
      },
      // On a normal close the SDK sends SIGTERM then SIGKILL; only hitting the whole group takes down the tool subprocesses.
      // When the process group no longer exists, fall back to the single process so the SDK's killed semantics stay intact.
      kill: (signal: NodeJS.Signals): boolean =>
        signalGroup(this.#processGroupId, signal) || child.kill(signal),
      on: bindEvent(child, "on"),
      once: bindEvent(child, "once"),
      off: bindEvent(child, "off"),
    };
  };

  /** Leader pid, which is also the process group id; null when spawn got no pid. */
  get processGroupId(): number | null {
    return this.#processGroupId;
  }

  /** Bounded tail of stderr, for server logs only, never sent to the browser. */
  get stderrTail(): string {
    return this.#stderrTail;
  }

  /**
   * Kills the whole process group and **confirms** it is really gone.
   * Returning false means a process is still alive, or exists but can't be signaled; callers treat that as a failed close.
   */
  async terminate(): Promise<boolean> {
    const processGroupId = this.#processGroupId;
    // Never got a pid: either spawn was never called, or it failed before starting.
    // This is the only branch where "no need to wait" can be decided without a process group.
    if (processGroupId === null) return true;
    if (!groupExists(processGroupId)) return true;

    signalGroup(processGroupId, "SIGTERM");
    if (await pollUntilGone(processGroupId, TERM_WAIT_MS)) return true;
    signalGroup(processGroupId, "SIGKILL");
    return pollUntilGone(processGroupId, KILL_WAIT_MS);
  }
}

/**
 * Whether the process group still has members.
 *
 * `-1` means "all processes" and `0` means "this process group"; both must be rejected, or a single mistake would
 * take down the whole machine or the service itself.
 */
export function groupExists(processGroupId: number | null): boolean {
  if (processGroupId === null || !Number.isInteger(processGroupId) || processGroupId <= 1) {
    return false;
  }
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    // EPERM means the group still exists but isn't ours; only ESRCH means it is really empty.
    return errorCode(error) === "EPERM";
  }
}

function signalGroup(
  processGroupId: number | null,
  signal: NodeJS.Signals,
): boolean {
  if (processGroupId === null || !Number.isInteger(processGroupId) || processGroupId <= 1) {
    return false;
  }
  try {
    // As long as the group has members, the kernel won't reassign this pid, so a negative pid can't hit anyone else.
    process.kill(-processGroupId, signal);
    return true;
  } catch {
    return false; // Signaling an already-exited process group again isn't an error.
  }
}

async function pollUntilGone(processGroupId: number, budgetMs: number): Promise<boolean> {
  let waited = 0;
  while (groupExists(processGroupId) && waited < budgetMs) {
    await sleep(POLL_INTERVAL_MS);
    waited += POLL_INTERVAL_MS;
  }
  return !groupExists(processGroupId);
}

/**
 * The timer here **must not be unref'd**: at shutdown it is often the only thing left in the event loop;
 * unref'ing it lets Node exit outright and the barrier's wait never settles, which is the same as not waiting.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

interface EventBinder {
  (event: "exit", listener: ExitListener): void;
  (event: "error", listener: ErrorListener): void;
}

function bindEvent(child: ChildProcess, method: "on" | "once" | "off"): EventBinder {
  return (event: "exit" | "error", listener: ExitListener | ErrorListener): void => {
    const handler = listener as (...args: unknown[]) => void;
    if (method === "on") child.on(event, handler);
    else if (method === "once") child.once(event, handler);
    else child.off(event, handler);
  };
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}
