import type { AgentSession, ModelOption, PermissionOption } from "../agents/types.ts";

export type AgentFeatures = {
  /** 压缩这个会话的上下文。session 是 lanting 为这个成员开好的会话，模块自己的会话类型。 */
  compact?: (session: AgentSession) => Promise<void>;
  /** 永久删除原生会话。会话已经不存在也算成功。 */
  deleteSession?: (nativeId: string, cwd: string) => Promise<void>;
  /** 可选的模型，含每个模型能选的思考强度。 */
  models?: (cwd: string) => Promise<ModelOption[]>;
  /** 可选的权限档位。 */
  permissions?: (cwd: string) => Promise<PermissionOption[]>;
};

export type AgentFeatureId = keyof AgentFeatures;

const AGENT_FEATURE_IDS: readonly AgentFeatureId[] = ["compact", "deleteSession", "models", "permissions"];

/** 这个适配器实现了哪些子功能。实现了就算支持，不另外写声明，免得声明和实现对不上。 */
export function featureIds(features: AgentFeatures): AgentFeatureId[] {
  return AGENT_FEATURE_IDS.filter((id) => typeof features[id] === "function");
}
