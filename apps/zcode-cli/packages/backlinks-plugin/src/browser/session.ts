// Adapted from link-harness 2.0.0 persistent browser (MIT, Copyright 2026 DeepSeek).
// ZCode changes: explicit page registry, popup observation, workspace-bounded uploads,
// background presentation and automatic page recycling.
import { randomUUID } from "node:crypto";
import type { BrowserContext, Page } from "playwright-core";
import {
  BacklinkBrowserError,
  MAX_SCREENSHOT_BYTES,
  type BacklinkBrowserPageCommand,
  type BacklinkBrowserResult,
  type BacklinkBrowserTab,
} from "./contract.js";
import { resolveBrowserUploads } from "./filesystem.js";
import { capturePage } from "./page-capture.js";
import { BROWSER_IDLE_CLOSE_MS, PageRegistry } from "./page-registry.js";
import type { BrowserPresenter } from "./presentation.js";
import { browserLocator, parseBrowserSelector } from "./selectors.js";

const RESET_TIMEOUT_MS = 5_000;
const USER_TAB_ACTIONS = new Set(["snapshot", "screenshot", "bringToFront", "waitFor"]);

export interface BacklinkBrowserSessionOptions {
  context: BrowserContext;
  timeoutMs: number;
  workspacePath: string;
  releaseProfile: () => Promise<void>;
  /** 存在时表示通过 CDP 连接用户浏览器：只关闭自建页面，不使用空闲池。 */
  disconnect?: () => Promise<void>;
  presenter: BrowserPresenter;
  now?: () => number;
}

export interface BrowserSweepPlan {
  recycle: string[];
  browserIdle: boolean;
}

export class BacklinkBrowserSession {
  readonly #context: BrowserContext;
  readonly #timeoutMs: number;
  readonly #workspacePath: string;
  readonly #releaseProfile: () => Promise<void>;
  readonly #disconnect?: () => Promise<void>;
  readonly #presenter: BrowserPresenter;
  readonly #now: () => number;
  readonly #registry = new PageRegistry();
  readonly #owned = new Set<Page>();
  readonly #watched = new WeakSet<Page>();
  /** 正在清空回池的页面：不能被 tabs() 收养成新名字。 */
  readonly #transitioning = new WeakSet<Page>();
  #lastActivityAt: number;
  #closed = false;
  #closePromise?: Promise<void>;

