import { randomUUID } from "node:crypto";

import type { ApprovalAnswer, ApprovalAsk } from "../agents/types.ts";

export type ApprovalRequest = ApprovalAsk & {
  approvalId: string;
  groupId: string;
  /** Tag name of the AI requesting approval. */
  agent: string;
  createdAt: number;
  expiresAt: number;
};

export type ApprovalSettled = ApprovalRequest & ApprovalAnswer & {
  /** user: the group owner answered; timeout: nobody handled it; cancelled: the round was interrupted or the session closed. */
  by: "user" | "timeout" | "cancelled";
};

/** Approvals nobody handles are rejected by default after 120 seconds. */
export const APPROVAL_TIMEOUT_MS = 120_000;

type Entry = {
  request: ApprovalRequest;
  settle: (answer: ApprovalAnswer, by: ApprovalSettled["by"]) => void;
  timer: NodeJS.Timeout;
};

/**
 * Registry of pending approvals. One approval may be answered by several devices at once; only the first valid answer takes effect.
 * Approval requests from all three CLIs are first converted to ApprovalAsk in their adapters, then registered here uniformly.
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

  request(
    groupId: string,
    agent: string,
    ask: ApprovalAsk,
    signal?: AbortSignal,
  ): Promise<ApprovalAnswer> {
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
      const withdraw = () => settle({ decision: "deny", message: "AI 收回了这次申请。" }, "cancelled");
      if (signal?.aborted) withdraw();
      else signal?.addEventListener("abort", withdraw, { once: true });
    });
  }

  /** Returns false when this approval was already handled or doesn't exist. */
  respond(approvalId: string, decision: "allow" | "deny"): boolean {
    const entry = this.#entries.get(approvalId);
    if (!entry) return false;
    entry.settle({
      decision,
      message: decision === "allow" ? "" : "群主拒绝了这次工具调用。",
    }, "user");
    return true;
  }

  /** On interrupt or close, rejects all pending approvals for this group (optionally limited to one AI). */
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
