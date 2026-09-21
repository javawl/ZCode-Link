import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { createBacklinkBrowserRuntime } from "../src/browser/index.js";

const executablePath = chromium.executablePath();
const request = { traceId: "trace-local-fixture", sessionId: "session-local-fixture" };

test(
  "local Chromium handles forms, iframe, popup, file upload and login cookie persistence",
  {
    skip:
      !existsSync(executablePath) &&
      "Install Playwright Chromium to run this local integration test",
    timeout: 60_000,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-backlinks-local-"));
    const workspacePath = join(root, "workspace");
    await mkdir(workspacePath);
    await writeFile(join(workspacePath, "logo.txt"), "local-fixture-only");
    const server = createServer((incoming, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      if (incoming.url === "/seed")
        response.setHeader("Set-Cookie", "fixtureSession=ready; Max-Age=3600; SameSite=Lax");
      if (incoming.url === "/frame") {
        response.end(
          '<label>Comment<input></label><a href="https://example.test/">Example target</a>',
        );
        return;
      }
      response.end(`<!doctype html><html><body>
      <h1>${incoming.headers.cookie?.includes("fixtureSession=ready") ? "Session ready" : "Fixture page"}</h1>
      <label>Name<input name="name"></label>
      <label>Category<select><option value="tools">Tools</option></select></label>
      <label>Logo<input type="file" onchange="document.getElementById('upload').textContent=this.files[0].name"></label>
      <p id="upload">No file selected</p>
      <button onclick="document.getElementById('result').textContent='Submitted once'">Submit</button>
      <p id="result">Not submitted</p>
      <a href="/oauth" target="_blank">Continue with fixture</a>
      <iframe title="Comments" src="/frame"></iframe>
      </body></html>`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const options = {
      profilePath: join(root, "profile"),
      workspacePath,
      headless: true,
      executablePath,
    };
    const browser = createBacklinkBrowserRuntime(options);
    const reopened = createBacklinkBrowserRuntime(options);
    try {
      await browser.execute(
        { action: "navigate", page: "publish", url: `${baseUrl}/seed` },
        request,
      );
      await browser.execute(
        { action: "fill", page: "publish", selector: "label:Name", value: "Demo Tool" },
        request,
      );
      await browser.execute(
        { action: "select", page: "publish", selector: "label:Category", value: "tools" },
        request,
      );
      await browser.execute(
        { action: "upload", page: "publish", selector: "label:Logo", files: ["logo.txt"] },
        request,
      );
      await browser.execute(
        {
          action: "fill",
          page: "publish",
          selector: 'frame(iframe[title="Comments"])>>label:Comment',
          value: "Useful content",
        },
        request,
      );
      const form = await browser.execute(
        { action: "snapshot", page: "publish", format: "aria" },
        request,
      );
      assert.equal(form.kind, "page");
      if (form.kind !== "page") assert.fail("expected page snapshot");
      assert.match(form.text, /Demo Tool/u);
      assert.match(form.text, /logo\.txt/u);
      await browser.execute(
        { action: "click", page: "publish", selector: "role:button|Submit" },
        request,
      );
      await browser.execute(
        { action: "waitFor", page: "publish", selector: "text:Submitted once" },
        request,
      );
      await browser.execute(
        { action: "click", page: "publish", selector: "role:link|Continue with fixture" },
        request,
      );
      const tabs = await browser.execute({ action: "tabs" }, request);
      assert.equal(tabs.kind, "tabs");
      if (tabs.kind !== "tabs") assert.fail("expected tabs");
      const popup = tabs.tabs.find((tab) => tab.openerPage === "publish");
      assert.ok(popup, "popup must retain its explicit source tab");
      await browser.execute(
        { action: "waitFor", page: popup.page, url: `${baseUrl}/oauth` },
        request,
      );
      const image = await browser.execute({ action: "screenshot", page: "publish" }, request);
      assert.equal(image.kind, "screenshot");
      if (image.kind !== "screenshot") assert.fail("expected PNG");
      assert.equal(Buffer.from(image.pngBase64, "base64").subarray(1, 4).toString(), "PNG");
      await browser.close();
      const persisted = await reopened.execute(
        { action: "navigate", page: "resumed", url: baseUrl },
        request,
      );
      assert.equal(persisted.kind, "page");
      if (persisted.kind !== "page") assert.fail("expected resumed page");
      assert.match(persisted.text, /Session ready/u);
    } finally {
      await browser.close();
      await reopened.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(root, { recursive: true, force: true });
    }
  },
);
