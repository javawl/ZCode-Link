import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBacklinkBrowserRuntime } from "../src/browser/index.js";
import { createFakeChromium } from "./browser-fixtures.js";

const request = { traceId: "fixture-trace", sessionId: "fixture-session" };

test("CDP lists original tabs, protects them from mutations and disconnects without closing the context", async () => {
  const root = await mkdtemp(join(tmpdir(), "backlinks-attach-"));
  const fake = createFakeChromium();
  const original = fake.addPage();
  let disconnected = false;
  let attached = 0;
  const runtime = createBacklinkBrowserRuntime({
    profilePath: join(root, "lock"),
    workspacePath: root,
    cdpEndpoint: "http://localhost:9222",
    loadChromium: async () => ({
      ...fake.chromium,
      connectOverCDP: async () => {
        attached++;
        return {
          contexts: () => [fake.context],
          close: async () => {
            disconnected = true;
          },
        } as never;
      },
    }),
  });
  try {
    const tabs = await runtime.execute({ action: "tabs" }, request);
    assert.equal(tabs.kind, "tabs");
    if (tabs.kind !== "tabs") assert.fail();
    assert.equal(tabs.tabs.length, 1);
    assert.equal(tabs.tabs[0]!.owned, false);
    await assert.rejects(
      runtime.execute({ action: "closePage", page: tabs.tabs[0]!.page }, request),
    );
    await assert.rejects(
      runtime.execute(
        { action: "navigate", page: tabs.tabs[0]!.page, url: "https://example.test" },
        request,
      ),
    );
    await runtime.execute(
      { action: "navigate", page: "publisher", url: "https://example.test" },
      request,
    );
    assert.equal(attached, 1);
    assert.equal(fake.launches.length, 0);
    await runtime.close();
    assert.equal(fake.isClosed(), false);
    assert.equal(original.isClosed(), false);
    assert.equal(fake.pages[1]!.isClosed(), true);
    assert.equal(disconnected, true);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("failed CDP attachment does not launch an empty browser or retain the resource lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "backlinks-attach-error-"));
  const fake = createFakeChromium();
  const options = {
    profilePath: root,
    workspacePath: root,
    cdpEndpoint: "http://127.0.0.1:9222",
    loadChromium: async () => ({
      ...fake.chromium,
      connectOverCDP: async () => {
        throw new Error("private details");
      },
    }),
  };
  try {
    for (let i = 0; i < 2; i++) {
      const runtime = createBacklinkBrowserRuntime(options);
      await assert.rejects(runtime.execute({ action: "tabs" }, request), (error: Error) => {
        assert.match(error.message, /CDP/);
        assert.doesNotMatch(error.message, /private details/);
        return true;
      });
      await runtime.close();
    }
    assert.equal(fake.launches.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
