import type { AgentSession, ModelOption, PermissionOption } from "../agents/types.ts";

/** 片段里出现 {time} 的地方，网页按浏览器本地时间换成 time。time 一律是 ISO 字符串，由模块自己换算。 */
export type UsagePart = { text: string; time?: string };

export type UsageRequest = {
  nativeId: string;
  cwd: string;
  /** view：打开群或切换成员；turn：这个成员发言或压缩刚结束；visible：页面切回前台。 */
  reason: "view" | "turn" | "visible";
  /**
   * 取 lanting 为这个成员开的会话。open 为 false 时只返回已经在运行的会话，没有就返回 null，不拉进程。
   * 这个成员正在发言或压缩时一律返回 null。只有需要运行中 CLI 的模块才用。
   */
  session: (open: boolean) => Promise<AgentSession | null>;
};

export type AgentFeatures = {
  /** 压缩这个会话的上下文。session 是 lanting 为这个成员开好的会话，模块自己的会话类型。 */
  compact?: (session: AgentSession) => Promise<void>;
  /** 永久删除原生会话。会话已经不存在也算成功。 */
  deleteSession?: (nativeId: string, cwd: string) => Promise<void>;
  /** 可选的模型，含每个模型能选的思考强度。 */
  models?: (cwd: string) => Promise<ModelOption[]>;
  /** 可选的权限档位。 */
  permissions?: (cwd: string) => Promise<PermissionOption[]>;
  /** 上下文和额度片段，按显示顺序排列。返回 null 表示这次没有新数据，lanting 保留上一次的结果。 */
  usage?: (request: UsageRequest) => Promise<UsagePart[] | null>;
};

export type AgentFeatureId = keyof AgentFeatures;

const AGENT_FEATURE_IDS: readonly AgentFeatureId[] = [
  "compact",
  "deleteSession",
  "models",
  "permissions",
  "usage",
];

/** 这个适配器实现了哪些子功能。实现了就算支持，不另外写声明，免得声明和实现对不上。 */
export function featureIds(features: AgentFeatures): AgentFeatureId[] {
  return AGENT_FEATURE_IDS.filter((id) => typeof features[id] === "function");
}
