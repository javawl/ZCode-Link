import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  backlinkWorkerCommandSchema,
  backlinksCommandSchema,
  type BacklinksSettingsSnapshot,
} from "@zcode/backlinks";
import { createBacklinksRuntime, executeBacklinksCommand } from "@zcode/backlinks/node";
import { z } from "zod";
import { backlinkBrowserInputSchema, createBacklinkBrowserRuntime } from "./browser/index.js";
import { toBacklinksMcpError, toBacklinksMcpResult, type BacklinksMcpResult } from "./result.js";

const TOOL_TIMEOUT_MS = 300_000;

export interface BacklinksRequestContext {
  trace_id?: string;
  session_id?: string;
  workspace_identity?: string;
  workspace_path?: string;
}

type Command = z.infer<typeof backlinksCommandSchema>;
type BrowserRuntime = ReturnType<typeof createBacklinkBrowserRuntime>;
type BrowserOptions = Parameters<typeof createBacklinkBrowserRuntime>[0];

export interface BacklinksHandlerOptions {
  dataBaseDir?: string;
  workspacePath?: string;
  env?: Record<string, string | undefined>;
  getSettings?: () => Promise<BacklinksSettingsSnapshot>;
  execute?: (
    input: Command,
    signal?: AbortSignal,
    requestContext?: BacklinksRequestContext,
  ) => Promise<Record<string, unknown>>;
  releaseSessionLeases?: (sessionId: string, signal?: AbortSignal) => Promise<void>;
  createBrowser?: (options: BrowserOptions) => BrowserRuntime;
}

