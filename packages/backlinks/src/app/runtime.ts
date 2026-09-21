import type {
  BacklinksConfigPort,
  BacklinksRuntime,
  BacklinkBatchSourceProvider,
  MailboxProvider,
} from "../domain/ports.js";
import type { EffectiveBacklinksConfig } from "../domain/settings.js";
import { BacklinksError } from "../domain/errors.js";
import { BacklinksProviderRegistry } from "./registry.js";
import { OwnedBacklinksLeases } from "./leases.js";

export interface BacklinksRuntimePorts {
  readonly config: BacklinksConfigPort;
  readonly batchSource: (config: EffectiveBacklinksConfig) => BacklinkBatchSourceProvider;
  readonly mailbox: (config: EffectiveBacklinksConfig) => MailboxProvider;
  readonly batchSourceId?: string;
  readonly mailboxId?: string;
}

/** Application orchestration reads current configuration; backend leases remain the work owner. */
export function assembleBacklinksRuntime(ports: BacklinksRuntimePorts): BacklinksRuntime {
  const batches = new BacklinksProviderRegistry<BacklinkBatchSourceProvider>();
  const mailboxes = new BacklinksProviderRegistry<MailboxProvider>();
  const leases = new OwnedBacklinksLeases();
  const pendingClaims = new Set<Promise<unknown>>();
  const trackClaim = async <T>(operation: () => Promise<T>): Promise<T> => {
    const pending = operation();
    pendingClaims.add(pending);
    try {
      return await pending;
    } finally {
      pendingClaims.delete(pending);
    }
  };
  let disposeBatch: (() => void) | undefined;
  let disposeMailbox: (() => void) | undefined;
  const batch = async () => {
    const config = await ports.config.readEffective();
    disposeBatch?.();
    disposeBatch = batches.register(ports.batchSource(config));
    return batches.resolve(ports.batchSourceId);
  };
  const mail = async () => {
    const config = await ports.config.readEffective();
    disposeMailbox?.();
    disposeMailbox = mailboxes.register(ports.mailbox(config));
    return mailboxes.resolve(ports.mailboxId);
  };
  return {
    getSettings: () => ports.config.getSettings(),
    updateSettings: (input) => ports.config.updateSettings(input),
    registerBatchSourceProvider: (provider) => batches.register(provider),
    registerMailboxProvider: (provider) => mailboxes.register(provider),
    releaseOwnedLeases: async (signal) => {
      // 关闭入口先停止新调用，再等待认领回执入账，避免释放快照漏掉刚获得的租约。
      await Promise.allSettled(pendingClaims);
      await leases.releaseAll(signal);
    },
    listBatches: async (signal) => (await batch()).listBatches(signal),
    getBatch: async (id, signal) => (await batch()).getBatch(id, signal),
    claim: (id, itemIds, signal) =>
      trackClaim(async () => {
        const provider = await batch();
        const detail = await provider.getBatch(id, signal);
        const publishedSources = new Set(
          detail.items
            .filter(
              (item) =>
                Boolean(item.publishedUrl) ||
                ["submitted", "live"].includes(item.publishStatus ?? ""),
            )
            .map((item) => item.sourceId),
        );
        if (
          itemIds &&
          (!itemIds.length ||
            itemIds.some(
              (itemId) =>
                !Number.isSafeInteger(itemId) ||
                itemId <= 0 ||
                !detail.items.some((item) => item.id === itemId),
            ))
        )
          throw new BacklinksError(
            "认领列表包含无效或不属于该批次的条目。",
            "BACKLINKS_INVALID_REQUEST",
          );
        const selected = detail.items.filter((item) => {
          if (
            publishedSources.has(item.sourceId) ||
            !(itemIds
              ? itemIds.includes(item.id)
              : item.status === "pending" ||
                (item.status === "failed" && item.failureMode === "retryable"))
          )
            return false;
          // 同一个来源不能在本次认领中携带两个待提交条目。
          publishedSources.add(item.sourceId);
          return true;
        });
        if (!selected.length)
          throw new BacklinksError(
            "没有可认领条目；已发布条目及同来源记录已排除。",
            "BACKLINKS_INVALID_REQUEST",
          );
        const claim = await provider.claim(
          id,
          selected.map((item) => item.id),
          signal,
        );
        // 后端响应必须局限于本次显式认领，防止意外扩大执行范围。
        if (claim.items.some((item) => !selected.some((candidate) => candidate.id === item.id))) {
          await provider.release(claim.leaseId);
          throw new BacklinksError(
            "后台授予了请求范围外的条目，已释放该租约。",
            "BACKLINKS_API_ERROR",
          );
        }
        leases.remember(claim, provider);
        return claim;
      }),
    heartbeat: async (id, signal) =>
      (leases.providerForLease(id) ?? (await batch())).heartbeat(id, signal),
    release: async (id, signal) => {
      await (leases.providerForLease(id) ?? (await batch())).release(id, signal);
      leases.forget(id);
    },
    reportItemResult: async (id, result, signal) =>
      (leases.providerForItem(id) ?? (await batch())).reportItemResult(id, result, signal),
    addBadge: async (id, badge, signal) => (await batch()).addBadge(id, badge, signal),
    tagSource: async (id, names, signal) => (await batch()).tagSource(id, names, signal),
    createMailbox: async (options, signal) => (await mail()).createMailbox(options, signal),
    pollMail: async (address, options, signal) => (await mail()).pollMail(address, options, signal),
  };
}
