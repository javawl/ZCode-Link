import type { BrowserType } from "playwright-core";
import {
  assertBrowserNotAborted,
  backlinkBrowserInputSchema,
  BacklinkBrowserError,
  DEFAULT_BROWSER_TIMEOUT_MS,
  hasBrowserSideEffect,
  MAX_BROWSER_TIMEOUT_MS,
  type BacklinkBrowserCommand,
  type BacklinkBrowserExecutionContext,
  type BacklinkBrowserResult,
} from "./contract.js";
import { acquireBrowserProfile } from "./profile-lock.js";
import {
  chromiumLaunchArguments,
  validateBrowserLaunchOptions,
  type BacklinkBrowserLaunchOptions,
} from "./launch-options.js";
import { BacklinkBrowserSession } from "./session.js";

export interface BacklinkBrowserOptions extends BacklinkBrowserLaunchOptions {
  profilePath: string;
  workspacePath: string;
  headless?: boolean;
  channel?: string;
  executablePath?: string;
  timeoutMs?: number;
  loadChromium?: () => Promise<Pick<BrowserType, "launchPersistentContext">>;
}

export interface BacklinkBrowserRuntime {
  execute(
    command: BacklinkBrowserCommand,
    context: BacklinkBrowserExecutionContext,
  ): Promise<BacklinkBrowserResult>;
  close(): Promise<void>;
}

class PersistentBacklinkBrowser implements BacklinkBrowserRuntime {
  readonly #options: BacklinkBrowserOptions;
  readonly #timeoutMs: number;
  readonly #queues = new Map<string, Promise<unknown>>();
  #session?: BacklinkBrowserSession;
  #launch?: Promise<BacklinkBrowserSession>;
  #closing?: Promise<void>;
  #disposed = false;

