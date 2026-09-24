/**
 * LinkAgent 的产品边界由这一份纯数据 Profile 统一描述。
 *
 * 各端只能把它投影成自己的导航、服务或资产规则，不能在 UI、Host 和 Agent
 * 分别维护另一套“当前产品是否支持某功能”的事实。
 */
export const LINK_AGENT_PRODUCT_PROFILE = {
  id: "linkagent",
  agentPermission: {
    mode: "yolo",
    mutable: false,
  },
  primaryNavigation: ["runs", "backlinks"],
  settingsSections: ["general", "appearance", "modelProvider", "backlinks"],
  officialPlugins: ["backlinks"],
  features: {
    genericTaskCreation: false,
    commandCenter: false,
    automations: false,
    pluginStore: false,
    offPeak: false,
    feedback: false,
  },
} as const;

export type LinkAgentPrimaryNavigation =
  (typeof LINK_AGENT_PRODUCT_PROFILE.primaryNavigation)[number];
export type LinkAgentSettingsSection = (typeof LINK_AGENT_PRODUCT_PROFILE.settingsSections)[number];

export function isLinkAgentSettingsSection(value: string): value is LinkAgentSettingsSection {
  return (LINK_AGENT_PRODUCT_PROFILE.settingsSections as readonly string[]).includes(value);
}

export function isLinkAgentOfficialPlugin(value: string): boolean {
  return (LINK_AGENT_PRODUCT_PROFILE.officialPlugins as readonly string[]).includes(value);
}
