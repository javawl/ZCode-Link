import type { Page } from "playwright-core";
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { browserCdpEndpointSchema } from "@zcode/backlinks";
import {
  assertBrowserNotAborted,
  backlinkBrowserInputSchema,
  BacklinkBrowserError,
  DEFAULT_BROWSER_TIMEOUT_MS,
  hasBrowserSideEffect,
  MAX_BROWSER_TIMEOUT_MS,
  type BacklinkBrowserCommand,
  type BacklinkBrowserDisplayMode,
  type BacklinkBrowserExecutionContext,
  type BacklinkBrowserResult,
  withBrowserAbort,
} from "./contract.js";
import { acquireBrowserProfile } from "./profile-lock.js";
import { chromiumLaunchArguments, validateBrowserLaunchOptions } from "./launch-options.js";
import { createBrowserPresenter } from "./presentation.js";
import type {
  BacklinkBrowserOptions,
  BacklinkBrowserRuntime,
  BacklinkItemPageOutcome,
} from "./runtime-options.js";
import { KeyedSerialQueues } from "./serial-queues.js";
import { BacklinkBrowserSession } from "./session.js";

export type {
  BacklinkBrowserOptions,
  BacklinkBrowserRuntime,
  BacklinkItemPageOutcome,
} from "./runtime-options.js";

const SWEEP_INTERVAL_MS = 60_000;

class PersistentBacklinkBrowser implements BacklinkBrowserRuntime {
  readonly #options: BacklinkBrowserOptions;
  readonly #timeoutMs: number;
  readonly #displayMode: BacklinkBrowserDisplayMode;
  readonly #now: () => number;
  readonly #queues = new KeyedSerialQueues();
  #session?: BacklinkBrowserSession;
  #launch?: Promise<BacklinkBrowserSession>;
  #closing?: Promise<void>;
  #sweeper?: ReturnType<typeof setInterval>;
  #disposed = false;
  #idleClosing = false;
  #retiredByIdle = false;

  constructor(options: BacklinkBrowserOptions) {
    validateBrowserLaunchOptions(options);
    if (
      (options.userDataDir && options.cdpEndpoint) ||
      (options.userDataDir && !isAbsolute(options.userDataDir))
    )
      throw new BacklinkBrowserError(
        "BROWSER_INVALID_INPUT",
        "Choose an absolute existing profile path or a local CDP endpoint",
      );
    const endpoint = browserCdpEndpointSchema.safeParse(options.cdpEndpoint ?? "");
    if (!endpoint.success)
      throw new BacklinkBrowserError(
        "BROWSER_INVALID_INPUT",
        "CDP requires a local HTTP origin without credentials or a path",
      );
    this.#options = {
      ...options,
      cdpEndpoint: endpoint.data || undefined,
      ...(options.launchArgs ? { launchArgs: [...options.launchArgs] } : {}),
      ...(options.ignoreDefaultArgs ? { ignoreDefaultArgs: [...options.ignoreDefaultArgs] } : {}),
    };
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_BROWSER_TIMEOUT_MS;
    this.#displayMode = options.displayMode ?? (options.headless ? "headless" : "background");
    this.#now = options.now ?? Date.now;
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
    await this.#awaitIdleClose();
    this.#assertOpen();
    const command = parsed.data;
    if (command.action === "status") {
      const session = this.#session && !this.#session.closed ? this.#session : undefined;
      return {
        kind: "status",
        running: Boolean(session),
        headless: this.#displayMode === "headless",
        persistent: true,
        displayMode: this.#displayMode,
        pages: session?.pageCount ?? 0,
        heldPages: session?.heldCount ?? 0,
      };
    }
    if (command.action === "close") {
      await this.closeSession();
      return { kind: "acked" };
    }
    let dispatched = false;
    const key = "page" in command ? command.page : "__tabs__";
    const operation = this.#enqueue(key, async () => {
      assertBrowserNotAborted(context.signal);
      await this.#awaitIdleClose();
      this.#assertOpen();
      if (command.action === "tabs") {
        const session = this.#options.cdpEndpoint
          ? await this.ensureSession()
          : (this.#session ?? (this.#launch ? await this.#launch : undefined));
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
    // 中文依据：取消只提前结束调用方等待；真实 Playwright 动作仍占据原页队列直到完成，防止后续提交与未知动作交错。
    return await withBrowserAbort(
      operation,
      context.signal,
      () => dispatched && hasBrowserSideEffect(command),
    );
  }

  async releaseItemPages(itemId: number, outcome: BacklinkItemPageOutcome): Promise<void> {
    const session = this.#session;
    if (!session || session.closed || this.#disposed) return;
    // 回收排入各页现有串行队列，永远不会在同页动作执行中清空或关闭页面。
    await Promise.allSettled(
      session.itemPageNames(itemId).map((name) =>
        this.#enqueue(name, async () => {
          if (outcome === "hold") session.hold(name, "manual_required");
          else await session.recycle(name);
        }),
      ),
    );
  }

