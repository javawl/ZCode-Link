import { BacklinksError } from "../domain/errors.js";
import type { MailboxProvider, MailboxStatus } from "../domain/ports.js";
import type { EffectiveBacklinksConfig } from "../domain/settings.js";

/** 只读能力检查：域名可解析不等于创建权限或收信能力已经验证。 */
export async function readMailboxStatus(
  config: EffectiveBacklinksConfig,
  provider: MailboxProvider,
  signal?: AbortSignal,
): Promise<MailboxStatus> {
  const configured = provider.available();
  if (config.mailboxDomain)
    return {
      configured,
      defaultDomain: config.mailboxDomain,
      domains: [config.mailboxDomain],
      domainSource: "configured",
    };
  const unavailable = {
    configured,
    defaultDomain: "",
    domains: [],
    domainSource: "unavailable",
  } as const;
  if (!configured) return unavailable;
  try {
    const domains = (await provider.listDomains?.(signal)) ?? [];
    if (domains.length)
      return { configured, defaultDomain: domains[0]!, domains, domainSource: "discovered" };
    return {
      ...unavailable,
      discoveryError: "Cloud Mail 未返回可用域名，请在连接与浏览器中填写验证邮箱域名。",
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      ...unavailable,
      discoveryError:
        error instanceof BacklinksError
          ? error.message
          : "Cloud Mail 域名查询失败，请检查配置或手动填写验证邮箱域名。",
    };
  }
}
