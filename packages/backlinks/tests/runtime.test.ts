import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBacklinksRuntime } from "../src/node.js";

const batch = {
  id: 9,
  name: "Batch",
  websiteId: 1,
  websiteName: "Site",
  websiteHost: "site.test",
  plannedAt: "now",
  counts: { pending: 5, executed: 1, skipped: 0, failed: 1, total: 7 },
  executing: false,
};
const item = (id: number, sourceId: number, extra = {}) => ({
  id,
  sourceId,
  sourceName: "Directory",
  sourceUrl: "https://dir.test",
  sourceHost: "dir.test",
  submitUrl: null,
  sourceNotes: null,
  category: null,
  tags: [],
  paymentType: "free",
  linkType: "dofollow",
  status: "pending",
  failureMode: null,
  failureReason: null,
  publishedUrl: null,
  publishStatus: null,
  plannedAt: "now",
  ...extra,
});
const items = [
  item(1, 1, { publishStatus: "submitted" }),
  item(2, 1),
  item(3, 3),
  item(4, 3),
  item(5, 5, { status: "failed", failureMode: "manual_required" }),
];

test("claim excludes published sources, deduplicates targets, and binds lifecycle to the original provider", async () => {
  const dir = await mkdtemp(join(tmpdir(), "backlinks-leases-"));
  try {
    const calls: { url: string; body: Record<string, unknown> | undefined }[] = [];
    const runtime = createBacklinksRuntime({
      dataBaseDir: dir,
      env: {},
      fetch: async (url, init) => {
        const path = String(url);
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ url: path, body });
        const response = path.endsWith("/claim")
          ? {
              leaseId: 31,
              leaseExpiresAt: "server",
              items: items.filter((i) => body.itemIds.includes(i.id)),
            }
          : path.endsWith("/heartbeat")
            ? { leaseId: 31, leaseExpiresAt: "renewed" }
            : path.endsWith("/result")
              ? { itemStatus: "executed", publishRecordId: 42 }
              : path.endsWith("/release")
                ? {}
                : {
                    batch,
                    website: {
                      id: 1,
                      name: "Site",
                      siteUrl: "https://site.test",
                      siteHost: "site.test",
                    },
                    anchors: [],
                    items,
                  };
        return Response.json(response);
      },
    });
    await runtime.updateSettings({
      supermanager: { baseUrl: "https://first.test", token: "secret" },
    });
    const claim = await runtime.claim(9);
    assert.deepEqual(
      claim.items.map((i) => i.id),
      [3],
    );
    assert.deepEqual(calls[1]?.body, { itemIds: [3] });
    await runtime.updateSettings({ supermanager: { baseUrl: "https://second.test" } });
    await runtime.heartbeat(31);
    await runtime.reportItemResult(3, {
      status: "submitted",
      anchorText: "Site",
      targetUrl: "https://site.test",
    });
    await assert.rejects(
      runtime.reportItemResult(100, { status: "skipped", skipReason: "wrong scope" }),
      { code: "BACKLINKS_INVALID_REQUEST" },
    );
    await runtime.releaseOwnedLeases();
    assert.ok(calls.slice(2).every((c) => c.url.startsWith("https://first.test")));
    const before = calls.length;
    await runtime.releaseOwnedLeases();
    assert.equal(calls.length, before);
    await assert.rejects(runtime.claim(9, [1, 2]), { code: "BACKLINKS_INVALID_REQUEST" });
    await assert.rejects(runtime.claim(9, [999]), { code: "BACKLINKS_INVALID_REQUEST" });
    const manual = await runtime.claim(9, [5]);
    assert.deepEqual(
      manual.items.map((i) => i.id),
      [5],
    );
    await runtime.releaseOwnedLeases();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("new runtime is lazy and unconfigured settings do not block other workflows", async () => {
  const dir = await mkdtemp(join(tmpdir(), "backlinks-empty-"));
  try {
    let requests = 0;
    const runtime = createBacklinksRuntime({
      dataBaseDir: dir,
      env: {},
      fetch: async () => {
        requests++;
        throw new Error("should not reach");
      },
    });
    const settings = await runtime.getSettings();
    assert.equal(settings.supermanager.tokenConfigured, false);
    assert.equal(settings.browser.channel, "chrome");
    await assert.rejects(runtime.listBatches(), { code: "BACKLINKS_PROVIDER_UNAVAILABLE" });
    assert.equal(requests, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("shutdown waits for an in-flight known claim before releasing it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "backlinks-shutdown-"));
  let releaseCalls = 0;
  let finishClaim!: (response: Response) => void;
  let claimStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    claimStarted = resolve;
  });
  try {
    const runtime = createBacklinksRuntime({
      dataBaseDir: dir,
      env: { SUPERMANAGER_BASE_URL: "https://sm.test", SUPERMANAGER_TOKEN: "token" },
      fetch: async (url) => {
        if (String(url).endsWith("/claim")) {
          claimStarted();
          return new Promise<Response>((resolve) => {
            finishClaim = resolve;
          });
        }
        if (String(url).endsWith("/release")) {
          releaseCalls++;
          return Response.json({});
        }
        return Response.json({
          batch,
          website: { id: 1, name: "Site", siteUrl: "https://site.test", siteHost: "site.test" },
          anchors: [],
          items: [item(3, 3)],
        });
      },
    });
    const pending = runtime.claim(9);
    await started;
    const closing = runtime.releaseOwnedLeases();
    finishClaim(Response.json({ leaseId: 88, leaseExpiresAt: "server", items: [item(3, 3)] }));
    await Promise.all([pending, closing]);
    assert.equal(releaseCalls, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
