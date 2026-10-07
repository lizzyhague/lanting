/**
 * AI 接入的统一接口。群核心只认这里的类型，不关心对面是哪家 CLI。
 * 接入新的 AI，就是新写一个 AgentAdapter 并登记到 AgentRegistry。
 *
 * 改会话名、compact、切模型和权限、审批、删除会话等操作，到用上的那一步再加进来。
 */

export type SessionOptions = {
  cwd: string;
  /** 追加在 CLI 自己的系统提示词之后，内容见 group/system-prompt.ts。 */
  systemPrompt: string;
};

export type AgentEvent =
  /** 回复正文的增量，只用于页面上的流式显示。 */
  | { type: "text"; delta: string }
  /** 思考、工具调用等过程信息：只显示给群主，不进群聊记录，不发给其他 AI。 */
  | { type: "activity"; activity: Record<string, unknown> }
  /**
   * 这次发言结束，必须是最后一个事件。text 是完整的明文回复，以它为准写进群聊记录。
   * 迭代没有给出 end 就结束或抛错，群核心按 failed 处理。
   */
  | {
    type: "end";
    outcome: "completed" | "interrupted" | "failed";
    text: string;
    error?: string;
  };

export interface AgentSession {
  /** CLI 自己的会话 id。有的 CLI 要等第一条消息之后才知道，之前为 null。 */
  readonly nativeId: string | null;
  /** 把一条 user 消息送进原生会话，同一会话同一时间只会有一个 send 在进行。 */
  send(text: string): AsyncIterable<AgentEvent>;
  /** 打断正在进行的发言；send 的迭代随后应以 interrupted 结束。 */
  interrupt(): Promise<void>;
  close(): Promise<void>;
}

export interface AgentAdapter {
  /** 标签名，也是登记用的 id：claude / codex / grok。只用小写字母。 */
  readonly id: string;
  /** 写进 system prompt 的名字，比如 Codex。 */
  readonly displayName: string;
  startSession(options: SessionOptions): Promise<AgentSession>;
  resumeSession(nativeId: string, options: SessionOptions): Promise<AgentSession>;
}
