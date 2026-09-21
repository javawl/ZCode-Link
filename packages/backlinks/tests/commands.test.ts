import assert from "node:assert/strict";
import test from "node:test";
import { backlinksCommandSchema, BacklinksError } from "../src/contract.js";
import { executeBacklinksCommand, BacklinksProviderRegistry } from "../src/node.js";

test("command schema preserves source names and rejects accidental broadened claims", () => {
  const valid = [
    { action: "batch_list" },
    { action: "batch_get", batchId: 1 },
    { action: "batch_claim", batchId: 1, itemIds: [2] },
    { action: "lease_heartbeat", leaseId: 3 },
    { action: "lease_release", leaseId: 3 },
    { action: "item_result", itemId: 2, status: "skipped", skipReason: "duplicate" },
    { action: "badge_add", websiteId: 1, name: "Badge", html: "<b>Badge</b>" },
    { action: "source_tags", sourceId: 2, tags: ["可复用"] },
    { action: "mailbox_create", localPart: "a", domain: "mail.test" },
    { action: "mail_wait", mailEmail: "a@mail.test" },
  ];
  for (const command of valid)
    assert.equal(backlinksCommandSchema.safeParse(command).success, true);
  for (const command of [
    { action: "batch_claim", batchId: 1, itemIds: [] },
    { action: "batch_claim", batchId: 1, itemIds: ["oops"] },
    { action: "batch_get", batchId: -1 },
    { action: "item_result", itemId: 1, status: "live" },
    { action: "item_result", itemId: 1, status: "skipped", failureReason: "wrong" },
    { action: "mail_wait", mailEmail: "bad" },
    { action: "batch_heartbeat", leaseId: 1 },
  ])
    assert.equal(backlinksCommandSchema.safeParse(command).success, false);
});

test("dispatcher reaches all ten operations and preserves domain and timeout defaults", async () => {
  const seen: string[] = [];
  const runtime = {
    listBatches: async () => {
      seen.push("batch_list");
      return [];
    },
    getBatch: async () => {
      seen.push("batch_get");
      return { batch: { name: "B" }, items: [] };
    },
    claim: async () => {
      seen.push("batch_claim");
      return { leaseId: 1, items: [] };
    },
    heartbeat: async () => {
      seen.push("lease_heartbeat");
      return { leaseId: 1 };
    },
    release: async () => {
      seen.push("lease_release");
    },
    reportItemResult: async () => {
      seen.push("item_result");
      return { itemStatus: "skipped" };
    },
    addBadge: async () => {
      seen.push("badge_add");
      return { backlinkId: 1, callbackTriggered: false };
    },
    tagSource: async (_id: number, names: string[]) => {
      seen.push("source_tags");
      assert.deepEqual(names, ["可复用"]);
      return {};
    },
    createMailbox: async (options: { domain: string }) => {
      seen.push("mailbox_create");
      assert.equal(options.domain, "mail.test");
      return { email: "a@mail.test" };
    },
    pollMail: async (_address: unknown, options: { timeoutMs: number; intervalMs: number }) => {
      seen.push("mail_wait");
      assert.deepEqual(options, { timeoutMs: 120000, intervalMs: 5000 });
      return null;
    },
    getSettings: async () => ({ mailboxDomain: "mail.test" }),
  };
  const inputs = [
    { action: "batch_list" },
    { action: "batch_get", batchId: 1 },
    { action: "batch_claim", batchId: 1 },
    { action: "lease_heartbeat", leaseId: 1 },
    { action: "lease_release", leaseId: 1 },
    { action: "item_result", itemId: 1, status: "skipped", skipReason: "duplicate" },
    { action: "badge_add", websiteId: 1, name: "Badge", html: "<b>x</b>" },
    { action: "source_tags", sourceId: 1, tags: [" 可复用 ", "可复用"] },
    { action: "mailbox_create", localPart: "a" },
    { action: "mail_wait", mailEmail: "a@mail.test" },
  ];
  for (const input of inputs)
    assert.equal((await executeBacklinksCommand(runtime as never, input)).action, input.action);
  assert.deepEqual(
    seen,
    inputs.map((i) => i.action),
  );
});

test("provider registry resolves selection and rejects duplicate/missing/unavailable/ambiguous providers", () => {
  const registry = new BacklinksProviderRegistry<{ id: string; available(): boolean }>();
  assert.throws(() => registry.resolve(), { code: "BACKLINKS_PROVIDER_UNAVAILABLE" });
  const dispose = registry.register({ id: "a", available: () => true });
  assert.equal(registry.resolve().id, "a");
  assert.throws(() => registry.register({ id: "a", available: () => true }), {
    code: "BACKLINKS_DUPLICATE_PROVIDER",
  });
  registry.register({ id: "b", available: () => true });
  assert.throws(() => registry.resolve(), { code: "BACKLINKS_PROVIDER_AMBIGUOUS" });
  assert.equal(registry.resolve("b").id, "b");
  assert.throws(() => registry.resolve("missing"), {
    code: "BACKLINKS_PROVIDER_CONFIGURED_MISSING",
  });
  registry.register({ id: "c", available: () => false });
  assert.throws(() => registry.resolve("c"), { code: "BACKLINKS_PROVIDER_CONFIGURED_UNAVAILABLE" });
  dispose();
  assert.equal(registry.resolve().id, "b");
  assert.equal(new BacklinksError("conflict", "BACKLINKS_CONFLICT", 5).retryAfterSeconds, 5);
});
