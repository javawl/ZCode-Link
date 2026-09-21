import { BacklinksError } from "../domain/errors.js";
import type { ProviderIdentity } from "../domain/ports.js";

/** Separate instances serve batch sources and mailboxes; IDs need only be unique in one registry. */
export class BacklinksProviderRegistry<P extends ProviderIdentity> {
  private readonly providers = new Map<string, P>();
  register(provider: P): () => void {
    if (this.providers.has(provider.id))
      throw new BacklinksError(
        `外链 provider 重复：${provider.id}`,
        "BACKLINKS_DUPLICATE_PROVIDER",
      );
    this.providers.set(provider.id, provider);
    return () => {
      if (this.providers.get(provider.id) === provider) this.providers.delete(provider.id);
    };
  }
  resolve(configuredId?: string): P {
    if (configuredId !== undefined) {
      const provider = this.providers.get(configuredId);
      if (!provider)
        throw new BacklinksError(
          `指定的外链 provider 未注册：${configuredId}`,
          "BACKLINKS_PROVIDER_CONFIGURED_MISSING",
        );
      if (!provider.available())
        throw new BacklinksError(
          `外链 provider 未配置服务地址或令牌：${configuredId}`,
          "BACKLINKS_PROVIDER_CONFIGURED_UNAVAILABLE",
        );
      return provider;
    }
    const usable = [...this.providers.values()].filter((provider) => provider.available());
    if (!usable.length)
      throw new BacklinksError(
        "请在外链设置中配置服务地址和令牌。",
        "BACKLINKS_PROVIDER_UNAVAILABLE",
      );
    if (usable.length > 1)
      throw new BacklinksError(
        "多个外链 provider 可用，请明确指定。",
        "BACKLINKS_PROVIDER_AMBIGUOUS",
      );
    return usable[0]!;
  }
}