  isIdle(): boolean {
    if (this.#queues.size > 0 || this.#launch || this.#closing) return false;
    return !this.#session || this.#session.closed || this.#session.vacant;
  }

  async close(): Promise<void> {
    this.#disposed = true;
    await this.closeSession();
  }

  /** 内部空闲关闭不是用户的关闭指令：等待其完成后按需重新启动。 */
  async #awaitIdleClose(): Promise<void> {
    while (this.#idleClosing && this.#closing && !this.#retiredByIdle)
      await this.#closing.catch(() => undefined);
  }

  #assertOpen(): void {
    if (this.#retiredByIdle)
      throw new BacklinkBrowserError(
        "BROWSER_SESSION_CLOSED",
        "The idle browser was closed before this action started; retry the action to relaunch it",
      );
    if (this.#disposed || this.#closing)
      throw new BacklinkBrowserError(
        "BROWSER_SESSION_CLOSED",
        "Browser runtime is closing or has been disposed",
      );
  }

  #enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    return this.#queues.run(key, task);
  }

  #startSweeper(session: BacklinkBrowserSession): void {
    this.#stopSweeper();
    const timer = setInterval(() => {
      // 定时器回调中的拒绝没有调用方处理，未捕获会终止 MCP 进程。
      void this.#sweep(session).catch((cause: unknown) =>
        process.stderr.write(
          `[backlinks-browser] idle sweep failed: ${cause instanceof Error ? cause.message.split("\n")[0] : "unknown error"}\n`,
        ),
      );
    }, this.#options.sweepIntervalMs ?? SWEEP_INTERVAL_MS);
    timer.unref?.();
    this.#sweeper = timer;
  }

  #stopSweeper(): void {
    if (this.#sweeper) clearInterval(this.#sweeper);
    this.#sweeper = undefined;
  }

