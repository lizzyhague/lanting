import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

/**
 * 关闭运行时的进程退出屏障，Linux 与 macOS 共用同一套实现。
 *
 * 要点有两个，缺一不可：
 * - **必须带走整棵进程树**：Claude Code 会 spawn bash 等工具子进程，只杀 CLI 本身
 *   会留下孤儿，而孤儿仍可能持有工作目录或继续写会话文件——正是这道 barrier 要防的事
 * - **不能只发一次信号就认为结束了**：20ms 轮询一次，最多等 2000ms，
 *   仍未退出则升级 `SIGKILL`，再等 1000ms
 *
 * 做法是 `detached: true`：子进程成为新 POSIX 进程组的组长，它的 pid 同时是进程组 id，
 * 向负 pid 发信号即可覆盖整组。不枚举系统进程表，因此不依赖 `/proc`，也不需要 `ps`。
 *
 * 边界：工具若自行 `setsid` 再次脱离进程组，就不在这道屏障的覆盖范围内。系统服务停止、
 * 空闲回收和应用内删除都必须走主动清理，不能指望 systemd 或 launchd 在宿主退出后代为收尾。
 */

const POLL_INTERVAL_MS = 20;
const TERM_WAIT_MS = 2_000;
const KILL_WAIT_MS = 1_000;
const STDERR_TAIL_LIMIT = 8_192;

type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;
type ErrorListener = (error: Error) => void;

/** 一个长驻 Query 对应一个实例：持有它启动的进程组，并负责确认该组退出。 */
export class ProcessGroup {
  #processGroupId: number | null = null;
  #stderrTail = "";

  /**
   * 交给 SDK 的 `Options.spawnClaudeCodeProcess`。命令、参数、工作目录和环境全部沿用
   * SDK 给出的值，只改两件事：放进独立进程组，以及把信号打到整组。
   *
   * 注意：一旦提供这个回调，SDK 就不再自动附加它自己的 `--debug-file`。
   */
  readonly spawn = (options: SpawnOptions): SpawnedProcess => {
    const child = spawn(options.command, options.args, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      windowsHide: true,
    });
    // spawn 失败时拿不到 pid，此时没有任何已启动的进程组需要等待。
    this.#processGroupId = child.pid ?? null;

    // `SpawnedProcess` 不含 stderr，SDK 不会替自定义 spawn 读它；没人读就会写满管道
    // 把 CLI 卡住。只留有上限的尾部供服务端故障日志使用。
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.#stderrTail = `${this.#stderrTail}${chunk}`.slice(-STDERR_TAIL_LIMIT);
    });
    child.stderr.on("error", () => {
      // 子进程退出过程中管道读失败是正常的，不该把后端带走。
    });

    // 这个 signal 由 SDK 转发，只在它自己的 stdin EOF + 宽限期走完之后才 abort，
    // 所以直接强杀整组。不能交给 Node 的 `spawn({ signal })`：那只会杀组长。
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
      // SDK 正常关闭时依次发 SIGTERM、SIGKILL；打到整组才能带走工具子进程。
      // 进程组已经不存在时退回单进程，让 SDK 的 killed 语义保持正常。
      kill: (signal: NodeJS.Signals): boolean =>
        signalGroup(this.#processGroupId, signal) || child.kill(signal),
      on: bindEvent(child, "on"),
      once: bindEvent(child, "once"),
      off: bindEvent(child, "off"),
    };
  };

  /** 组长 pid，同时是进程组 id；spawn 未取得 pid 时为 null。 */
  get processGroupId(): number | null {
    return this.#processGroupId;
  }

  /** 有上限的 stderr 尾部，只用于服务端日志，不送往浏览器。 */
  get stderrTail(): string {
    return this.#stderrTail;
  }

  /**
   * 杀掉整个进程组并**确认**它真的不在了。
   * 返回 false 表示仍有进程活着，或者存在但无权发信号，调用方据此判定关闭失败。
   */
  async terminate(): Promise<boolean> {
    const processGroupId = this.#processGroupId;
    // 从未取得 pid：要么根本没调用过 spawn，要么 spawn 在启动前就失败了。
    // 这是唯一可以在没有进程组的情况下明确判定「无需等待」的分支。
    if (processGroupId === null) return true;
    if (!groupExists(processGroupId)) return true;

    signalGroup(processGroupId, "SIGTERM");
    if (await pollUntilGone(processGroupId, TERM_WAIT_MS)) return true;
    signalGroup(processGroupId, "SIGKILL");
    return pollUntilGone(processGroupId, KILL_WAIT_MS);
  }
}

/**
 * 进程组是否还有成员。
 *
 * `-1` 表示「所有进程」、`0` 表示「本进程组」，都必须挡在外面，否则一次误判就会
 * 把整台机器或服务自己打掉。
 */
export function groupExists(processGroupId: number | null): boolean {
  if (processGroupId === null || !Number.isInteger(processGroupId) || processGroupId <= 1) {
    return false;
  }
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    // EPERM 说明组还在、只是不归我们管；只有 ESRCH 才是真的空了。
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
    // 只要组里还有成员，内核就不会把这个 pid 重新分配出去，负 pid 不会误伤别人。
    process.kill(-processGroupId, signal);
    return true;
  } catch {
    return false; // 已经退出的进程组再发一次信号不算错误。
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
 * 这里的定时器**不能 unref**：关机时它往往是事件循环里唯一剩下的东西，
 * unref 掉会让 Node 直接退出、barrier 的等待永远不结算——等于没等。
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
