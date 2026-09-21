import type { BrowserContext, BrowserType, Locator, Page } from "playwright-core";

export function createFakeChromium() {
  const actions: Array<{ page: number; action: string; selector?: string; value?: unknown }> = [];
  const launches: Array<{ profile: string; options: unknown }> = [];
  const pages: Page[] = [];
  let contextClosed = false;
  let nextClick: (() => Promise<void>) | undefined;
  const closeListeners: Array<() => void> = [];

  const addPage = (opener?: Page) => {
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
        closed = true;
        for (const listener of listeners) listener();
      },
      on: (event: string, listener: () => void) => {
        if (event === "close") listeners.push(listener);
      },
    } as unknown as Page;
    pages.push(page);
    return page;
  };

  const context = {
    pages: () => pages.filter((page) => !page.isClosed()),
    newPage: async () => addPage(),
    on: (event: string, listener: () => void) => {
      if (event === "close") closeListeners.push(listener);
    },
    close: async () => {
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
    chromium,
    context,
    isClosed: () => contextClosed,
    launches,
    pages,
    setNextClick: (callback: () => Promise<void>) => {
      nextClick = callback;
    },
  };
}
