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
