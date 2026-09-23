import assert from "node:assert/strict";
import test from "node:test";
import { SupermanagerBatchSource } from "../src/node.js";
import { batchDetailSchema } from "../src/contract.js";

const profileFields = [
  "shortDescription",
  "longDescription",
  "logoUrl",
  "screenshotUrl",
  "keyFeatures",
  "pricingType",
] as const;
const detail = () => ({
  batch: {
    id: 615,
    name: "Fixture",
    websiteId: 1,
    websiteName: "Fixture",
    websiteHost: "fixture.example",
    plannedAt: "2026-09-22",
    executing: false,
    counts: { pending: 1, executed: 0, failed: 0, skipped: 0, total: 1 },
  },
  website: {
    id: 1,
    name: "Fixture",
    siteUrl: "https://fixture.example/",
    siteHost: "fixture.example",
  },
  anchors: [{ id: 1, anchorText: "Fixture", targetUrl: "https://fixture.example/" }],
  items: [
    {
      id: 10,
      sourceId: 20,
      sourceName: "Directory",
      sourceUrl: "https://directory.example",
      sourceHost: "directory.example",
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
      plannedAt: "2026-09-22",
    },
  ],
});
const provider = (body: unknown) =>
  new SupermanagerBatchSource(
    { baseUrl: "https://manager.example", token: "fixture-agent-token", requestTimeoutMs: 1000 },
    async () => Response.json(body),
  );

test("detail accepts nullable optional profile fields and preserves provided strings", async () => {
  for (const field of profileFields) {
    const raw = detail();
    Object.assign(raw.website, { shortDescription: "Supplied description", [field]: null });
    const parsed = await provider(raw).getBatch(615);
    assert.equal(parsed.website[field], undefined);
    if (field !== "shortDescription")
      assert.equal(parsed.website.shortDescription, "Supplied description");
    assert.equal(parsed.items.length, 1);
    assert.equal(parsed.anchors.length, 1);
  }
});

test("all-null and omitted profile fields have the same public output", async () => {
  const absent = detail();
  const nullable = detail();
  Object.assign(nullable.website, Object.fromEntries(profileFields.map((field) => [field, null])));
  assert.equal(
    JSON.stringify(await provider(nullable).getBatch(615)),
    JSON.stringify(await provider(absent).getBatch(615)),
  );
});

test("invalid optional values still fail and errors name fields without disclosing data", async () => {
  for (const value of [
    17,
    false,
    { secret: "private-response-value" },
    ["private-response-value"],
  ]) {
    const raw = detail();
    Object.assign(raw.website, { keyFeatures: value });
    await assert.rejects(provider(raw).getBatch(615), (error: unknown) => {
      assert.equal((error as { code: string }).code, "BACKLINKS_API_ERROR");
      assert.match((error as Error).message, /website\.keyFeatures/);
      assert.doesNotMatch((error as Error).message, /private-response-value|fixture-agent-token/);
      return true;
    });
  }
});

test("required detail fields remain strict", () => {
  const raw = detail();
  assert.equal(
    batchDetailSchema.safeParse({ ...raw, website: { ...raw.website, id: null } }).success,
    false,
  );
  assert.equal(
    batchDetailSchema.safeParse({
      ...raw,
      batch: { ...raw.batch, counts: { ...raw.batch.counts, pending: -1 } },
    }).success,
    false,
  );
  assert.equal(
    batchDetailSchema.safeParse({ ...raw, items: [{ ...raw.items[0], sourceId: 0 }] }).success,
    false,
  );
});
