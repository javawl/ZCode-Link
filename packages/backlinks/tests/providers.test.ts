import assert from "node:assert/strict";
import test from "node:test";
import { SupermanagerBatchSource, CloudMailMailbox } from "../src/node.js";

const batch = {
  id: 9,
  name: "Batch",
  websiteId: 1,
  websiteName: "Site",
  websiteHost: "site.test",
  plannedAt: "2026-09-21",
  counts: { pending: 1, executed: 0, skipped: 0, failed: 0, total: 1 },
  executing: false,
};
const item = {
  id: 11,
  sourceId: 22,
  sourceName: "Directory",
  sourceUrl: "https://directory.test",
  sourceHost: "directory.test",
  submitUrl: "https://directory.test/submit",
  sourceNotes: "Notes",
  category: "directory",
  tags: ["free"],
  paymentType: "free",
  linkType: "dofollow",
  status: "pending",
  failureMode: null,
  failureReason: null,
  publishedUrl: null,
  publishStatus: null,
  plannedAt: "2026-09-21",
};
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

test("Supermanager preserves all routes, bearer authentication, metadata and result wire names", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const replies = [
    { batches: [batch] },
    {
      batch,
      website: {
        id: 1,
        name: "Site",
        siteUrl: "https://site.test",
        siteHost: "site.test",
        shortDescription: "Short",
        longDescription: "Long",
        logoUrl: "https://site.test/logo.png",
        screenshotUrl: "https://site.test/shot.png",
        keyFeatures: "Features",
        pricingType: "free",
      },
      anchors: [{ id: 1, anchorText: "Site", targetUrl: "https://site.test" }],
      items: [item],
    },
    { leaseId: 33, leaseExpiresAt: "server-clock", items: [item] },
    { leaseId: 33, leaseExpiresAt: "renewed" },
    {},
    ...Array.from({ length: 4 }, () => ({ itemStatus: "executed", publishRecordId: 44 })),
    { backlinkId: 55, callbackTriggered: false },
    { sourceId: 22, attached: [{ id: 4, name: "可复用", created: true }] },
  ];
  const provider = new SupermanagerBatchSource(
    { baseUrl: "https://sm.test/", token: "secret", requestTimeoutMs: 1000 },
    async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return json(replies.shift());
    },
  );
  assert.equal(provider.available(), true);
  assert.deepEqual(await provider.listBatches(), [batch]);
  const detail = await provider.getBatch(9);
  assert.equal(detail.website.screenshotUrl, "https://site.test/shot.png");
  assert.deepEqual(detail.items[0], item);
  await provider.claim(9, [11]);
  await provider.heartbeat(33);
  await provider.release(33);
  await provider.reportItemResult(11, {
    status: "live",
    publicUrl: "https://directory.test/site",
    anchorText: "Site",
    targetUrl: "https://site.test",
    evidence: "公开链接已核验",
  });
  await provider.reportItemResult(11, {
    status: "submitted",
    anchorText: "Site",
    targetUrl: "https://site.test",
  });
  await provider.reportItemResult(11, {
    status: "failed",
    failureMode: "manual_required",
    failureReason: "Unknown",
    evidence: "未重试",
  });
  await provider.reportItemResult(11, { status: "skipped", skipReason: "Duplicate" });
  await provider.addBadge(1, { name: "Directory", html: "<a>Badge</a>", isActive: false });
  await provider.tagSource(22, ["可复用"]);
  assert.deepEqual(
    calls.map((c) => c.url.replace("https://sm.test", "")),
    [
      "/api/agent/batches",
      "/api/agent/batches/9",
      "/api/agent/batches/9/claim",
      "/api/agent/leases/33/heartbeat",
      "/api/agent/leases/33/release",
      ...Array(4).fill("/api/agent/items/11/result"),
      "/api/agent/websites/1/footer-backlinks",
      "/api/agent/sources/22/tags",
    ],
  );
  assert.ok(
    calls.every((c) => new Headers(c.init.headers).get("authorization") === "Bearer secret"),
  );
  assert.deepEqual(JSON.parse(String(calls[2]?.init.body)), { itemIds: [11] });
  assert.equal(JSON.parse(String(calls[5]?.init.body)).evidenceZh, "公开链接已核验");
  assert.equal(JSON.parse(String(calls[5]?.init.body)).evidence, undefined);
});

