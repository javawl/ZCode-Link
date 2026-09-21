import type { BacklinksSettingsPort, BacklinkBatchOperations } from "./contract.js";

/** UI callers see only a token presence flag and the authoritative backend batches. */
export async function describeBacklinks(
  port: BacklinksSettingsPort & Pick<BacklinkBatchOperations, "listBatches">,
) {
  const settings = await port.getSettings();
  return settings.supermanager.tokenConfigured ? await port.listBatches() : [];
}