  constructor(options: BacklinkBrowserSessionOptions) {
    this.#context = options.context;
    this.#timeoutMs = options.timeoutMs;
    this.#workspacePath = options.workspacePath;
    this.#releaseProfile = options.releaseProfile;
    this.#disconnect = options.disconnect;
    this.#presenter = options.presenter;
    this.#now = options.now ?? Date.now;
    this.#lastActivityAt = this.#now();
    this.#context.on("close", () => {
      this.#closed = true;
    });
    this.#context.on("page", (page: Page) => {
      void this.#onPage(page);
    });
    // 自有浏览器启动时的 about:blank 直接进入空闲池，首个条目无需新建页面。
    if (!this.#disconnect)
      for (const page of this.#context.pages()) {
        this.#owned.add(page);
        this.#watch(page);
        if (page.url() === "about:blank") this.#registry.addIdle(page);
      }
  }

  get closed(): boolean {
    return this.#closed;
  }

  get pageCount(): number {
    return this.#registry.size;
  }

  get heldCount(): number {
    return this.#registry.heldCount;
  }

  get revealedCount(): number {
    return this.#registry.revealedCount;
  }

  /** 本插件创建或由其页面打开的页面（含空闲池）。 */
  owns(page: Page): boolean {
    return this.#owned.has(page);
  }

  itemPageNames(itemId: number): string[] {
    return this.#registry.itemPages(itemId).map((record) => record.name);
  }

  hold(name: string, reason: string): void {
    this.#registry.hold(name, reason, this.#now());
  }

  async tabs(): Promise<BacklinkBrowserTab[]> {
    if (this.#closed) return [];
    this.#lastActivityAt = this.#now();
    const candidates = this.#context
      .pages()
      .filter(
        (page) =>
          !page.isClosed() && !this.#registry.isIdle(page) && !this.#transitioning.has(page),
      );
    const openers = await Promise.all(candidates.map((page) => page.opener().catch(() => null)));
    const listed: Array<{ page: Page; opener: Page | null }> = [];
    candidates.forEach((page, index) => {
      const opener = openers[index] ?? null;
      if (opener && this.#owned.has(opener)) this.#owned.add(page);
      // 非本插件创建的标签（用户自行打开或站点 noopener 新标签）照常列出供观察和操作，
      // 但属于“外来页面”：回收时只解除页名，绝不清空、回池或关闭。
      this.#adopt(page, opener ?? undefined);
      listed.push({ page, opener });
    });
    const tabs = await Promise.all(
      listed.map(async ({ page, opener }) => {
        // 等待期间页面可能已被回收或关闭，只返回仍有记录的页面。
        const record = this.#registry.recordFor(page);
        if (!record || page.isClosed()) return undefined;
        const openerPage = opener ? this.#registry.recordFor(opener)?.name : undefined;
        const title = await page.title().catch(() => "");
        return {
          page: record.name,
          url: page.url(),
          title,
          ...(openerPage ? { openerPage } : {}),
          ...(this.#disconnect ? { owned: this.#owned.has(page) } : {}),
          ...(record.itemId ? { itemId: record.itemId } : {}),
          ...(record.held ? { held: true as const, holdReason: record.held.reason } : {}),
        };
      }),
    );
    return tabs.filter((tab): tab is BacklinkBrowserTab => tab !== undefined);
  }

  async execute(command: BacklinkBrowserPageCommand): Promise<BacklinkBrowserResult> {
    if (this.#closed)
      throw new BacklinkBrowserError(
        "BROWSER_SESSION_CLOSED",
        "The browser was closed; inspect status before opening it again",
      );
    const now = this.#now();
    this.#lastActivityAt = now;
    let record = this.#registry.get(command.page);
    // 重试已保留的人工条目：旧页面随旧保留结束，新工作使用新的停靠页面（登录态在 profile 中保留）。
    if (command.action === "navigate" && record?.held) {
      await this.recycle(command.page);
      record = undefined;
    }
    if (command.action === "navigate" && !record)
      record = this.#registry.bind(command.page, await this.#acquirePage(), now);
    if (!record)
      throw new BacklinkBrowserError(
        "BROWSER_PAGE_NOT_FOUND",
        "The named browser page is not open or was released after its item result. Observe tabs or navigate with a new page reference",
      );
    const page = record.page;
    record.lastUsedAt = now;
    if (this.#disconnect && !this.#owned.has(page) && !USER_TAB_ACTIONS.has(command.action))
      throw new BacklinkBrowserError(
        "BROWSER_INVALID_INPUT",
        "This existing tab belongs to the user. Navigate with a new page reference to reuse its login safely",
      );
    switch (command.action) {
      case "navigate":
        await page.goto(command.url, {
          timeout: this.#timeoutMs,
          waitUntil: command.waitUntil ?? "domcontentloaded",
        });
        return await capturePage(page, command.page, this.#timeoutMs, command.maxChars);
      case "snapshot":
        return await capturePage(
          page,
          command.page,
          this.#timeoutMs,
          command.maxChars,
          command.format,
          command.selector,
        );
      case "click": {
        const address = parseBrowserSelector(command.selector);
        if (address.mode === "xy") await page.mouse.click(address.x, address.y);
        else await browserLocator(page, address).click({ timeout: this.#timeoutMs });
        break;
      }
      case "fill":
        await browserLocator(page, parseBrowserSelector(command.selector)).fill(command.value, {
          timeout: this.#timeoutMs,
        });
        break;
      case "select":
        await browserLocator(page, parseBrowserSelector(command.selector)).selectOption(
          command.value,
          { timeout: this.#timeoutMs },
        );
        break;
      case "press":
        await page.keyboard.press(command.key);
        break;
      case "upload": {
        const files = await resolveBrowserUploads(this.#workspacePath, command.files);
        await browserLocator(page, parseBrowserSelector(command.selector)).setInputFiles(files, {
          timeout: this.#timeoutMs,
        });
        break;
      }
      case "screenshot": {
        const png = await page.screenshot({ type: "png", timeout: this.#timeoutMs });
        if (png.byteLength > MAX_SCREENSHOT_BYTES)
          throw new BacklinkBrowserError(
            "BROWSER_ACTION_FAILED",
            "Screenshot exceeds the 10 MiB output limit",
          );
        return { kind: "screenshot", pngBase64: png.toString("base64") };
      }
      case "waitFor":
        if (command.selector)
          await browserLocator(page, parseBrowserSelector(command.selector)).waitFor({
            state: "visible",
            timeout: command.timeoutMs ?? this.#timeoutMs,
          });
        else await page.waitForURL(command.url!, { timeout: command.timeoutMs ?? this.#timeoutMs });
        break;
      case "bringToFront":
        // 显示只用于用户同意的人工处理；显示期间暂停自动停靠与前台归还。
        record.revealed = true;
        try {
          await this.#presenter.reveal(page);
        } catch (cause) {
          record.revealed = false;
          throw cause;
        }
        break;
      case "hold":
        this.#registry.hold(command.page, command.reason ?? "manual", now, true);
        break;
      case "closePage":
        await this.recycle(command.page);
        break;
    }
    return { kind: "acked" };
  }

  /**
   * 解除逻辑页名：自有浏览器中页面清空后回到空闲池（池满或是弹窗则关闭）；
   * CDP 模式关闭自建页面，用户原有标签只解除引用。
   */
  async recycle(name: string): Promise<void> {
    const record = this.#registry.release(name);
    if (!record) return;
    const page = record.page;
    try {
      // 外来页面（用户标签）只解除页名，绝不清空、回池或关闭。
      if (page.isClosed() || !this.#owned.has(page)) return;
      this.#transitioning.add(page);
      try {
        // 显示过的页面位于用户可见的窗口中，不能回池给后续自动化复用。
        const reusable =
          !this.#disconnect && !record.openerName && !record.revealed && (await this.#reset(page));
        if (!reusable || !this.#registry.addIdle(page))
          await page.close({ runBeforeUnload: false }).catch(() => undefined);
      } finally {
        this.#transitioning.delete(page);
      }
    } finally {
      // 任何释放显示页的路径（包括外来页面提前返回）都要在最后一个显示页结束后重新停靠。
      if (record.revealed && this.#registry.revealedCount === 0 && !this.#closed)
        await this.#presenter.conceal(this.#context).catch(() => undefined);
    }
  }

  /** 没有逻辑页；自有浏览器中也没有外来标签（关闭整个浏览器不会丢失任何用户页面）。 */
  get vacant(): boolean {
    return (
      this.#registry.size === 0 &&
      (Boolean(this.#disconnect) ||
        this.#context.pages().every((page) => page.isClosed() || this.#owned.has(page)))
    );
  }

  sweepPlan(now: number): BrowserSweepPlan {
    const { idle, expiredHolds } = this.#registry.expired(now);
    return {
      recycle: [...idle, ...expiredHolds],
      // 自有浏览器仍有外来标签（用户在插件 Chrome 中打开的页面）时不关闭；CDP 空闲只断开连接。
      browserIdle: this.vacant && now - this.#lastActivityAt >= BROWSER_IDLE_CLOSE_MS,
    };
  }

  async close(): Promise<void> {
    this.#closePromise ??= (async () => {
      try {
        // 外部默认 context 承载用户登录态；CDP close 仅断开此连接，不关闭浏览器。
        if (this.#disconnect) {
          if (!this.#closed) await this.tabs().catch(() => undefined);
          await Promise.allSettled(
            [...this.#owned].filter((page) => !page.isClosed()).map((page) => page.close()),
          );
          await this.#disconnect();
        } else if (!this.#closed) await this.#context.close();
      } finally {
        this.#closed = true;
        this.#registry.clear();
        this.#owned.clear();
        await this.#releaseProfile();
      }
    })();
    await this.#closePromise;
  }

  async #acquirePage(): Promise<Page> {
    await this.#presenter.beforeAcquire().catch(() => undefined);
    // 显示中的窗口里可能留有空闲池页面；这些页面对用户可见，关闭而不复用。
    for (let idle = this.#disconnect ? undefined : this.#registry.takeIdle(); idle; ) {
      if (await this.#presenter.isReusable(idle).catch(() => false)) return idle;
      await idle.close({ runBeforeUnload: false }).catch(() => undefined);
      idle = this.#registry.takeIdle();
    }
    const page = await this.#presenter.createPage(this.#context);
    this.#owned.add(page);
    this.#watch(page);
    return page;
  }

  async #reset(page: Page): Promise<boolean> {
    try {
      await page.goto("about:blank", { timeout: RESET_TIMEOUT_MS });
      return true;
    } catch {
      return false;
    }
  }

  async #onPage(page: Page): Promise<void> {
    this.#watch(page);
    const opener = await page.opener().catch(() => null);
    // 没有 opener 的页面是本实例创建的页面或独立新标签，在 tabs() 中按需收养。
    if (!opener || page.isClosed()) return;
    if (this.#owned.has(opener)) this.#owned.add(page);
    this.#adopt(page, opener);
    if (!this.#owned.has(page)) return;
    const openerRecord = this.#registry.recordFor(opener);
    const userDriven = openerRecord ? this.#registry.lineage(openerRecord).revealed : false;
    // 用户操作产生的弹窗本身计为显示页：打开它的页面关闭后，它仍不被停靠或按 10 分钟空闲回收。
    const record = this.#registry.recordFor(page);
    if (userDriven && record) record.revealed = true;
    await this.#presenter.onPopup(page, { userDriven }).catch(() => undefined);
  }

  #adopt(page: Page, opener?: Page): void {
    if (
      page.isClosed() ||
      this.#registry.recordFor(page) ||
      this.#registry.isIdle(page) ||
      this.#transitioning.has(page)
    )
      return;
    let name = `tab-${randomUUID()}`;
    while (this.#registry.get(name)) name = `tab-${randomUUID()}`;
    this.#registry.bind(name, page, this.#now(), opener && this.#registry.recordFor(opener)?.name);
  }

  #watch(page: Page): void {
    if (this.#watched.has(page)) return;
    this.#watched.add(page);
    page.on("close", () => {
      const revealed = this.#registry.recordFor(page)?.revealed;
      this.#registry.forget(page);
      if (revealed && this.#registry.revealedCount === 0 && !this.#closed)
        void this.#presenter.conceal(this.#context).catch(() => undefined);
    });
  }
}
