import type { AgentKind } from "./kinds.ts";
import type { AgentFeatures } from "../features/index.ts";

/**
 * AI 接入的统一接口。群核心只认这里的类型，不关心对面是哪家 CLI。
 * 接入新的 CLI 种类，在 agents/index.ts 登记模块；需要 CLI 配合的功能在 features/index.ts 定义。
 *
 * 原生会话名不改：群主只在 lanting 里找群，永久删除时原生会话一起删掉。
 */

/**
 * 一个 AI 在某个群里的模型、思考强度和权限。null 表示不指定，跟随 CLI 自己的默认值。
 * 取值都是各家适配在 AgentCatalog 里给出的 id，群核心不解释它们的含义。
 */
export type AgentSettings = {
  model: string | null;
  /** 只在指定了模型时才有意义，必须是那个模型支持的档位之一。 */
  effort: string | null;
  permission: string | null;
};

export const DEFAULT_AGENT_SETTINGS: Readonly<AgentSettings> = Object.freeze({
  model: null,
  effort: null,
  permission: null,
});

export type ModelOption = {
  id: string;
  label: string;
  description: string;
  /** 这个模型支持的思考强度；空数组表示不能选。 */
  efforts: string[];
};

export type PermissionOption = {
  id: string;
  label: string;
  description: string;
  /** 放开限制较多的档位，网页上提醒一下。 */
  danger?: boolean;
};

/** 成员面板里能选的模型和权限，由各家适配向自己的 CLI 查询。 */
export type AgentCatalog = {
  models: ModelOption[];
  permissions: PermissionOption[];
};

export type ApprovalAsk = {
  toolName: string;
  /** 一行摘要，比如命令或文件路径。 */
  detail: string;
};

export type ApprovalAnswer = {
  decision: "allow" | "deny";
  /** 拒绝时交给 AI 的说明。 */
  message: string;
};

export type SessionOptions = {
  cwd: string;
  /** 追加在 CLI 自己的系统提示词之后，内容见 group/system-prompt.ts。 */
  systemPrompt: string;
  /** 开会话或恢复会话时应用；之后设置变了，群核心会关掉会话再用新设置恢复。 */
  settings: AgentSettings;
  /**
   * AI 要调用需要确认的工具时调用，由群主在网页上批准或拒绝。
   * CLI 自己收回请求时，适配用 signal 撤下网页上的审批。
   */
  requestApproval: (ask: ApprovalAsk, signal?: AbortSignal) => Promise<ApprovalAnswer>;
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
  /** CLI 进程已经退出时为 false；群核心会丢掉它，下次用原生会话 id 恢复。 */
  readonly alive: boolean;
  /** 把一条 user 消息送进原生会话，同一会话同一时间只会有一个 send 在进行。 */
  send(text: string): AsyncIterable<AgentEvent>;
  /** 打断正在进行的发言；send 的迭代随后应以 interrupted 结束。 */
  interrupt(): Promise<void>;
  close(): Promise<void>;
}

export interface AgentAdapter {
  /** 这个适配器接入的 CLI 种类。 */
  readonly kind: AgentKind;
  /**
   * 为 true 时每次发言结束就关掉 CLI 进程，下次点名再恢复会话；
   * 为 false 时进程留着复用，空闲一段时间后才关。照各家参照项目的做法选。
   */
  readonly closeAfterTurn: boolean;
  readonly features: AgentFeatures;
  /** 后端开始监听后启动适配器持有的常驻资源；不能阻塞服务启动。 */
  start?(): void;
  /** 后端退出时关闭适配器持有的常驻资源。 */
  close?(): Promise<void>;
  startSession(options: SessionOptions): Promise<AgentSession>;
  resumeSession(nativeId: string, options: SessionOptions): Promise<AgentSession>;
}
