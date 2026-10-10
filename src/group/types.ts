import type { AgentKind } from "../agents/kinds.ts";
import type { PaletteId } from "../agents/palette.ts";
import type { AgentSettings } from "../agents/types.ts";
import type { StoredAttachment } from "../attachments/prompt.ts";

export type AgentState = {
  /** 建群时冻结的 CLI 种类。 */
  kind: AgentKind;
  /** 建群时冻结的主色。 */
  color: PaletteId;
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
  /** 冻结标签：建群时从 AI 名字复制，之后不变；按建群时的设置顺序。 */
  members: string[];
  /** 上一次的点名顺序。 */
  callOrder: string[];
  agents: Record<string, AgentState>;
  createdAt: string;
  /** 最后活动时间，用于把最近动过的群排在前面。 */
  updatedAt: number;
  /** 是否固定显示在最近群会话顶部。 */
  pinned: boolean;
  /** 标题栏下面 usage 行显示哪个成员；null 表示关闭。 */
  usageAgent: string | null;
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
  /** 群主这一条带的附件。路径只留在后端。 */
  attachments?: StoredAttachment[];
  /**
   * 带附件的那一轮点了谁。这些 AI 收到附件本身；之后才被点名的 AI 只看到一行附件说明。
   */
  recipients?: string[];
};

/** 由各家适配决定内容，至少带 kind。 */
export type Activity = Record<string, unknown> & { kind: string };
