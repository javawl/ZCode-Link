import { BacklinksError } from "../domain/errors.js";
import type { BacklinkBatchSourceProvider } from "../domain/ports.js";
import type { BacklinkLeaseClaim } from "../domain/schemas.js";

/** Tracks only leases this process obtained; the server remains authoritative for expiry and results. */
export class OwnedBacklinksLeases {
  private readonly leases = new Map<
    number,
    { provider: BacklinkBatchSourceProvider; itemIds: ReadonlySet<number>; ownerKey?: string }
  >();
  remember(
    claim: BacklinkLeaseClaim,
    provider: BacklinkBatchSourceProvider,
    ownerKey?: string,
  ): void {
    if (this.leases.has(claim.leaseId))
      throw new BacklinksError(
        `租约 ${claim.leaseId} 已由本进程持有，请先释放再认领。`,
        "BACKLINKS_CONFLICT",
      );
    this.leases.set(claim.leaseId, {
      provider,
      itemIds: new Set(claim.items.map((item) => item.id)),
      ...(ownerKey ? { ownerKey } : {}),
    });
  }
  providerForLease(id: number): BacklinkBatchSourceProvider | undefined {
    return this.leases.get(id)?.provider;
  }
  providerForItem(id: number): BacklinkBatchSourceProvider | undefined {
    for (const lease of this.leases.values()) if (lease.itemIds.has(id)) return lease.provider;
    if (this.leases.size)
      throw new BacklinksError("该条目不属于本进程已认领的租约。", "BACKLINKS_INVALID_REQUEST");
    // 独立子任务可仅回写后端已认领的 item；源 API 的授权由后端校验。
    return undefined;
  }
  forget(id: number): void {
    this.leases.delete(id);
  }
  async releaseAll(options: { ownerKey?: string; signal?: AbortSignal } = {}): Promise<void> {
    let failure: unknown;
    for (const [id, lease] of this.leases) {
      if (options.ownerKey && lease.ownerKey !== options.ownerKey) continue;
      try {
        await lease.provider.release(id, options.signal);
        this.leases.delete(id);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
  }
}
