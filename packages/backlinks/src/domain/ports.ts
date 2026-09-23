import type {
  BacklinkBatchSummary,
  BacklinkBatchDetail,
  BacklinkLeaseClaim,
  BacklinkHeartbeat,
  BacklinkItemResult,
  BacklinkItemOutcome,
  BacklinkBadgeInput,
  BacklinkBadgeResult,
  BacklinkTagResult,
  MailboxAddress,
  MailPollOptions,
  VerificationMail,
} from "./schemas.js";
import type {
  BacklinksSettingsPatch,
  BacklinksSettingsSnapshot,
  EffectiveBacklinksConfig,
} from "./settings.js";

export interface BacklinkBatchOperations {
  listBatches(signal?: AbortSignal): Promise<readonly BacklinkBatchSummary[]>;
  getBatch(batchId: number, signal?: AbortSignal): Promise<BacklinkBatchDetail>;
  claim(
    batchId: number,
    itemIds?: readonly number[],
    signal?: AbortSignal,
  ): Promise<BacklinkLeaseClaim>;
  heartbeat(leaseId: number, signal?: AbortSignal): Promise<BacklinkHeartbeat>;
  release(leaseId: number, signal?: AbortSignal): Promise<void>;
  reportItemResult(
    itemId: number,
    result: BacklinkItemResult,
    signal?: AbortSignal,
  ): Promise<BacklinkItemOutcome>;
  addBadge(
    websiteId: number,
    badge: BacklinkBadgeInput,
    signal?: AbortSignal,
  ): Promise<BacklinkBadgeResult>;
  tagSource(
    sourceId: number,
    names: readonly string[],
    signal?: AbortSignal,
  ): Promise<BacklinkTagResult>;
}
export interface MailboxOperations {
  createMailbox(
    options: { readonly localPart: string; readonly domain: string },
    signal?: AbortSignal,
  ): Promise<MailboxAddress>;
  pollMail(
    address: MailboxAddress,
    options: MailPollOptions,
    signal?: AbortSignal,
  ): Promise<VerificationMail | null>;
}
export interface ProviderIdentity {
  readonly id: string;
  available(): boolean;
}
export interface BacklinkBatchSourceProvider extends ProviderIdentity, BacklinkBatchOperations {}
export interface MailboxProvider extends ProviderIdentity, MailboxOperations {
  listDomains?(signal?: AbortSignal): Promise<readonly string[]>;
}
export interface MailboxStatus {
  readonly configured: boolean;
  readonly defaultDomain: string;
  readonly domains: readonly string[];
  readonly domainSource: "configured" | "discovered" | "unavailable";
  readonly discoveryError?: string;
}
export interface MailboxStatusPort {
  getMailboxStatus(signal?: AbortSignal): Promise<MailboxStatus>;
}
export interface BacklinksSettingsPort {
  getSettings(): Promise<BacklinksSettingsSnapshot>;
  updateSettings(input: BacklinksSettingsPatch): Promise<BacklinksSettingsSnapshot>;
}
export interface BacklinksRegistrationPort {
  registerBatchSourceProvider(provider: BacklinkBatchSourceProvider): () => void;
  registerMailboxProvider(provider: MailboxProvider): () => void;
}
export interface BacklinksLifecyclePort {
  releaseOwnedLeases(signal?: AbortSignal): Promise<void>;
}
export type BacklinksRuntime = BacklinkBatchOperations &
  MailboxOperations &
  MailboxStatusPort &
  BacklinksSettingsPort &
  BacklinksRegistrationPort &
  BacklinksLifecyclePort;
export interface BacklinksConfigPort extends BacklinksSettingsPort {
  readEffective(): Promise<EffectiveBacklinksConfig>;
}
