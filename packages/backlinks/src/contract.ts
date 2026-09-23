/** Browser-safe public vocabulary. Node adapters and credentials are intentionally separate. */
export * from "./domain/errors.js";
export * from "./domain/schemas.js";
export { backlinksCommandSchema } from "./domain/commands.js";
export type { BacklinksCommand, BacklinksCommandResult } from "./domain/commands.js";
export { backlinksSettingsPatchSchema, browserCdpEndpointSchema } from "./domain/settings.js";
export type { BacklinksSettingsPatch, BacklinksSettingsSnapshot } from "./domain/settings.js";
export type {
  BacklinkBatchOperations,
  MailboxOperations,
  MailboxStatus,
  BacklinkBatchSourceProvider,
  MailboxProvider,
  BacklinksSettingsPort,
  BacklinksRegistrationPort,
  BacklinksLifecyclePort,
  BacklinksRuntime,
} from "./domain/ports.js";