  /** 空闲清扫：跳过正在执行动作的页面；整个浏览器空闲时关闭（profile 登录态保留）。 */
  async sweepNow(): Promise<void> {
    if (this.#session) await this.#sweep(this.#session);
  }

  async #sweep(session: BacklinkBrowserSession): Promise<void> {
    if (session !== this.#session || session.closed || this.#disposed || this.#closing) return;
    const plan = session.sweepPlan(this.#now());
    await Promise.allSettled(
      plan.recycle
        .filter((name) => !this.#queues.has(name))
        .map((name) => this.#enqueue(name, () => session.recycle(name))),
    );
    if (!plan.browserIdle || this.#queues.size > 0 || session !== this.#session) return;
    if (this.#options.onIdleClose) {
      // 空闲关闭即结束本运行时，宿主按最新设置重建；显示方式等浏览器设置变更由此生效。
      this.#retiredByIdle = true;
      this.#disposed = true;
      const closed = this.closeSession();
      this.#options.onIdleClose(closed.catch(() => undefined));
      await closed;
      return;
    }
    this.#idleClosing = true;
    try {
      await this.closeSession();
    } finally {
      this.#idleClosing = false;
    }
  }

  private async ensureSession(): Promise<BacklinkBrowserSession> {
    if (this.#session && !this.#session.closed) return this.#session;
    if (this.#session) {
      // 上一个会话缓存的关闭失败不能阻止重新启动。
      const stale = this.#session;
      this.#session = undefined;
      await stale.close().catch(() => undefined);
    }
    this.#launch ??= this.launch().finally(() => {
      this.#launch = undefined;
    });
    return await this.#launch;
  }

  private async launch(): Promise<BacklinkBrowserSession> {
    // 复用真实目录，不能因路径别名绕过独占锁；缺失目录不能静默建成空白账号。
    let profilePath = this.#options.profilePath;
    if (this.#options.userDataDir) {
      try {
        profilePath = await realpath(this.#options.userDataDir);
      } catch {
        throw new BacklinkBrowserError(
          "BROWSER_PROFILE_ERROR",
          "The selected existing browser profile cannot be found",
        );
      }
    }
    const release = await acquireBrowserProfile(profilePath);
    let revealing = () => false;
    let foreign: (page: Page) => boolean = () => false;
    const presenter = createBrowserPresenter({
      mode: this.#displayMode,
      attached: Boolean(this.#options.cdpEndpoint),
      profilePath,
      ...(this.#options.focusControl !== undefined ? { focus: this.#options.focusControl } : {}),
      isRevealing: () => revealing(),
      isForeign: (page) => foreign(page),
      warn: (message) => process.stderr.write(`[backlinks-browser] ${message}\n`),
    });
    const sessionOptions = {
      timeoutMs: this.#timeoutMs,
      workspacePath: this.#options.workspacePath,
      releaseProfile: release,
      presenter,
      now: this.#now,
    };
    try {
      const chromium = this.#options.loadChromium
        ? await this.#options.loadChromium()
        : (await import("playwright-core")).chromium;
      if (this.#options.cdpEndpoint) {
        if (!chromium.connectOverCDP) throw new Error("CDP unavailable");
        const connection = await chromium.connectOverCDP(this.#options.cdpEndpoint, {
          timeout: this.#timeoutMs,
        });
        const context = connection.contexts()[0];
        if (!context) {
          await connection.close();
          throw new Error("No default context");
        }
        const session = new BacklinkBrowserSession({
          ...sessionOptions,
          context,
          disconnect: () => connection.close(),
        });
        revealing = () => session.revealedCount > 0;
        foreign = (page) => !session.owns(page);
        this.#session = session;
        this.#startSweeper(session);
        return session;
      }
      const channel = this.#options.channel ?? "chrome";
      const browserContext = await chromium.launchPersistentContext(profilePath, {
        headless: this.#displayMode === "headless",
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
      const session = new BacklinkBrowserSession({ ...sessionOptions, context: browserContext });
      revealing = () => session.revealedCount > 0;
      foreign = (page) => !session.owns(page);
      // 启动会抢占前台：后台模式下立即停靠窗口并归还前台；失败只记录，不阻塞发布。
      await presenter.afterLaunch(browserContext).catch(() => undefined);
      this.#session = session;
      this.#startSweeper(session);
      return session;
    } catch (cause) {
      await release();
      if (cause instanceof BacklinkBrowserError) throw cause;
      throw new BacklinkBrowserError(
        "BROWSER_LAUNCH_FAILED",
        this.#options.cdpEndpoint
          ? "Unable to attach to CDP. Verify the existing browser's local debugging address; no new browser was launched"
          : "Unable to launch the persistent browser. Verify Chrome and the selected profile; if already open, connect via CDP or close its owning runtime first. Never delete its lock",
        { cause },
      );
    }
  }

  private async closeSession(): Promise<void> {
    this.#stopSweeper();
    this.#closing ??= (async () => {
      const session =
        this.#session ?? (this.#launch ? await this.#launch.catch(() => undefined) : undefined);
      // 关闭开始时仍在启动的会话可能已重新启动清扫定时器。
      this.#stopSweeper();
      try {
        if (session) await session.close();
      } finally {
        if (this.#session === session) this.#session = undefined;
      }
    })().finally(() => {
      this.#closing = undefined;
    });
    await this.#closing;
  }
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
