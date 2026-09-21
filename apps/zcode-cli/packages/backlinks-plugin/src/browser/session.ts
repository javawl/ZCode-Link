// Adapted from link-harness 2.0.0 persistent browser (MIT, Copyright 2026 DeepSeek).
// ZCode changes: explicit page registry, popup observation and workspace-bounded uploads.
import { randomUUID } from "node:crypto";
import type { BrowserContext, Page } from "playwright-core";
import {
  BacklinkBrowserError,
  DEFAULT_SNAPSHOT_MAX_CHARS,
  MAX_SCREENSHOT_BYTES,
  type BacklinkBrowserPageCommand,
  type BacklinkBrowserResult,
  type BacklinkBrowserTab,
} from "./contract.js";
import { resolveBrowserUploads } from "./filesystem.js";
import { browserLocator, parseBrowserSelector } from "./selectors.js";

export class BacklinkBrowserSession {
  readonly #context: BrowserContext;
  readonly #timeoutMs: number;
  readonly #workspacePath: string;
  readonly #releaseProfile: () => Promise<void>;
  readonly #pages = new Map<string, Page>();
  readonly #references = new WeakMap<Page, string>();
  #closed = false;
  #closePromise?: Promise<void>;

  constructor(
    context: BrowserContext,
    timeoutMs: number,
    workspacePath: string,
    releaseProfile: () => Promise<void>,
  ) {
    this.#context = context;
    this.#timeoutMs = timeoutMs;
    this.#workspacePath = workspacePath;
    this.#releaseProfile = releaseProfile;
    context.on("close", () => {
      this.#closed = true;
    });
  }

  get closed(): boolean {
    return this.#closed;
  }

  async tabs(): Promise<BacklinkBrowserTab[]> {
    if (this.#closed) return [];
    const pages = this.#context.pages().filter((page) => !page.isClosed());
    for (const page of pages) this.adopt(page);
    return await Promise.all(
      pages.map(async (page) => {
        const opener = await page.opener();
        const openerPage = opener ? this.#references.get(opener) : undefined;
        return {
          page: this.#references.get(page)!,
          url: page.url(),
          title: await page.title(),
          ...(openerPage ? { openerPage } : {}),
        };
      }),
    );
  }

  async execute(command: BacklinkBrowserPageCommand): Promise<BacklinkBrowserResult> {
    if (this.#closed)
      throw new BacklinkBrowserError(
        "BROWSER_SESSION_CLOSED",
        "The browser was closed; inspect status before opening it again",
      );
    let page = this.#pages.get(command.page);
    if (command.action === "navigate" && (!page || page.isClosed())) {
      page = await this.#context.newPage();
      this.adopt(page, command.page);
    }
    if (!page || page.isClosed())
      throw new BacklinkBrowserError(
        "BROWSER_PAGE_NOT_FOUND",
        "The named browser page is not open. Observe tabs or navigate with a new page reference",
      );
    switch (command.action) {
      case "navigate":
        await page.goto(command.url, {
          timeout: this.#timeoutMs,
          waitUntil: command.waitUntil ?? "domcontentloaded",
        });
        return await this.snapshot(page, command.page, command.maxChars);
      case "snapshot":
        return await this.snapshot(
          page,
          command.page,
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
        await page.bringToFront();
        break;
      case "closePage":
        await page.close();
        break;
    }
    return { kind: "acked" };
  }

  async close(): Promise<void> {
    this.#closePromise ??= (async () => {
      if (!this.#closed) await this.#context.close();
      this.#closed = true;
      this.#pages.clear();
      await this.#releaseProfile();
    })();
    await this.#closePromise;
  }

  private adopt(page: Page, requested?: string): string {
    const existing = this.#references.get(page);
    if (existing) return existing;
    let reference = requested ?? `tab-${randomUUID()}`;
    while (this.#pages.has(reference)) reference = `tab-${randomUUID()}`;
    this.#pages.set(reference, page);
    this.#references.set(page, reference);
    page.on("close", () => {
      if (this.#pages.get(reference) === page) this.#pages.delete(reference);
    });
    return reference;
  }

  private async snapshot(
    page: Page,
    reference: string,
    maxChars = DEFAULT_SNAPSHOT_MAX_CHARS,
    format: "text" | "aria" = "aria",
    selector = "body",
  ): Promise<BacklinkBrowserResult> {
    const locator = browserLocator(page, parseBrowserSelector(selector));
    const raw =
      format === "aria"
        ? await locator.ariaSnapshot({ timeout: this.#timeoutMs })
        : await locator.innerText({ timeout: this.#timeoutMs });
    return {
      kind: "page",
      page: reference,
      url: page.url(),
      title: await page.title(),
      text: raw.slice(0, maxChars),
      truncated: raw.length > maxChars,
    };
  }
}
