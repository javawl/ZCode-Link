import type { BrowserContext, BrowserType, Locator, Page } from "playwright-core";

export function createFakeChromium() {
  const actions: Array<{ page: number; action: string; selector?: string; value?: unknown }> = [];
  const launches: Array<{ profile: string; options: unknown }> = [];
  const pages: Page[] = [];
  let contextClosed = false;
  let nextClick: (() => Promise<void>) | undefined;
  const closeListeners: Array<() => void> = [];
  const pageListeners: Array<(page: Page) => void> = [];
  // 每个页面一个“窗口”；后台标签共享第一个窗口，便于断言停靠与显示。
  const windowOf = new Map<Page, number>();
  const windowStates = new Map<number, string>();
  const cdpCalls: Array<{ method: string; params?: unknown }> = [];
  // 可注入的时序控制：用于复现并发竞态、关闭失败与窗口归属。
  const hooks: {
    beforeGoto?: (url: string) => Promise<void>;
    beforeCdpSession?: () => Promise<void>;
    closeContext?: () => Promise<void>;
    /** Chrome 放置后台标签的“最近活动窗口”；缺省为第一个打开页面的窗口。 */
    activeWindow?: number;
  } = {};
  let nextWindowId = 500;

  const addPage = (opener?: Page, windowId?: number) => {
    const pageIndex = pages.length;
    let url = "about:blank";
    let closed = false;
    const listeners: Array<() => void> = [];
    const locator = (selector: string): Locator => {
      const result = {
        locator: (value: string) => locator(`${selector} >> ${value}`),
        frameLocator: (value: string) => locator(`${selector} >> frame(${value})`),
        getByRole: (role: string, options?: { name?: string }) =>
          locator(`${selector} >> role:${role}|${options?.name ?? ""}`),
        getByLabel: (value: string) => locator(`${selector} >> label:${value}`),
        getByText: (value: string) => locator(`${selector} >> text:${value}`),
        getByPlaceholder: (value: string) => locator(`${selector} >> placeholder:${value}`),
        click: async () => {
          actions.push({ page: pageIndex, action: "click", selector });
          const pending = nextClick;
          nextClick = undefined;
          await pending?.();
        },
        fill: async (value: string) => {
          actions.push({ page: pageIndex, action: "fill", selector, value });
        },
        selectOption: async (value: string) => {
          actions.push({ page: pageIndex, action: "select", selector, value });
        },
        setInputFiles: async (value: string[]) => {
          actions.push({ page: pageIndex, action: "upload", selector, value });
        },
        waitFor: async () => {
          actions.push({ page: pageIndex, action: "waitFor", selector });
        },
        ariaSnapshot: async () => '- link "Example":\n  - /url: https://example.test/',
        innerText: async () => "A fixture page with a genuine target link",
      };
      return result as unknown as Locator;
    };
    const root = locator("page");
    const page = {
      ...root,
      locator: (value: string) => locator(value),
      goto: async (value: string) => {
        await hooks.beforeGoto?.(value);
        url = value;
        actions.push({ page: pageIndex, action: "navigate", value });
      },
      url: () => url,
      title: async () => `Fixture ${pageIndex}`,
      isClosed: () => closed,
      opener: async () => opener ?? null,
      bringToFront: async () => {
        actions.push({ page: pageIndex, action: "bringToFront" });
      },
      waitForURL: async (value: string) => {
        actions.push({ page: pageIndex, action: "waitForURL", value });
      },
      screenshot: async () => Buffer.from("fixture-png"),
      keyboard: {
        press: async (value: string) => {
          actions.push({ page: pageIndex, action: "press", value });
        },
      },
      mouse: {
        click: async (x: number, y: number) => {
          actions.push({ page: pageIndex, action: "xy", value: [x, y] });
        },
      },
      close: async () => {
        if (closed) return;
        closed = true;
        actions.push({ page: pageIndex, action: "close" });
        for (const listener of listeners) listener();
      },
      on: (event: string, listener: () => void) => {
        if (event === "close") listeners.push(listener);
      },
      context: () => context,
    } as unknown as Page;
    pages.push(page);
    windowOf.set(page, windowId ?? 100 + pageIndex);
    if (!windowStates.has(windowOf.get(page)!)) windowStates.set(windowOf.get(page)!, "shown");
    for (const listener of pageListeners) listener(page);
    return page;
  };

  const sessionFor = (page?: Page) => ({
    send: async (method: string, params?: Record<string, unknown>) => {
      cdpCalls.push({ method, ...(params ? { params } : {}) });
      if (method === "Target.getTargetInfo")
        return { targetInfo: { targetId: `target-${pages.indexOf(page!)}` } };
      if (method === "Browser.getWindowForTarget") return { windowId: windowOf.get(page!) };
      if (method === "Browser.setWindowBounds") {
        const bounds = params?.bounds as { windowState?: string; left?: number } | undefined;
        const id = params!.windowId as number;
        if (bounds?.windowState && bounds.windowState !== "normal")
          windowStates.set(id, bounds.windowState);
        // 与真实 Chrome 一致：越界坐标即“停靠”，可见区域坐标即“显示”。
        if (bounds?.left !== undefined)
          windowStates.set(id, bounds.left <= -10_000 ? "parked" : "shown");
        return {};
      }
      if (method === "Target.createTarget") {
        if (params?.newWindow) {
          const created = addPage(undefined, nextWindowId++);
          return { targetId: `target-${pages.indexOf(created)}` };
        }
        // 真实 Chrome：后台标签加入最近活动窗口，并把该窗口恢复为默认尺寸与位置。
        const target =
          hooks.activeWindow ??
          windowOf.get(pages.find((candidate) => !candidate.isClosed())!) ??
          100;
        const created = addPage(undefined, target);
        windowStates.set(target, "shown");
        return { targetId: `target-${pages.indexOf(created)}` };
      }
      if (method === "Target.closeTarget") {
        const index = Number(String(params?.targetId).replace("target-", ""));
        await pages[index]?.close();
        return {};
      }
      return {};
    },
    detach: async () => {},
  });

  const context = {
    pages: () => pages.filter((page) => !page.isClosed()),
    newPage: async () => addPage(),
    newCDPSession: async (page: Page) => {
      await hooks.beforeCdpSession?.();
      return sessionFor(page);
    },
    browser: () => ({ newBrowserCDPSession: async () => sessionFor() }),
    on: (event: string, listener: (page: Page) => void) => {
      if (event === "close") closeListeners.push(listener as () => void);
      if (event === "page") pageListeners.push(listener);
    },
    close: async () => {
      await hooks.closeContext?.();
      contextClosed = true;
      for (const page of pages) await page.close();
      for (const listener of closeListeners) listener();
    },
  } as unknown as BrowserContext;
  const chromium = {
    launchPersistentContext: async (profile: string, options: unknown) => {
      contextClosed = false;
      launches.push({ profile, options });
      return context;
    },
  } as unknown as Pick<BrowserType, "launchPersistentContext">;
  return {
    actions,
    addPage,
    cdpCalls,
    chromium,
    context,
    hooks,
    isClosed: () => contextClosed,
    launches,
    pages,
    windowState: (page: Page) => windowStates.get(windowOf.get(page)!),
    setNextClick: (callback: () => Promise<void>) => {
      nextClick = callback;
    },
  };
}
