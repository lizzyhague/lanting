import { randomUUID } from "node:crypto";

import type { ApprovalAnswer, ApprovalAsk } from "../agents/types.ts";

export type ApprovalRequest = ApprovalAsk & {
  approvalId: string;
  groupId: string;
  /** 发起审批的 AI 的标签名。 */
  agent: string;
  createdAt: number;
  expiresAt: number;
};

export type ApprovalSettled = ApprovalRequest & ApprovalAnswer & {
  /** user：群主回复；timeout：无人处理；cancelled：这一轮被打断或会话关闭。 */
  by: "user" | "timeout" | "cancelled";
};

/** 无人处理的审批在 120 秒后默认拒绝。 */
export const APPROVAL_TIMEOUT_MS = 120_000;

type Entry = {
  request: ApprovalRequest;
  settle: (answer: ApprovalAnswer, by: ApprovalSettled["by"]) => void;
  timer: NodeJS.Timeout;
};

/**
 * 未决审批的登记处。同一条审批可能被多台设备同时回复，只有第一条有效回复生效。
 * 三家 CLI 的审批请求都先在各自的适配里转成 ApprovalAsk，再到这里统一登记。
 */
export class ApprovalRegistry {
  readonly #entries = new Map<string, Entry>();
  readonly #listeners = new Set<(event: ApprovalEvent) => void>();
  readonly #timeoutMs: number;

  constructor(timeoutMs: number = APPROVAL_TIMEOUT_MS) {
    this.#timeoutMs = timeoutMs;
  }

  onEvent(listener: (event: ApprovalEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  request(groupId: string, agent: string, ask: ApprovalAsk): Promise<ApprovalAnswer> {
    const now = Date.now();
    const request: ApprovalRequest = {
      ...ask,
      approvalId: randomUUID(),
      groupId,
      agent,
      createdAt: now,
      expiresAt: now + this.#timeoutMs,
    };
    return new Promise<ApprovalAnswer>((resolve) => {
      const settle = (answer: ApprovalAnswer, by: ApprovalSettled["by"]) => {
        const entry = this.#entries.get(request.approvalId);
        if (!entry) return;
        this.#entries.delete(request.approvalId);
        clearTimeout(entry.timer);
        this.#emit({ type: "approval.settled", approval: { ...request, ...answer, by } });
        resolve(answer);
      };
      const timer = setTimeout(() => {
        settle({ decision: "deny", message: "等待确认超时，已自动拒绝。" }, "timeout");
      }, this.#timeoutMs);
      timer.unref();
      this.#entries.set(request.approvalId, { request, settle, timer });
      this.#emit({ type: "approval.requested", approval: request });
    });
  }

  /** 返回 false 表示这条审批已经处理过或不存在。 */
  respond(approvalId: string, decision: "allow" | "deny"): boolean {
    const entry = this.#entries.get(approvalId);
    if (!entry) return false;
    entry.settle({
      decision,
      message: decision === "allow" ? "" : "群主拒绝了这次工具调用。",
    }, "user");
    return true;
  }

  /** 打断或关闭时，把这个群（可限定某个 AI）的未决审批全部拒绝。 */
  cancel(groupId: string, agent?: string): void {
    for (const entry of [...this.#entries.values()]) {
      if (entry.request.groupId !== groupId) continue;
      if (agent !== undefined && entry.request.agent !== agent) continue;
      entry.settle({ decision: "deny", message: "这一轮已结束，工具调用被取消。" }, "cancelled");
    }
  }

  pending(groupId: string): ApprovalRequest[] {
    return [...this.#entries.values()]
      .map((entry) => entry.request)
      .filter((request) => request.groupId === groupId);
  }

  #emit(event: ApprovalEvent): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch (error) {
        console.error(`审批事件处理出错：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

export type ApprovalEvent =
  | { type: "approval.requested"; approval: ApprovalRequest }
  | { type: "approval.settled"; approval: ApprovalSettled };
