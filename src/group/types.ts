import type { AgentSettings } from "../agents/types.ts";

export type AgentState = {
  /** CLI 的原生会话 id；还没开过会话时为 null。 */
  nativeSessionId: string | null;
  /**
   * 这个 AI 已经看到群聊记录的哪一条（seq）。0 表示什么都没看到，
   * 第一次被点名时会收到开群以来的全部内容。
   */
  cursor: number;
  /** 这个群里给它选的模型、思考强度和权限，只影响这个群。 */
  settings: AgentSettings;
};

export type Group = {
  id: string;
  title: string;
  /** 群里所有 AI 的工作目录，绝对路径。 */
  cwd: string;
  /** 建群时的用户名，之后不再改变。 */
  username: string;
  /** 成员的 AI 标签名，按界面顺序。 */
  members: string[];
  /** 上一次的点名顺序。 */
  callOrder: string[];
  agents: Record<string, AgentState>;
  createdAt: string;
  /** 移入回收站的时间；不在回收站时为 null。到期时间由它推出来，不另存。 */
  trashedAt: string | null;
  /**
   * 开始永久删除的时间。删到一半失败时留着，服务启动和下一次扫描时接着删；
   * 这期间群不能恢复，也不能做别的操作。
   */
  deletingAt: string | null;
};

export type Speaker =
  | { role: "host" }
  | { role: "agent"; agent: string }
  /** 群里的提示（比如压缩了谁的上下文），只给群主看，不转给任何 AI。 */
  | { role: "notice"; agent: string };

export type ReplyStatus = "completed" | "interrupted" | "failed";

export type TranscriptEntry = {
  /** 从 1 开始，按追加顺序递增。 */
  seq: number;
  at: string;
  from: Speaker;
  text: string;
  /** 只有 AI 的发言有。只有 completed 的回复会转给其他 AI。 */
  status?: ReplyStatus;
  error?: string;
  /** 这次发言的过程信息（工具调用等），只给群主看，不转给其他 AI。 */
  activities?: Activity[];
};

/** 由各家适配决定内容，至少带 kind。 */
export type Activity = Record<string, unknown> & { kind: string };
