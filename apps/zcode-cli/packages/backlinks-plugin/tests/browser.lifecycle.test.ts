import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBacklinkBrowserRuntime, type BacklinkBrowserOptions } from "../src/browser/index.js";
import {
  BROWSER_IDLE_CLOSE_MS,
  HELD_PAGE_TTL_MS,
  IDLE_PAGE_MS,
  MAX_IDLE_POOL,
} from "../src/browser/page-registry.js";
import type { FocusControl } from "../src/browser/presentation.js";
import { createFakeChromium } from "./browser-fixtures.js";

const request = { traceId: "trace-fixture", sessionId: "session-fixture" };
const navigate = (page: string) => ({
  action: "navigate" as const,
  page,
  url: `https://site.test/${page}`,
});

async function fixture(overrides: Partial<BacklinkBrowserOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), "zcode-backlinks-lifecycle-"));
  const workspacePath = join(root, "workspace");
  await mkdir(workspacePath);
  const fake = createFakeChromium();
  let now = 1_000_000;
  const focusCalls: string[] = [];
  const focus: FocusControl = {
    findBrowserPid: async () => 4242,
    yieldIfFront: async (pid) => {
      focusCalls.push(`yield:${pid}`);
      return false;
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
  const sweep = () => (runtime as unknown as { sweepNow(): Promise<void> }).sweepNow();
  const tabs = async () => {
    const result = await runtime.execute({ action: "tabs" }, request);
    if (result.kind !== "tabs") assert.fail("expected tabs");
    return result.tabs;
  };
  return {
    root,
    fake,
    runtime,
    focusCalls,
    sweep,
    tabs,
    advance: (ms: number) => {
      now += ms;
    },
    cleanup: async () => {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("a finished item's page is recycled into the pool and reused by the next item", async () => {
  const f = await fixture({ displayMode: "visible" });
  try {
    await f.runtime.execute(navigate("batch-7-item-11"), request);
    const first = f.fake.pages[0]!;
    assert.deepEqual(
      (await f.tabs()).map((tab) => [tab.page, tab.itemId]),
      [["batch-7-item-11", 11]],
    );
    await f.runtime.releaseItemPages(11, "recycle");
    assert.deepEqual(await f.tabs(), [], "a pooled blank page is not a publishing tab");
    assert.equal(first.url(), "about:blank");
    await assert.rejects(
      f.runtime.execute({ action: "snapshot", page: "batch-7-item-11" }, request),
      { code: "BROWSER_PAGE_NOT_FOUND" },
    );
    await f.runtime.execute(navigate("batch-7-item-12"), request);
    assert.equal(f.fake.pages.length, 1, "the next item reuses the pooled page");
    assert.equal(first.url(), "https://site.test/batch-7-item-12");
  } finally {
    await f.cleanup();
  }
});

test("manual_required items keep held pages until their TTL while idle pages are recycled", async () => {
  const f = await fixture({ displayMode: "visible" });
  try {
    await f.runtime.execute(navigate("batch-7-item-21"), request);
    await f.runtime.execute(navigate("google-session"), request);
    await f.runtime.releaseItemPages(21, "hold");
    const held = (await f.tabs()).find((tab) => tab.page === "batch-7-item-21");
    assert.deepEqual(
      { held: held?.held, reason: held?.holdReason, item: held?.itemId },
      { held: true, reason: "manual_required", item: 21 },
    );
    const status = await f.runtime.execute({ action: "status" }, request);
    assert.equal(status.kind === "status" && status.heldPages, 1);
    await f.runtime.execute(
      { action: "hold", page: "batch-7-item-21", reason: "Turnstile challenge" },
      request,
    );
    await f.runtime.releaseItemPages(21, "hold");
    assert.equal(
      (await f.tabs()).find((tab) => tab.page === "batch-7-item-21")?.holdReason,
      "Turnstile challenge",
      "an explicit reason replaces the automatic one and is not overwritten again",
    );
    f.advance(IDLE_PAGE_MS + 1);
    await f.sweep();
    assert.deepEqual(
      (await f.tabs()).map((tab) => tab.page),
      ["batch-7-item-21"],
      "idle unheld pages are recycled; held pages stay",
    );
    f.advance(HELD_PAGE_TTL_MS);
    await f.sweep();
    assert.deepEqual(await f.tabs(), []);
  } finally {
    await f.cleanup();
  }
});

test("explicit hold keeps a page and site popups are closed with their item", async () => {
  const f = await fixture({ displayMode: "visible" });
  try {
    await f.runtime.execute(navigate("batch-8-item-31"), request);
    const main = f.fake.pages[0]!;
    const popup = f.fake.addPage(main);
    await new Promise((resolve) => setImmediate(resolve));
    const withPopup = await f.tabs();
    assert.equal(withPopup.length, 2);
    assert.equal(withPopup.find((tab) => tab.openerPage === "batch-8-item-31")?.itemId, 31);
    await f.runtime.execute(
      { action: "hold", page: "batch-8-item-31", reason: "CAPTCHA" },
      request,
    );
    await f.runtime.releaseItemPages(31, "recycle");
    assert.equal(popup.isClosed(), true, "the item's popup closes with the item");
    assert.equal(main.url(), "about:blank");
    await f.runtime.execute(navigate("batch-8-item-32"), request);
    await f.runtime.execute(
      { action: "hold", page: "batch-8-item-32", reason: "CAPTCHA" },
      request,
    );
    f.advance(IDLE_PAGE_MS * 3);
    await f.sweep();
    assert.equal((await f.tabs())[0]?.holdReason, "CAPTCHA");
  } finally {
    await f.cleanup();
  }
});

test("recycling waits for an in-flight action on the same page and never interleaves", async () => {
  const f = await fixture({ displayMode: "visible" });
  try {
    await f.runtime.execute(navigate("batch-9-item-41"), request);
    let finishClick!: () => void;
    f.fake.setNextClick(() => new Promise<void>((resolve) => (finishClick = resolve)));
    const click = f.runtime.execute(
      { action: "click", page: "batch-9-item-41", selector: "text:Submit" },
      request,
    );
    await new Promise((resolve) => setImmediate(resolve));
    const release = f.runtime.releaseItemPages(41, "recycle");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.fake.pages[0]!.url(), "https://site.test/batch-9-item-41");
    finishClick();
    await Promise.all([click, release]);
    const order = f.fake.actions.filter(
      (entry) => entry.action !== "navigate" || entry.value === "about:blank",
    );
    assert.deepEqual(
      order.map((entry) => entry.action + (entry.value ? `:${entry.value}` : "")),
      ["click", "navigate:about:blank"],
    );
  } finally {
    await f.cleanup();
  }
});

test("the pool is bounded and the whole browser closes after a long idle period", async () => {
  const f = await fixture({ displayMode: "visible" });
  try {
    const names = Array.from(
      { length: MAX_IDLE_POOL + 1 },
      (_, index) => `batch-1-item-${index + 1}`,
    );
    for (const name of names) await f.runtime.execute(navigate(name), request);
    for (let index = 0; index < names.length; index += 1)
      await f.runtime.releaseItemPages(index + 1, "recycle");
    assert.equal(f.fake.pages.filter((page) => page.isClosed()).length, 1);
    assert.equal(f.fake.context.pages().length, MAX_IDLE_POOL);
    f.advance(BROWSER_IDLE_CLOSE_MS - 1);
    await f.sweep();
    assert.equal(f.fake.isClosed(), false);
    f.advance(2);
    await f.sweep();
    assert.equal(f.fake.isClosed(), true, "an idle browser closes and keeps its profile");
    const status = await f.runtime.execute({ action: "status" }, request);
    assert.equal(status.kind === "status" && status.running, false);
    await f.runtime.execute(navigate("batch-1-item-9"), request);
    assert.equal(f.fake.launches.length, 2, "the next action relaunches lazily");
  } finally {
    await f.cleanup();
  }
});

test("background mode parks windows, creates background tabs and suspends while revealed", async () => {
  const f = await fixture({ displayMode: "background" });
  try {
    f.fake.addPage(); // Chrome 启动时的 about:blank
    await f.runtime.execute({ action: "tabs" }, request);
    await f.runtime.execute(navigate("batch-2-item-51"), request);
    const initial = f.fake.pages[0]!;
    assert.equal(f.fake.pages.length, 1, "the launch page is pooled and reused");
    assert.equal(f.fake.windowState(initial), "parked");
    assert.ok(f.focusCalls.includes("yield:4242"), "focus is handed back after launch");
    assert.equal(f.fake.launches.length, 1);
    assert.equal((f.fake.launches[0]!.options as { headless: boolean }).headless, false);

    await f.runtime.execute(navigate("batch-2-item-52"), request);
    const created = f.fake.pages[1]!;
    assert.ok(
      f.fake.cdpCalls.some(
        (call) =>
          call.method === "Target.createTarget" &&
          (call.params as { background?: boolean }).background === true,
      ),
    );
    assert.equal(f.fake.windowState(created), "parked", "the window is parked again");

    const popup = f.fake.addPage(created, 900);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(f.fake.windowState(popup), "parked", "site popups are parked");

    await f.runtime.releaseItemPages(52, "hold");
    await f.runtime.execute({ action: "bringToFront", page: "batch-2-item-52" }, request);
    assert.equal(f.fake.windowState(created), "shown");
    assert.ok(f.fake.actions.some((entry) => entry.action === "bringToFront"));
    const revealedPopup = f.fake.addPage(created, 901);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(f.fake.windowState(revealedPopup), "shown", "no auto-parking while revealed");

    await f.runtime.execute({ action: "closePage", page: "batch-2-item-52" }, request);
    assert.equal(f.fake.windowState(created), "shown", "a user-driven popup is still open");
    await revealedPopup.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(f.fake.windowState(created), "parked", "the window is parked again afterwards");
  } finally {
    await f.cleanup();
  }
});

test("headless and visible modes never move windows and CDP attachment never pools or hides", async () => {
  const headless = await fixture({ displayMode: "headless" });
  try {
    await headless.runtime.execute(navigate("batch-3-item-61"), request);
    assert.equal((headless.fake.launches[0]!.options as { headless: boolean }).headless, true);
    assert.equal(headless.fake.cdpCalls.length, 0);
    assert.deepEqual(headless.focusCalls, []);
  } finally {
    await headless.cleanup();
  }
  const legacy = await fixture({ headless: true });
  try {
    const status = await legacy.runtime.execute({ action: "status" }, request);
    assert.equal(status.kind === "status" && status.displayMode, "headless");
  } finally {
    await legacy.cleanup();
  }
  const fake = createFakeChromium();
  const userTab = fake.addPage();
  const root = await mkdtemp(join(tmpdir(), "zcode-backlinks-attached-"));
  const runtime = createBacklinkBrowserRuntime({
    profilePath: join(root, "profile"),
    workspacePath: root,
    cdpEndpoint: "http://127.0.0.1:9222",
    displayMode: "background",
    focusControl: {
      findBrowserPid: async () => assert.fail("attached browsers are never focus-managed"),
      yieldIfFront: async () => assert.fail("attached browsers are never focus-managed"),
    },
    loadChromium: async () => ({
      ...fake.chromium,
      connectOverCDP: async () =>
        ({ contexts: () => [fake.context], close: async () => {} }) as never,
    }),
  });
  try {
    await runtime.execute(navigate("batch-4-item-71"), request);
    const own = fake.pages[1]!;
    assert.ok(
      fake.cdpCalls.some(
        (call) =>
          call.method === "Target.createTarget" &&
          (call.params as { background?: boolean }).background === true,
      ),
      "CDP pages are created as background tabs",
    );
    assert.equal(
      fake.cdpCalls.some((call) => call.method === "Browser.setWindowBounds"),
      false,
      "the user's browser windows are never moved",
    );
    await runtime.releaseItemPages(71, "recycle");
    assert.equal(own.isClosed(), true, "attached mode closes its own page instead of pooling");
    assert.equal(userTab.isClosed(), false);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});
