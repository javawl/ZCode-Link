import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBacklinksRuntime, executeBacklinksCommand } from "../src/node.js";

test("mailbox status discovers domains without creating mail, then creation uses the same default", async () => {
  const root = await mkdtemp(join(tmpdir(), "mail-discovery-"));
  const calls: { path: string; method?: string; body?: string }[] = [];
  const runtime = createBacklinksRuntime({
    dataBaseDir: root,
    env: {},
    fetch: async (url, init) => {
      calls.push({
        path: new URL(String(url)).pathname,
        method: init?.method,
        body: init?.body as string,
      });
      assert.equal(new Headers(init?.headers).get("authorization"), "fixture-secret");
      return Response.json({
        code: 200,
        data: String(url).endsWith("websiteConfig")
          ? {
              domainList: ["@Mail.test", "@mail.test", "other.test"],
              privateValue: "must-not-leak",
            }
          : null,
      });
    },
  });
  try {
    await runtime.updateSettings({
      cloudMail: { baseUrl: "https://mail-api.test/api", token: "fixture-secret" },
    });
    const status = await runtime.getMailboxStatus();
    assert.deepEqual(status, {
      configured: true,
      defaultDomain: "mail.test",
      domains: ["mail.test", "other.test"],
      domainSource: "discovered",
    });
    assert.deepEqual(
      calls.map((c) => [c.path, c.method]),
      [["/api/setting/websiteConfig", "GET"]],
    );
    assert.doesNotMatch(JSON.stringify(status), /fixture-secret|must-not-leak/);
    await executeBacklinksCommand(runtime, { action: "mailbox_create", localPart: "publisher" });
    assert.deepEqual(JSON.parse(calls.at(-1)!.body!), { list: [{ email: "publisher@mail.test" }] });
    await runtime.updateSettings({ mailboxDomain: "chosen.test" });
    const before = calls.length;
    assert.equal((await runtime.getMailboxStatus()).domainSource, "configured");
    await executeBacklinksCommand(runtime, { action: "mailbox_create", localPart: "publisher" });
    assert.equal(calls.length, before + 1);
    assert.match(calls.at(-1)!.body!, /publisher@chosen.test/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing, invalid or denied discovery cannot create a mailbox or expose raw backend errors", async () => {
  for (const payload of [
    { code: 200, data: { domainList: [] } },
    { code: 200, data: { domainList: ["https://invalid.test"] } },
    { code: 401, message: "private-response" },
  ]) {
    const root = await mkdtemp(join(tmpdir(), "mail-discovery-error-"));
    const methods: string[] = [];
    const runtime = createBacklinksRuntime({
      dataBaseDir: root,
      env: {},
      fetch: async (_url, init) => {
        methods.push(init!.method!);
        return Response.json(payload);
      },
    });
    try {
      assert.equal((await runtime.getMailboxStatus()).configured, false);
      assert.deepEqual(methods, []);
      await runtime.updateSettings({
        cloudMail: { baseUrl: "https://mail-api.test/api", token: "fixture" },
      });
      const status = await runtime.getMailboxStatus();
      assert.equal(status.defaultDomain, "");
      assert.equal(status.domainSource, "unavailable");
      assert.doesNotMatch(JSON.stringify(status), /private-response/);
      await assert.rejects(
        executeBacklinksCommand(runtime, { action: "mailbox_create", localPart: "publisher" }),
      );
      assert.ok(methods.every((method) => method === "GET"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
