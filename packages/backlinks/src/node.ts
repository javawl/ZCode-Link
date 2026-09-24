import { BacklinksConfigStore } from "./adapters/config-store.js";
import type { BacklinksConfigOptions } from "./adapters/config-store.js";
import { SupermanagerBatchSource } from "./adapters/supermanager.js";
import { CloudMailMailbox } from "./adapters/cloud-mail.js";
import { assembleBacklinksRuntime } from "./app/runtime.js";
import type { BacklinksRuntime } from "./domain/ports.js";

export interface CreateBacklinksRuntimeOptions extends BacklinksConfigOptions {
  readonly fetch?: typeof fetch;
}

/** Lazy Node composition. Missing settings never prevent an unrelated ZCode session from starting. */
export function createBacklinksRuntime(
  options: CreateBacklinksRuntimeOptions = {},
): BacklinksRuntime {
  const config = new BacklinksConfigStore(options);
  const env = options.env ?? process.env;
  const fetcher = options.fetch ?? fetch;
  return assembleBacklinksRuntime({
    config,
    batchSource: (value) =>
      new SupermanagerBatchSource({ ...value.supermanager, requestTimeoutMs: 15000 }, fetcher),
    mailbox: (value) =>
      new CloudMailMailbox({ ...value.cloudMail, requestTimeoutMs: 15000 }, fetcher),
    batchSourceId: env.ZCODE_BACKLINKS_BATCH_SOURCE ?? env.DSH_BACKLINKS_BATCH_SOURCE,
    mailboxId: env.ZCODE_BACKLINKS_MAILBOX ?? env.DSH_BACKLINKS_MAILBOX,
  });
}
export { BacklinksConfigStore, SupermanagerBatchSource, CloudMailMailbox };
export {
  resolveBacklinksDataBaseDir,
  resolveBacklinksConfigPath,
} from "./adapters/config-store.js";
export { BacklinksProviderRegistry } from "./app/registry.js";
export { executeBacklinksCommand } from "./app/execute.js";
export type { BacklinksRuntime } from "./domain/ports.js";
export { backlinkWorkerCommandSchema, backlinksCommandSchema } from "./domain/commands.js";
