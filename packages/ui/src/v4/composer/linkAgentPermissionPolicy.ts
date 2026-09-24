import { LINK_AGENT_PRODUCT_PROFILE } from "@zcode/shared";
import type { SessionConfigState } from "@zcode/shared/zcode-protocol-v4";
import type { V4ComposerDraft } from "@/v4/composer/composerDraftStore.js";

/**
 * LinkAgent 是固定完全访问产品。旧草稿和恢复投影只能提供正文/模型种子，
 * 不能把历史权限或计划状态重新带回下一次提交。
 */
export function applyLinkAgentPermissionPolicy(draft: V4ComposerDraft): V4ComposerDraft {
  const mode = LINK_AGENT_PRODUCT_PROFILE.agentPermission.mode;
  if (draft.mode === mode && draft.planEnabled === false) return draft;
  return { ...draft, mode, planEnabled: false };
}

/** Runtime 的每次 create/send 配置都显式携带固定策略，避免只靠 UI 展示。 */
export function buildLinkAgentSubmissionConfig(
  config: Partial<SessionConfigState>,
): Partial<SessionConfigState> {
  return {
    ...config,
    mode: LINK_AGENT_PRODUCT_PROFILE.agentPermission.mode,
    planEnabled: false,
  };
}