export function createBacklinksToolHandlers(options: BacklinksHandlerOptions = {}) {
  const env = options.env ?? { ...process.env };
  const dataBaseDir = resolve(
    options.dataBaseDir ?? (env.ZCODE_DATA_BASE_DIR?.trim() || env.HOME?.trim() || homedir()),
  );
  const workspacePath = resolve(options.workspacePath ?? env.ZCODE_PROJECT_DIR ?? process.cwd());
  const requestScope = new AsyncLocalStorage<BacklinksRequestContext>();
  const runtime = createBacklinksRuntime({
    dataBaseDir,
    env,
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      const traceId = requestScope.getStore()?.trace_id;
      if (traceId) headers.set("X-ZCode-Trace-Id", traceId);
      return fetch(input, { ...init, headers });
    },
  });
  const execute =
    options.execute ??
    ((input, signal, requestContext) =>
      executeBacklinksCommand(runtime, input, signal, {
        ...(requestContext?.session_id ? { ownerKey: requestContext.session_id } : {}),
      }));
  const releaseSessionLeases =
    options.releaseSessionLeases ??
    ((sessionId: string, signal?: AbortSignal) =>
      runtime.releaseOwnedLeasesForOwner(sessionId, signal));
  const getSettings = options.getSettings ?? (() => runtime.getSettings());
  const shutdownController = new AbortController();
  let browser: Promise<BrowserRuntime> | undefined;
  let browserIdentity: string | undefined;

  const identityFor = (context: BacklinksRequestContext) =>
    context.workspace_identity?.trim() || workspacePath;
  const hashFor = (identity: string) => createHash("sha256").update(identity).digest("hex");

  async function getBrowser(context: BacklinksRequestContext): Promise<BrowserRuntime> {
    if (!context.trace_id?.trim() || !context.session_id?.trim()) {
      throw new Error("backlinks_browser requires a ZCode session and trace context.");
    }
    if (context.workspace_path && resolve(context.workspace_path) !== workspacePath) {
      throw new Error("The browser request belongs to a different workspace.");
    }
    const identity = identityFor(context);
    if (browserIdentity && browserIdentity !== identity) {
      throw new Error("The browser request belongs to a different workspace identity.");
    }
    browserIdentity = identity;
    if (!browser) {
      const starting = getSettings().then((settings) =>
        (options.createBrowser ?? createBacklinkBrowserRuntime)({
          profilePath: join(
            dataBaseDir,
            ".zcode",
            "backlinks",
            "browser",
            hashFor(
              settings.browser.cdpEndpoint ? `cdp:${settings.browser.cdpEndpoint}` : identity,
            ),
          ),
          userDataDir: settings.browser.userDataDir || undefined,
          cdpEndpoint: settings.browser.cdpEndpoint || undefined,
          workspacePath,
          headless: settings.browser.headless,
          channel: settings.browser.channel,
          executablePath: settings.browser.executablePath || undefined,
          launchArgs: settings.browser.launchArgs,
          ignoreDefaultArgs: settings.browser.ignoreDefaultArgs,
          windowPosition: settings.browser.windowPosition,
        }),
      );
      browser = starting;
      void starting.catch(() => {
        if (browser === starting) browser = undefined;
      });
    }
    return browser;
  }

  return {
    async call(
      name: string,
      input: unknown,
      context: { signal?: AbortSignal; requestContext?: BacklinksRequestContext },
    ): Promise<BacklinksMcpResult> {
      const requestContext = context.requestContext ?? {};
      const signals = [shutdownController.signal, AbortSignal.timeout(TOOL_TIMEOUT_MS)];
      if (context.signal) signals.push(context.signal);
      const signal = AbortSignal.any(signals);
      return requestScope.run(requestContext, async () => {
        try {
          signal.throwIfAborted();
          const artifactDirectory = join(
            dataBaseDir,
            ".zcode",
            "backlinks",
            "artifacts",
            hashFor(identityFor(requestContext)),
          );
          if (name === "backlinks_status") {
            z.object({})
              .strict()
              .parse(input ?? {});
            const settings = await getSettings();
            const mailbox = await runtime.getMailboxStatus(signal);
            return toBacklinksMcpResult({ settings, mailbox }, artifactDirectory);
          }
          if (name === "backlinks") {
            const command = backlinksCommandSchema.parse(input);
            const result = await execute(command, signal, requestContext);
            return toBacklinksMcpResult({ ...result }, artifactDirectory);
          }
          if (name === "backlinks_worker") {
            const command = backlinkWorkerCommandSchema.parse(input);
            const result = await execute(command, signal, requestContext);
            return toBacklinksMcpResult({ ...result }, artifactDirectory);
          }
          if (name === "backlinks_cleanup") {
            z.object({}).strict().parse(input ?? {});
            const sessionId = requestContext.session_id?.trim();
            if (!sessionId) {
              throw new Error("backlinks_cleanup requires a host-injected session context.");
            }
            await releaseSessionLeases(sessionId, signal);
            return toBacklinksMcpResult(
              { released: true, sessionId },
              artifactDirectory,
            );
          }
          if (name === "backlinks_browser") {
            const command = backlinkBrowserInputSchema.parse(input);
            const instance = await getBrowser(requestContext);
            const result = await instance.execute(command, {
              signal,
              traceId: requestContext.trace_id!,
              sessionId: requestContext.session_id!,
            });
            if (command.action === "close") {
              await instance.close();
              browser = undefined;
              browserIdentity = undefined;
            }
            if (result.kind === "screenshot") {
              return {
                content: [{ type: "image", mimeType: "image/png", data: result.pngBase64 }],
              };
            }
            return toBacklinksMcpResult({ ...result }, artifactDirectory);
          }
          throw new Error(`Unknown backlink tool: ${name}`);
        } catch (error) {
          return toBacklinksMcpError(error);
        }
      });
    },
    async close(): Promise<void> {
      shutdownController.abort();
      const outcomes = await Promise.allSettled([
        browser ? browser.then((instance) => instance.close()) : Promise.resolve(),
        runtime.releaseOwnedLeases(AbortSignal.timeout(5_000)),
      ]);
      const failed = outcomes.find((outcome) => outcome.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    },
  };
}
