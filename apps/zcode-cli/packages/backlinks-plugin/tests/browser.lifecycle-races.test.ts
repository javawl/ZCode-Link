import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Page } from "playwright-core";
import { createBacklinkBrowserRuntime, type BacklinkBrowserOptions } from "../src/browser/index.js";
import { IDLE_PAGE_MS, PageRegistry, BROWSER_IDLE_CLOSE_MS } from "../src/browser/page-registry.js";
import type { FocusControl } from "../src/browser/presentation.js";
import { createFakeChromium } from "./browser-fixtures.js";

// 对抗式评审确认缺陷的回归测试：页面一名一页、窗口归属、空闲关闭与隐藏修复。
const request = { traceId: "trace-races", sessionId: "session-races" };
const navigate = (page: string) => ({
  action: "navigate" as const,
  page,
  url: `https://site.test/${page}`,
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

async function fixture(overrides: Partial<BacklinkBrowserOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), "zcode-backlinks-races-"));
  const workspacePath = join(root, "workspace");
  await mkdir(workspacePath);
  const fake = createFakeChromium();
  let now = 1_000_000;
  const focusCalls: string[] = [];
  const focus: FocusControl = {
    findBrowserPid: async () => 4242,
    yieldIfFront: async () => false,
    ensureUnhidden: async (pid) => {
      focusCalls.push(`unhide:${pid}`);
    },
  };
  const runtime = createBacklinkBrowserRuntime({
    profilePath: join(root, "profile"),
    workspacePath,
    focusControl: focus,
    now: () => now,
    sweepIntervalMs: 3_600_000,
    loadChromium: async () => fake.chromium,
    ...overrides,
  });
  const run = async (command: Parameters<typeof runtime.execute>[0]) =>
    await runtime.execute(command, request);
  const tabs = async () => {
    const result = await run({ action: "tabs" });
    if (result.kind !== "tabs") assert.fail("expected tabs");
    return result.tabs;
  };
  const status = async () => {
    const result = await run({ action: "status" });
    if (result.kind !== "status") assert.fail("expected status");
    return result;
  };
  return {
    fake,
    runtime,
    run,
    tabs,
    status,
    focusCalls,
    sweep: () => (runtime as unknown as { sweepNow(): Promise<void> }).sweepNow(),
    advance: (ms: number) => {
      now += ms;
    },
    cleanup: async () => {
      await runtime.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("a page has one name and a pooled page never keeps a live name", () => {
  const registry = new PageRegistry();
  const page = { isClosed: () => false } as unknown as Page;
  registry.bind("tab-adopted", page, 1);
  registry.bind("batch-1-item-2", page, 2);
  assert.deepEqual(registry.names(), ["batch-1-item-2"], "the explicit name replaces the alias");
  assert.equal(registry.addIdle(page), false, "a named page cannot enter the pool");
  registry.release("batch-1-item-2");
  assert.equal(registry.addIdle(page), true);
  assert.equal(registry.takeIdle(), page);
});

test("tabs during a recycle reset cannot alias the page and a sweep never wipes a live item", async () => {
  const f = await fixture({ displayMode: "visible" });
  try {
    await f.run(navigate("batch-1-item-1"));
    const page = f.fake.pages[0]!;
    const reset = deferred();
    f.fake.hooks.beforeGoto = async (url) => {
      if (url === "about:blank") await reset.promise;
    };
    const release = f.runtime.releaseItemPages(1, "recycle");
    await tick();
    assert.deepEqual(await f.tabs(), [], "a page being reset is not adopted");
    reset.resolve();
    await release;
    f.fake.hooks.beforeGoto = undefined;
    await f.run(navigate("batch-1-item-2"));
    assert.equal(f.fake.pages.length, 1, "item-2 reuses the pooled page");
    assert.equal((await f.status()).pages, 1, "no stale alias record");
    f.advance(IDLE_PAGE_MS / 2);
    await f.run({ action: "snapshot", page: "batch-1-item-2" });
    f.advance(IDLE_PAGE_MS / 2 + 1);
    await f.sweep();
    assert.equal(page.url(), "https://site.test/batch-1-item-2", "item-2 was not reset under it");
    await f.run(navigate("batch-1-item-3"));
    assert.equal(f.fake.pages.length, 2, "item-3 gets its own physical page");
  } finally {
    await f.cleanup();
  }
});

test("tabs while a background tab is being created cannot leave a second name", async () => {
  const f = await fixture({ displayMode: "background" });
  try {
    f.fake.addPage();
    await f.run(navigate("batch-2-item-1"));
    const gate = deferred();
    let gated = false;
    f.fake.hooks.beforeCdpSession = async () => {
      if (!gated) {
        gated = true;
        await gate.promise;
      }
    };
    const creating = f.run(navigate("batch-2-item-2"));
    await tick();
    await f.tabs();
    gate.resolve();
    await creating;
    f.fake.hooks.beforeCdpSession = undefined;
    const names = (await f.tabs()).map((tab) => tab.page).sort();
    assert.deepEqual(names, ["batch-2-item-1", "batch-2-item-2"]);
    assert.equal((await f.status()).pages, 2);
  } finally {
    await f.cleanup();
  }
});

test("idle-close failures never escape the sweep timer and the runtime relaunches", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  const f = await fixture({ displayMode: "visible", sweepIntervalMs: 5 });
  try {
    await f.run(navigate("batch-3-item-1"));
    await f.runtime.releaseItemPages(1, "recycle");
    let failures = 0;
    f.fake.hooks.closeContext = async () => {
      failures += 1;
      f.fake.hooks.closeContext = undefined;
      throw new Error("context close failed");
    };
    f.advance(BROWSER_IDLE_CLOSE_MS + 1);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(failures, 1);
    assert.deepEqual(unhandled, [], "the failed idle close is caught");
    await f.run(navigate("batch-3-item-2"));
    assert.equal(f.fake.launches.length, 2, "a later action relaunches despite the failed close");
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await f.cleanup();
  }
});

test("an action arriving during an internal idle close waits and relaunches", async () => {
  const f = await fixture({ displayMode: "visible" });
  try {
    await f.run(navigate("batch-4-item-1"));
    await f.runtime.releaseItemPages(1, "recycle");
    const closing = deferred();
    f.fake.hooks.closeContext = async () => {
      await closing.promise;
    };
    f.advance(BROWSER_IDLE_CLOSE_MS + 1);
    const sweep = f.sweep();
    await tick();
    const next = f.run(navigate("batch-4-item-2"));
    await tick();
    f.fake.hooks.closeContext = undefined;
    closing.resolve();
    await sweep;
    const result = await next;
    assert.equal(result.kind, "page");
    assert.equal(f.fake.launches.length, 2);
  } finally {
    await f.cleanup();
  }
});

test("with a host callback an idle close retires the runtime so new settings apply", async () => {
  let closed: Promise<void> | undefined;
  const f = await fixture({
    displayMode: "visible",
    onIdleClose: (promise) => {
      closed = promise;
    },
  });
  try {
    await f.run(navigate("batch-5-item-1"));
    await f.runtime.releaseItemPages(1, "recycle");
    f.advance(BROWSER_IDLE_CLOSE_MS + 1);
    await f.sweep();
    assert.ok(closed, "the host is told to rebuild");
    await closed;
    await assert.rejects(f.run(navigate("batch-5-item-2")), (error: Error & { code?: string }) => {
      assert.equal(error.code, "BROWSER_SESSION_CLOSED");
      assert.match(error.message, /retry the action/u);
      return true;
    });
    assert.equal(f.fake.launches.length, 1, "a retired runtime never relaunches with old settings");
  } finally {
    await f.cleanup();
  }
});

test("popups of a held item are kept with it and a retry starts on a fresh page", async () => {
  const f = await fixture({ displayMode: "visible" });
  try {
    await f.run(navigate("batch-6-item-1"));
    const main = f.fake.pages[0]!;
    await f.runtime.releaseItemPages(1, "hold");
    const popup = f.fake.addPage(main);
    await tick();
    f.advance(IDLE_PAGE_MS * 2);
    await f.sweep();
    assert.equal(popup.isClosed(), false, "a popup opened on a held page follows the hold");
    await f.run({ action: "bringToFront", page: "batch-6-item-1" });
    await f.run(navigate("batch-6-item-1"));
    assert.notEqual(f.fake.pages.at(-1), main, "the retry gets a fresh page");
    assert.equal(main.isClosed(), true, "a revealed page is closed, never pooled");
    const retried = (await f.tabs()).find((tab) => tab.page === "batch-6-item-1");
    assert.equal(retried?.held, undefined, "the old hold ended with the old page");
  } finally {
    await f.cleanup();
  }
});

test("background mode never parks or reuses a window the user opened or is handling", async () => {
  const f = await fixture({ displayMode: "background" });
  try {
    f.fake.addPage(); // 启动窗口（窗口 100）
    await f.run(navigate("batch-7-item-1"));
    const userPage = f.fake.addPage(undefined, 777); // 用户在插件 Chrome 中打开的窗口
    await userPage.goto("https://user.example/inbox");
    f.fake.hooks.activeWindow = 777;
    await f.run(navigate("batch-7-item-2"));
    const automation = f.fake.pages.at(-1)!;
    assert.equal(f.fake.windowState(userPage), "shown", "the user's window was not parked");
    assert.equal(f.fake.windowState(automation), "parked");
    assert.notEqual(automation, userPage);
    const foreign = (await f.tabs()).find((tab) => tab.url === userPage.url() && !tab.itemId);
    assert.ok(foreign, "foreign tabs stay observable");
    f.advance(IDLE_PAGE_MS + 1);
    await f.sweep();
    assert.equal(userPage.isClosed(), false, "foreign pages are never closed");
    assert.equal(userPage.url(), "https://user.example/inbox", "foreign pages are never reset");
    f.advance(BROWSER_IDLE_CLOSE_MS);
    await f.runtime.releaseItemPages(1, "recycle");
    await f.runtime.releaseItemPages(2, "recycle");
    await f.sweep();
    assert.equal(f.fake.isClosed(), false, "an open user tab keeps the browser alive");

    // 显示中的人工页面：新的自动化标签进入另一个停靠窗口，自动化弹窗被停靠，用户操作产生的弹窗保持原样。
    f.fake.hooks.activeWindow = undefined;
    await f.run(navigate("batch-7-item-3"));
    await f.runtime.releaseItemPages(3, "hold");
    const held = f.fake.pages.find((page) => page.url() === "https://site.test/batch-7-item-3")!;
    await f.run({ action: "bringToFront", page: "batch-7-item-3" });
    const revealedWindowState = f.fake.windowState(held);
    assert.equal(revealedWindowState, "shown");
    f.fake.hooks.activeWindow = 100;
    await f.run(navigate("batch-8-item-1"));
    const next = f.fake.pages.at(-1)!;
    assert.equal(f.fake.windowState(held), "shown", "the page being handled stays visible");
    assert.equal(f.fake.windowState(next), "parked", "new automation goes to a parked window");
    const userDriven = f.fake.addPage(held, 901);
    const automationPopup = f.fake.addPage(next, 902);
    await tick();
    assert.equal(f.fake.windowState(userDriven), "shown", "user-driven popups stay put");
    assert.equal(f.fake.windowState(automationPopup), "parked", "automation popups are parked");
    assert.ok(f.focusCalls.includes("unhide:4242"), "a hidden plugin Chrome is repaired");
  } finally {
    await f.cleanup();
  }
});

test("visible mode never parks windows, creates background targets or moves focus", async () => {
  const f = await fixture({ displayMode: "visible" });
  try {
    f.fake.addPage();
    await f.run(navigate("batch-9-item-1"));
    await f.run(navigate("batch-9-item-2"));
    const page = f.fake.pages.at(-1)!;
    const popup = f.fake.addPage(page, 902);
    await tick();
    assert.equal((f.fake.launches[0]!.options as { headless: boolean }).headless, false);
    assert.equal(
      f.fake.cdpCalls.some(
        (call) =>
          call.method === "Browser.setWindowBounds" || call.method === "Target.createTarget",
      ),
      false,
    );
    assert.equal(f.fake.windowState(page), "shown");
    assert.equal(f.fake.windowState(popup), "shown");
    assert.deepEqual(f.focusCalls, []);
  } finally {
    await f.cleanup();
  }
});

test("pooled pages in a revealed window are never reused and user popups outlive their opener", async () => {
  const f = await fixture({ displayMode: "background" });
  try {
    f.fake.addPage(); // 启动页（窗口 100，自有）
    await f.run(navigate("batch-10-item-1"));
    await f.run(navigate("batch-10-item-2"));
    const second = f.fake.pages.at(-1)!;
    await f.runtime.releaseItemPages(1, "recycle"); // 启动页回池，位于窗口 100
    await f.runtime.releaseItemPages(2, "hold");
    // 让保留页与空闲池页面同处一个窗口后显示它。
    f.fake.hooks.activeWindow = undefined;
    const pooled = f.fake.pages[0]!;
    await f.run({ action: "bringToFront", page: "batch-10-item-2" });
    const revealedState = f.fake.windowState(second);
    assert.equal(revealedState, "shown");
    await f.run(navigate("batch-11-item-1"));
    const next = f.fake.pages.find((page) => page.url() === "https://site.test/batch-11-item-1")!;
    assert.equal(
      f.fake.windowState(pooled),
      "shown",
      "setup: the pooled page shares the revealed window",
    );
    assert.notEqual(next, pooled, "a pooled page in the revealed window is not reused");
    assert.equal(f.fake.windowState(next), "parked", "new automation runs parked");

    // 用户在显示页上打开的弹窗：打开者关闭后仍保持原样，并按显示页规则保留。
    const userPopup = f.fake.addPage(second, 950);
    await tick();
    await second.close();
    await tick();
    assert.equal(f.fake.windowState(userPopup), "shown", "not parked after its opener closed");
    f.advance(IDLE_PAGE_MS + 1);
    await f.sweep();
    assert.equal(userPopup.isClosed(), false, "not closed by the 10-minute rule");
  } finally {
    await f.cleanup();
  }
});

test("a window holding the user's own tab is never re-parked and a revealed foreign tab still conceals", async () => {
  const f = await fixture({ displayMode: "background" });
  try {
    f.fake.addPage(); // 启动页（窗口 100）
    await f.run(navigate("batch-12-item-1"));
    const itemPage = f.fake.pages[0]!;
    await f.runtime.releaseItemPages(1, "hold");
    await f.run({ action: "bringToFront", page: "batch-12-item-1" });
    const userTab = f.fake.addPage(undefined, 100); // 用户在显示中的窗口里按 Cmd+T
    await userTab.goto("https://user.example/notes");
    await f.run(navigate("batch-12-item-1")); // 重试：结束旧保留，最后一个显示页离开
    assert.equal(itemPage.isClosed(), true);
    assert.equal(f.fake.windowState(userTab), "shown", "the user's window is not parked");
    await f.run(navigate("batch-12-item-2"));
    const next = f.fake.pages.find((page) => page.url() === "https://site.test/batch-12-item-2")!;
    assert.equal(f.fake.windowState(next), "parked");
    assert.notEqual(f.fake.windowState(next), f.fake.windowState(userTab));

    // 显示后回收一个外来标签：同样触发重新停靠。
    const foreignTab = (await f.tabs()).find((tab) => tab.url === "https://user.example/notes")!;
    await f.run({ action: "bringToFront", page: foreignTab.page });
    await f.run({ action: "closePage", page: foreignTab.page });
    assert.equal((await f.status()).pages, 2, "only the two item pages remain named");
    assert.equal(userTab.isClosed(), false, "foreign pages are never closed");
    const pageCount = f.fake.pages.length;
    await f.run(navigate("batch-12-item-3"));
    assert.equal(
      f.fake.pages.length,
      pageCount + 1,
      "exactly one new page, no throwaway tab in the user window",
    );
  } finally {
    await f.cleanup();
  }
});

test("a page that closes while tabs awaits its opener leaves no phantom record", async () => {
  const f = await fixture({ displayMode: "visible" });
  try {
    await f.run(navigate("batch-13-item-1"));
    const main = f.fake.pages[0]!;
    const popup = f.fake.addPage(main);
    await tick();
    await f.runtime.releaseItemPages(1, "recycle");
    assert.equal(popup.isClosed(), true);
    const stray = f.fake.addPage(); // 用户标签，在 tabs() 等待期间关闭
    const originalOpener = stray.opener.bind(stray);
    (stray as unknown as { opener: () => Promise<unknown> }).opener = async () => {
      await stray.close();
      return originalOpener();
    };
    await f.tabs();
    assert.equal((await f.status()).pages, 0, "the closed page was not adopted");
    assert.equal(f.runtime.isIdle(), true);
  } finally {
    await f.cleanup();
  }
});