test("providers preserve HTTP errors and retry advice without disclosing response bodies", async () => {
  for (const [status, code] of [
    [400, "BACKLINKS_INVALID_REQUEST"],
    [401, "BACKLINKS_UNAUTHORIZED"],
    [403, "BACKLINKS_UNAUTHORIZED"],
    [404, "BACKLINKS_NOT_FOUND"],
    [409, "BACKLINKS_CONFLICT"],
    [500, "BACKLINKS_API_ERROR"],
  ] as const) {
    const provider = new SupermanagerBatchSource(
      { baseUrl: "https://sm.test", token: "secret", requestTimeoutMs: 1000 },
      async () =>
        new Response("sensitive backend body", { status, headers: { "retry-after": "42" } }),
    );
    await assert.rejects(
      provider.listBatches(),
      (error: any) =>
        error.code === code &&
        !error.message.includes("sensitive") &&
        (status !== 409 || error.retryAfterSeconds === 42),
    );
  }
  const invalid = new SupermanagerBatchSource(
    { baseUrl: "https://sm.test", token: "secret", requestTimeoutMs: 1000 },
    async () => json({ batches: [{ id: "not-an-id" }] }),
  );
  await assert.rejects(invalid.listBatches(), { code: "BACKLINKS_API_ERROR" });
});

test("HTTP waits are cancelled or timed out and never silently retried", async () => {
  let calls = 0;
  const waiting: typeof fetch = async (_url, init) => {
    calls++;
    return await new Promise((_resolve, reject) =>
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
    );
  };
  const provider = new SupermanagerBatchSource(
    { baseUrl: "https://sm.test", token: "secret", requestTimeoutMs: 15 },
    waiting,
  );
  await assert.rejects(provider.listBatches(), { code: "BACKLINKS_TIMEOUT" });
  const aborted = AbortSignal.abort();
  await assert.rejects(provider.listBatches(aborted), { code: "BACKLINKS_ABORTED" });
  assert.equal(calls, 1);
  const controller = new AbortController();
  const pending = provider.listBatches(controller.signal);
  controller.abort();
  await assert.rejects(pending, { code: "BACKLINKS_ABORTED" });
});

test("Cloud Mail preserves raw token, array/list envelopes, case-insensitive filters and extraction", async () => {
  const calls: RequestInit[] = [];
  let n = 0;
  const row = {
    subject: "Verify",
    sendEmail: "verify@directory.test",
    text: "Code 1234 https://directory.test/verify?t=1",
    code: "1234",
    createTime: "now",
  };
  const provider = new CloudMailMailbox(
    { baseUrl: "https://mail.test/api", token: "raw-token", requestTimeoutMs: 1000 },
    async (_url, init) => {
      calls.push(init ?? {});
      return json(
        n++ === 0
          ? { code: 200, data: {} }
          : n === 2
            ? { code: 200, data: { list: [{ subject: "Wrong", sendEmail: "other" }] } }
            : { code: 200, data: [row] },
      );
    },
  );
  assert.deepEqual(await provider.createMailbox({ localPart: "agent", domain: "mail.test" }), {
    email: "agent@mail.test",
  });
  const mail = await provider.pollMail(
    { email: "agent@mail.test" },
    { subjectContains: "VERIFY", fromContains: "DIRECTORY", timeoutMs: 1000, intervalMs: 1 },
  );
  assert.equal(mail?.code, "1234");
  assert.equal(mail?.link, "https://directory.test/verify?t=1");
  assert.ok(calls.every((c) => new Headers(c.headers).get("authorization") === "raw-token"));
  assert.deepEqual(JSON.parse(String(calls[0]?.body)), { list: [{ email: "agent@mail.test" }] });
  assert.deepEqual(JSON.parse(String(calls[1]?.body)), {
    toEmail: "agent@mail.test",
    size: 20,
    num: 1,
    type: 0,
    isDel: 0,
  });
});

test("mail polling is bounded, cancellable and rejects malformed/business failures", async () => {
  const provider = new CloudMailMailbox(
    { baseUrl: "https://mail.test", token: "token", requestTimeoutMs: 1000 },
    async () => json({ code: 200, data: [] }),
  );
  assert.equal(
    await provider.pollMail({ email: "x@mail.test" }, { timeoutMs: 10, intervalMs: 2 }),
    null,
  );
  const controller = new AbortController();
  const pending = provider.pollMail(
    { email: "x@mail.test" },
    { timeoutMs: 1000, intervalMs: 100 },
    controller.signal,
  );
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(pending, { code: "BACKLINKS_ABORTED" });
  const failed = new CloudMailMailbox(
    { baseUrl: "https://mail.test", token: "token", requestTimeoutMs: 1000 },
    async () => json({ code: 403, message: "denied" }),
  );
  await assert.rejects(failed.createMailbox({ localPart: "x", domain: "mail.test" }), {
    code: "BACKLINKS_UNAUTHORIZED",
  });
});
