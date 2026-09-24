import type { BacklinksSettingsPort, BacklinkBatchOperations } from "./contract.js";
import type { BacklinksSessionLeasePort } from "./contract.js";

/** UI callers see only a token presence flag and the authoritative backend batches. */
export async function describeBacklinks(
  port: BacklinksSettingsPort & Pick<BacklinkBatchOperations, "listBatches">,
) {
  const settings = await port.getSettings();
  return settings.supermanager.tokenConfigured ? await port.listBatches() : [];
}

/** Host cleanup uses its trusted session identity; model arguments never choose the owner key. */
export async function stopOwnedBacklinkRun(
  port: Pick<BacklinksSessionLeasePort, "releaseOwnedLeasesForOwner">,
  sessionId: string,
): Promise<void> {
  await port.releaseOwnedLeasesForOwner(sessionId);
}
