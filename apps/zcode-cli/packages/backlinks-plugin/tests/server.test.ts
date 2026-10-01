import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBacklinksToolHandlers } from "../src/handlers.js";

test("status is read-only, browser starts lazily, and commands receive cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-backlinks-mcp-"));
  let browserStarts = 0;
  let receivedSignal: AbortSignal | undefined;
  const handlers = createBacklinksToolHandlers({
    dataBaseDir: root,
    workspacePath: root,
    getSettings: async () => ({
      supermanager: { baseUrl: "https://manager.example", tokenConfigured: true },
      cloudMail: { baseUrl: "", tokenConfigured: false },
      mailboxDomain: "mail.example",
      browser: { headless: true, channel: "chrome", executablePath: "" },
    }),
    execute: async (input, signal) => {
      receivedSignal = signal;
      return { action: input.action, summary: "Listed batches", data: [] };
    },
    createBrowser: () => {
      browserStarts += 1;
      return { execute: async () => ({ kind: "acked" as const }), close: async () => {} };
    },
  });
  try {
    const controller = new AbortController();
    const status = await handlers.call("backlinks_status", {}, { signal: controller.signal });
    assert.equal(status.isError, undefined);
    assert.match(JSON.stringify(status), /tokenConfigured/);
    assert.equal(browserStarts, 0);
    await handlers.call("backlinks", { action: "batch_list" }, { signal: controller.signal });
    assert.equal(receivedSignal?.aborted, false);
    assert.equal(browserStarts, 0);
    const heartbeat = await handlers.call(
      "backlinks_worker",
      { action: "lease_heartbeat", leaseId: 3 },
      { signal: controller.signal },
    );
    assert.equal(heartbeat.isError, undefined);
    const forbiddenClaim = await handlers.call(
      "backlinks_worker",
      { action: "batch_claim", batchId: 1, itemIds: [2] },
      {},
    );
    assert.equal(forbiddenClaim.isError, true);
    const invalid = await handlers.call("backlinks", { action: "batch_get", batchId: -1 }, {});
    assert.equal(invalid.isError, true);
    const unscoped = await handlers.call("backlinks_browser", { action: "status" }, {});
    assert.equal(unscoped.isError, true);
    assert.equal(browserStarts, 0);
  } finally {
    await handlers.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("browser screenshots retain image content and carry trusted session context", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-backlinks-image-"));
  const calls: unknown[] = [];
  let closed = false;
  const handlers = createBacklinksToolHandlers({
    dataBaseDir: root,
    workspacePath: root,
    getSettings: async () => ({
      supermanager: { baseUrl: "", tokenConfigured: false },
      cloudMail: { baseUrl: "", tokenConfigured: false },
      mailboxDomain: "",
      browser: { headless: true, channel: "chrome", executablePath: "" },
    }),
    execute: async () => ({ action: "batch_list", summary: "", data: [] }),
    createBrowser: () => ({
      execute: async (_command, context) => {
        calls.push(context);
        return { kind: "screenshot" as const, pngBase64: "cG5n" };
      },
      close: async () => {
        closed = true;
      },
    }),
  });
  try {
    const result = await handlers.call(
      "backlinks_browser",
      { action: "screenshot", page: "one" },
      {
        requestContext: { trace_id: "trace-1", session_id: "session-1", workspace_path: root },
      },
    );
    assert.deepEqual(result.content[0], { type: "image", mimeType: "image/png", data: "cG5n" });
    assert.equal((calls[0] as { traceId: string }).traceId, "trace-1");
    assert.equal((calls[0] as { sessionId: string }).sessionId, "session-1");
    await handlers.close();
    assert.equal(closed, true);
  } finally {
    await handlers.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("large backend payloads are saved as workspace artifacts instead of silently truncated", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-backlinks-spill-"));
  const payload = "example ".repeat(12_000);
  const handlers = createBacklinksToolHandlers({
    dataBaseDir: root,
    workspacePath: root,
    execute: async () => ({ action: "batch_list", summary: "Many batches", data: payload }),
  });
  try {
    const result = await handlers.call("backlinks", { action: "batch_list" }, {});
    const structured = result.structuredContent as { artifactPath: string; truncated: boolean };
    assert.equal(structured.truncated, true);
    const saved = JSON.parse(await readFile(structured.artifactPath, "utf8"));
    assert.equal(saved.data, payload);
    assert.ok(JSON.stringify(result.content).length < 65_000);
  } finally {
    await handlers.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("cleanup releases leases only for the host-injected current session", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-backlinks-cleanup-"));
  const sessions: string[] = [];
  const handlers = createBacklinksToolHandlers({
    dataBaseDir: root,
    workspacePath: root,
    releaseSessionLeases: async (sessionId) => {
      sessions.push(sessionId);
    },
  });
  try {
    const unscoped = await handlers.call("backlinks_cleanup", {}, {});
    assert.equal(unscoped.isError, true);
    const scoped = await handlers.call(
      "backlinks_cleanup",
      {},
      { requestContext: { session_id: "session-1", trace_id: "trace-1" } },
    );
    assert.equal(scoped.isError, undefined);
    assert.deepEqual(sessions, ["session-1"]);
  } finally {
    await handlers.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("successful item results recycle or hold only an already running browser", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-backlinks-settle-"));
  const released: Array<[number, string]> = [];
  let browserStarts = 0;
  let failRelease = false;
  const handlers = createBacklinksToolHandlers({
    dataBaseDir: root,
    workspacePath: root,
    getSettings: async () => ({
      supermanager: { baseUrl: "", tokenConfigured: false },
      cloudMail: { baseUrl: "", tokenConfigured: false },
      mailboxDomain: "",
      browser: {
        displayMode: "background",
        headless: false,
        channel: "chrome",
        executablePath: "",
      },
    }),
    execute: async (input) => ({ action: input.action, summary: "ok", data: {} }),
    createBrowser: (options) => {
      browserStarts += 1;
      assert.equal(options.displayMode, "background");
      return {
        execute: async () => ({ kind: "acked" as const }),
        releaseItemPages: async (itemId, outcome) => {
          if (failRelease) throw new Error("page already gone");
          released.push([itemId, outcome]);
        },
        close: async () => {},
      };
    },
  });
  const context = { requestContext: { trace_id: "t", session_id: "s", workspace_path: root } };
  const live = {
    action: "item_result",
    itemId: 5,
    status: "live",
    publicUrl: "https://site.test/entry",
    anchorText: "Anchor",
    targetUrl: "https://target.test/",
  };
  try {
    await handlers.call("backlinks_worker", live, context);
    assert.equal(browserStarts, 0, "results never launch a browser just to recycle pages");
    await handlers.call("backlinks_browser", { action: "tabs" }, context);
    await handlers.call("backlinks_worker", live, context);
    await handlers.call(
      "backlinks",
      {
        action: "item_result",
        itemId: 6,
        status: "failed",
        failureMode: "manual_required",
        failureReason: "CAPTCHA",
      },
      context,
    );
    await handlers.call(
      "backlinks_worker",
      { action: "item_result", itemId: 7, status: "skipped", skipReason: "duplicate" },
      context,
    );
    await handlers.call(
      "backlinks_worker",
      {
        action: "item_result",
        itemId: 8,
        status: "failed",
        failureMode: "retryable",
        failureReason: "timeout before submit",
      },
      context,
    );
    await handlers.call("backlinks_worker", { action: "lease_heartbeat", leaseId: 1 }, context);
    assert.deepEqual(released, [
      [5, "recycle"],
      [6, "hold"],
      [7, "recycle"],
      [8, "recycle"],
    ]);
    failRelease = true;
    const stillOk = await handlers.call("backlinks_worker", live, context);
    assert.equal(stillOk.isError, undefined, "page cleanup failures never fail a recorded result");
  } finally {
    await handlers.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an idle-closed browser is rebuilt from current settings after it releases the profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-backlinks-idle-rebuild-"));
  let displayMode: "background" | "headless" = "headless";
  const created: Array<{ displayMode?: string; onIdleClose?: (closed: Promise<void>) => void }> =
    [];
  const handlers = createBacklinksToolHandlers({
    dataBaseDir: root,
    workspacePath: root,
    getSettings: async () => ({
      supermanager: { baseUrl: "", tokenConfigured: false },
      cloudMail: { baseUrl: "", tokenConfigured: false },
      mailboxDomain: "",
      browser: {
        displayMode,
        headless: displayMode === "headless",
        channel: "chrome",
        executablePath: "",
      },
    }),
    execute: async (input) => ({ action: input.action, summary: "ok", data: {} }),
    createBrowser: (options) => {
      created.push(options);
      return {
        execute: async () => ({ kind: "acked" as const }),
        releaseItemPages: async () => {},
        close: async () => {},
      };
    },
  });
  const context = { requestContext: { trace_id: "t", session_id: "s", workspace_path: root } };
  try {
    await handlers.call("backlinks_browser", { action: "tabs" }, context);
    assert.equal(created.length, 1);
    assert.equal(created[0]!.displayMode, "headless");
    displayMode = "background";
    let releaseProfile!: () => void;
    created[0]!.onIdleClose!(new Promise<void>((resolve) => (releaseProfile = resolve)));
    const next = handlers.call("backlinks_browser", { action: "tabs" }, context);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(created.length, 1, "the new runtime waits for the old one to release the profile");
    releaseProfile();
    await next;
    assert.equal(created.length, 2);
    assert.equal(created[1]!.displayMode, "background", "the changed setting now applies");
  } finally {
    await handlers.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("changed browser settings rebuild the runtime at once only when it holds nothing", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-backlinks-settings-rebuild-"));
  let displayMode: "background" | "visible" = "background";
  let idle = false;
  const created: string[] = [];
  const closed: string[] = [];
  const handlers = createBacklinksToolHandlers({
    dataBaseDir: root,
    workspacePath: root,
    getSettings: async () => ({
      supermanager: { baseUrl: "", tokenConfigured: false },
      cloudMail: { baseUrl: "", tokenConfigured: false },
      mailboxDomain: "",
      browser: { displayMode, headless: false, channel: "chrome", executablePath: "" },
    }),
    execute: async (input) => ({ action: input.action, summary: "ok", data: {} }),
    createBrowser: (options) => {
      const mode = options.displayMode!;
      created.push(mode);
      return {
        execute: async () => ({ kind: "acked" as const }),
        releaseItemPages: async () => {},
        isIdle: () => idle,
        close: async () => {
          closed.push(mode);
        },
      };
    },
  });
  const context = { requestContext: { trace_id: "t", session_id: "s", workspace_path: root } };
  try {
    await handlers.call("backlinks_browser", { action: "tabs" }, context);
    displayMode = "visible";
    await handlers.call("backlinks_browser", { action: "tabs" }, context);
    assert.deepEqual(created, ["background"], "pages or held pages keep the running browser");
    idle = true;
    await handlers.call("backlinks_browser", { action: "tabs" }, context);
    assert.deepEqual(created, ["background", "visible"], "an idle browser is rebuilt at once");
    assert.deepEqual(closed, ["background"]);
    await handlers.call("backlinks_browser", { action: "tabs" }, context);
    assert.deepEqual(created, ["background", "visible"], "unchanged settings reuse the runtime");
  } finally {
    await handlers.close();
    await rm(root, { recursive: true, force: true });
  }
});
