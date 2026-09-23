import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { createBacklinkBrowserRuntime } from "../src/browser/index.js";

const executablePath = process.env.ZCODE_BACKLINKS_TEST_BROWSER || chromium.executablePath();
const request = { traceId: "fixture-trace", sessionId: "fixture-session" };

test(
  "real CDP reuses a logged-in browser and leaves its original pages alive after submission and detach",
  {
    skip: !existsSync(executablePath) && "Install Chromium or set ZCODE_BACKLINKS_TEST_BROWSER",
    timeout: 60_000,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "backlinks-real-cdp-"));
    const server = createServer((req, res) => {
      if (req.url === "/seed")
        res.setHeader("Set-Cookie", "fixtureLogin=ready; Path=/; Max-Age=3600; SameSite=Lax");
      res.setHeader("Content-Type", "text/html");
      res.end(`<h1>${req.headers.cookie?.includes("fixtureLogin=ready") ? "Already signed in" : "Sign in"}</h1>
      <button onclick="document.querySelector('p').textContent='Submitted once'">Publish</button><p>Pending</p>`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const profile = join(root, "external-profile");
    const external = await chromium.launchPersistentContext(profile, {
      executablePath,
      headless: true,
      args: ["--remote-debugging-port=0"],
    });
    const original = external.pages()[0]!;
    await original.goto(`${origin}/seed`);
    const port = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0];
    const runtime = createBacklinkBrowserRuntime({
      profilePath: join(root, "lock"),
      workspacePath: root,
      cdpEndpoint: `http://127.0.0.1:${port}`,
    });
    try {
      const tabs = await runtime.execute({ action: "tabs" }, request);
      assert.equal(tabs.kind, "tabs");
      const loaded = await runtime.execute(
        { action: "navigate", page: "publisher", url: origin },
        request,
      );
      assert.equal(loaded.kind, "page");
      if (loaded.kind === "page") assert.match(loaded.text, /Already signed in/);
      await runtime.execute(
        { action: "click", page: "publisher", selector: "role:button|Publish" },
        request,
      );
      const submitted = await runtime.execute({ action: "snapshot", page: "publisher" }, request);
      if (submitted.kind !== "page") assert.fail();
      assert.match(submitted.text, /Submitted once/);
      assert.equal(external.pages().length, 2);
      await runtime.close();
      assert.equal(original.isClosed(), false);
      assert.equal(external.pages().length, 1);
      await original.goto(origin);
      assert.match(await original.locator("h1").innerText(), /Already signed in/);
    } finally {
      await runtime.close();
      await external.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
);