  constructor(options: BacklinkBrowserOptions) {
    validateBrowserLaunchOptions(options);
    this.#options = {
      ...options,
      ...(options.launchArgs ? { launchArgs: [...options.launchArgs] } : {}),
      ...(options.ignoreDefaultArgs ? { ignoreDefaultArgs: [...options.ignoreDefaultArgs] } : {}),
    };
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_BROWSER_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.#timeoutMs) ||
      this.#timeoutMs < 1 ||
      this.#timeoutMs > MAX_BROWSER_TIMEOUT_MS
    ) {
      throw new BacklinkBrowserError(
        "BROWSER_INVALID_INPUT",
        "Browser timeout must be between 1 and 120000 milliseconds",
      );
    }
  }

  async execute(
    raw: BacklinkBrowserCommand,
    context: BacklinkBrowserExecutionContext,
  ): Promise<BacklinkBrowserResult> {
    const parsed = backlinkBrowserInputSchema.safeParse(raw);
    if (!parsed.success)
      throw new BacklinkBrowserError(
        "BROWSER_INVALID_INPUT",
        `Invalid browser input: ${parsed.error.issues[0]?.message ?? "schema mismatch"}`,
      );
    if (!context.traceId?.trim() || !context.sessionId?.trim())
      throw new BacklinkBrowserError(
        "BROWSER_INVALID_INPUT",
        "Browser execution requires a trace and session context",
      );
    assertBrowserNotAborted(context.signal);
    if (this.#disposed || this.#closing)
      throw new BacklinkBrowserError(
        "BROWSER_SESSION_CLOSED",
        "Browser runtime is closing or has been disposed",
      );
    const command = parsed.data;
    if (command.action === "status")
      return {
        kind: "status",
        running: Boolean(this.#session && !this.#session.closed),
        headless: this.#options.headless ?? false,
        persistent: true,
      };
    if (command.action === "close") {
      await this.closeSession();
      return { kind: "acked" };
    }
    let dispatched = false;
    const key = "page" in command ? command.page : "__tabs__";
    const operation = (this.#queues.get(key) ?? Promise.resolve()).then(async () => {
      assertBrowserNotAborted(context.signal);
      if (this.#disposed || this.#closing)
        throw new BacklinkBrowserError(
          "BROWSER_SESSION_CLOSED",
          "Browser runtime is closing or has been disposed",
        );
      if (command.action === "tabs") {
        const session = this.#session ?? (this.#launch ? await this.#launch : undefined);
        return { kind: "tabs", tabs: session ? await session.tabs() : [] } as BacklinkBrowserResult;
      }
      const session = await this.ensureSession();
      assertBrowserNotAborted(context.signal);
      if (this.#disposed || this.#closing)
        throw new BacklinkBrowserError(
          "BROWSER_SESSION_CLOSED",
          "Browser runtime was closed during launch",
        );
      dispatched = true;
      try {
        return await session.execute(command);
      } catch (cause) {
        if (cause instanceof BacklinkBrowserError) throw cause;
        throw new BacklinkBrowserError(
          "BROWSER_ACTION_FAILED",
          `Browser ${command.action} failed. Observe the page before deciding whether to continue`,
          { cause, ...(hasBrowserSideEffect(command) ? { sideEffect: "uncertain" as const } : {}) },
        );
      }
    });
    const tail = operation.then(
      () => undefined,
      () => undefined,
    );
    this.#queues.set(key, tail);
    void tail.then(() => {
      if (this.#queues.get(key) === tail) this.#queues.delete(key);
    });
    // 中文依据：取消只提前结束调用方等待；真实 Playwright 动作仍占据原页队列直到完成，防止后续提交与未知动作交错。
    return await withAbort(
      operation,
      context.signal,
      () => dispatched && hasBrowserSideEffect(command),
    );
  }

  async close(): Promise<void> {
    this.#disposed = true;
    await this.closeSession();
  }

  private async ensureSession(): Promise<BacklinkBrowserSession> {
    if (this.#session && !this.#session.closed) return this.#session;
    if (this.#session) {
      await this.#session.close();
      this.#session = undefined;
    }
    this.#launch ??= this.launch().finally(() => {
      this.#launch = undefined;
    });
    return await this.#launch;
  }

  private async launch(): Promise<BacklinkBrowserSession> {
    const release = await acquireBrowserProfile(this.#options.profilePath);
    try {
      const chromium = this.#options.loadChromium
        ? await this.#options.loadChromium()
        : (await import("playwright-core")).chromium;
      const channel = this.#options.channel ?? "chrome";
      const browserContext = await chromium.launchPersistentContext(this.#options.profilePath, {
        headless: this.#options.headless ?? false,
        timeout: this.#timeoutMs,
        ...(this.#options.executablePath
          ? { executablePath: this.#options.executablePath }
          : channel && channel !== "chromium"
            ? { channel }
            : {}),
        acceptDownloads: false,
        args: chromiumLaunchArguments(this.#options),
        ...(this.#options.ignoreDefaultArgs?.length
          ? { ignoreDefaultArgs: [...this.#options.ignoreDefaultArgs] }
          : {}),
      });
      const session = new BacklinkBrowserSession(
        browserContext,
        this.#timeoutMs,
        this.#options.workspacePath,
        release,
      );
      this.#session = session;
      return session;
    } catch (cause) {
      await release();
      if (cause instanceof BacklinkBrowserError) throw cause;
      throw new BacklinkBrowserError(
        "BROWSER_LAUNCH_FAILED",
        "Unable to launch the persistent browser. Install the configured Chrome/Chromium, verify its executable and display access, and close other users of this profile",
        { cause },
      );
    }
  }

  private async closeSession(): Promise<void> {
    this.#closing ??= (async () => {
      const session = this.#session ?? (this.#launch ? await this.#launch : undefined);
      if (session) await session.close();
      this.#session = undefined;
    })().finally(() => {
      this.#closing = undefined;
    });
    await this.#closing;
  }
}

async function withAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  uncertain: () => boolean,
): Promise<T> {
  if (!signal) return await operation;
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(
        new BacklinkBrowserError(
          "BROWSER_ABORTED",
          "Browser command was cancelled",
          uncertain() ? { sideEffect: "uncertain" } : {},
        ),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
  });
}

export function createBacklinkBrowserRuntime(
  options: BacklinkBrowserOptions,
): BacklinkBrowserRuntime {
  return new PersistentBacklinkBrowser(options);
}

export { backlinkBrowserInputSchema, BacklinkBrowserError } from "./contract.js";
export type {
  BacklinkBrowserCommand,
  BacklinkBrowserExecutionContext,
  BacklinkBrowserResult,
  BacklinkBrowserTab,
  BacklinkBrowserErrorCode,
} from "./contract.js";
