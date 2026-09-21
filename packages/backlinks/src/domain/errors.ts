/** Stable failure codes shared by the UI, MCP consumer and HTTP adapters. */
export type BacklinksErrorCode =
  | "BACKLINKS_DUPLICATE_PROVIDER"
  | "BACKLINKS_PROVIDER_CONFIGURED_MISSING"
  | "BACKLINKS_PROVIDER_CONFIGURED_UNAVAILABLE"
  | "BACKLINKS_PROVIDER_UNAVAILABLE"
  | "BACKLINKS_PROVIDER_AMBIGUOUS"
  | "BACKLINKS_UNAUTHORIZED"
  | "BACKLINKS_NOT_FOUND"
  | "BACKLINKS_CONFLICT"
  | "BACKLINKS_INVALID_REQUEST"
  | "BACKLINKS_API_ERROR"
  | "BACKLINKS_TRANSPORT"
  | "BACKLINKS_TIMEOUT"
  | "BACKLINKS_ABORTED";

export class BacklinksError extends Error {
  constructor(
    message: string,
    readonly code: BacklinksErrorCode,
    readonly retryAfterSeconds: number | null = null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BacklinksError";
  }
}
