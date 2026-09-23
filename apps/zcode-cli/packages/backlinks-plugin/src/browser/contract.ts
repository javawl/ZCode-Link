// Adapted from link-harness 2.0.0 browser vocabulary (MIT, Copyright 2026 DeepSeek).
// ZCode changes: explicit tab references, bounded schemas and structured cancellation.
import { z } from "zod";

export const DEFAULT_BROWSER_TIMEOUT_MS = 15_000;
export const MAX_BROWSER_TIMEOUT_MS = 120_000;
export const DEFAULT_SNAPSHOT_MAX_CHARS = 60_000;
export const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;
const page = z.string().trim().min(1).max(128);
const selector = z.string().trim().min(1).max(4_096);
const maxChars = z.number().int().positive().max(DEFAULT_SNAPSHOT_MAX_CHARS).optional();
const httpUrl = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  }, "Expected an HTTP(S) URL without embedded credentials");

export const backlinkBrowserInputSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("navigate"),
      page,
      url: httpUrl,
      maxChars,
      waitUntil: z.enum(["load", "domcontentloaded", "networkidle"]).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("snapshot"),
      page,
      selector: selector.optional(),
      format: z.enum(["text", "aria"]).optional(),
      maxChars,
    })
    .strict(),
  z.object({ action: z.literal("click"), page, selector }).strict(),
  z.object({ action: z.literal("fill"), page, selector, value: z.string().max(200_000) }).strict(),
  z.object({ action: z.literal("select"), page, selector, value: z.string().max(2_048) }).strict(),
  z.object({ action: z.literal("press"), page, key: z.string().trim().min(1).max(128) }).strict(),
  z
    .object({
      action: z.literal("upload"),
      page,
      selector,
      files: z.array(z.string().trim().min(1).max(4_096)).min(1).max(20),
    })
    .strict(),
  z.object({ action: z.literal("screenshot"), page }).strict(),
  z
    .object({
      action: z.literal("waitFor"),
      page,
      selector: selector.optional(),
      url: z.string().min(1).max(8_192).optional(),
      timeoutMs: z.number().int().positive().max(MAX_BROWSER_TIMEOUT_MS).optional(),
    })
    .strict()
    .refine(
      (value) => Boolean(value.selector) !== Boolean(value.url),
      "waitFor requires exactly one of selector or url",
    ),
  z.object({ action: z.literal("bringToFront"), page }).strict(),
  z.object({ action: z.literal("closePage"), page }).strict(),
  z.object({ action: z.literal("tabs") }).strict(),
  z.object({ action: z.literal("status") }).strict(),
  z.object({ action: z.literal("close") }).strict(),
]);

export type BacklinkBrowserCommand = z.infer<typeof backlinkBrowserInputSchema>;
export type BacklinkBrowserPageCommand = Exclude<
  BacklinkBrowserCommand,
  { action: "tabs" | "status" | "close" }
>;

export interface BacklinkBrowserTab {
  page: string;
  url: string;
  title: string;
  openerPage?: string;
  owned?: boolean;
}

export type BacklinkBrowserResult =
  | { kind: "page"; page: string; url: string; title: string; text: string; truncated: boolean }
  | { kind: "acked" }
  | { kind: "screenshot"; pngBase64: string }
  | { kind: "tabs"; tabs: BacklinkBrowserTab[] }
  | { kind: "status"; running: boolean; headless: boolean; persistent: true };

export interface BacklinkBrowserExecutionContext {
  signal?: AbortSignal;
  traceId: string;
  sessionId: string;
}

export type BacklinkBrowserErrorCode =
  | "BROWSER_INVALID_INPUT"
  | "BROWSER_INVALID_SELECTOR"
  | "BROWSER_PAGE_NOT_FOUND"
  | "BROWSER_ABORTED"
  | "BROWSER_ACTION_FAILED"
  | "BROWSER_LAUNCH_FAILED"
  | "BROWSER_PROFILE_IN_USE"
  | "BROWSER_PROFILE_ERROR"
  | "BROWSER_SESSION_CLOSED"
  | "BROWSER_UPLOAD_OUTSIDE_WORKSPACE"
  | "BROWSER_UPLOAD_INVALID_FILE";

export class BacklinkBrowserError extends Error {
  readonly code: BacklinkBrowserErrorCode;
  readonly sideEffect?: "uncertain";
  constructor(
    code: BacklinkBrowserErrorCode,
    message: string,
    options: { cause?: unknown; sideEffect?: "uncertain" } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "BacklinkBrowserError";
    this.code = code;
    this.sideEffect = options.sideEffect;
  }
}

export function hasBrowserSideEffect(command: BacklinkBrowserCommand): boolean {
  return ["click", "fill", "select", "press", "upload"].includes(command.action);
}

export function assertBrowserNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new BacklinkBrowserError("BROWSER_ABORTED", "Browser command was cancelled");
}
