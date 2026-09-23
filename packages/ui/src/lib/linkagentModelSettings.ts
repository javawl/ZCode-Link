import type { ProviderSettingsFormProvider } from "./providerSettingsFormTypes.js";

/** 只投影 Personal API 编辑项；账号套餐仍属于原服务，隐藏 UI 不删除配置或伪造权限。 */
export function isLinkAgentApiProvider(
  provider: Pick<ProviderSettingsFormProvider, "config">,
): boolean {
  return (
    provider.config.group === "standard-personal" &&
    provider.config.access?.type !== "zhipu-account"
  );
}

/** 这两个旧模板实际指向 Coding Plan；保留普通 API 模板和用户自建供应商。 */
export function isLinkAgentApiTemplate(template: { templateId: string }): boolean {
  return template.templateId !== "bigmodel-api" && template.templateId !== "zai-api";
}
