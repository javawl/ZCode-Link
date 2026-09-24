import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { _electron } from "playwright-core";
import {
  createBacklinksPublishFixture,
  PUBLISH_MODEL_ID,
} from "./fixtures/backlinksPublishServer.mjs";

const require = createRequire(import.meta.url);
const desktop = resolve(import.meta.dirname, "..");

test(
  "executing batch stop cancels its background agent before releasing the session lease",
  { timeout: 240_000 },
  async () => {
    const data = await mkdtemp(join(tmpdir(), "linkagent-stop-e2e-"));
    const evidence = join(data, "evidence");
    await mkdir(evidence);
    console.log("Isolated stop evidence:", evidence);
    const fixture = await createBacklinksPublishFixture(evidence, {
      pauseChildBeforeFirstTool: true,
    });
    await mkdir(join(data, ".zcode/v2"), { recursive: true });
    await writeFile(
      join(data, ".zcode/v2/backlinks.json"),
      JSON.stringify({
        version: 1,
        supermanager: { baseUrl: fixture.baseUrl, token: "local-fixture-token" },
        browser: { headless: true, channel: "chrome" },
      }),
      { mode: 0o600 },
    );
    let app;
    try {
      app = await _electron.launch({
        executablePath: require("electron"),
        args: [desktop],
        cwd: desktop,
        env: {
          ...process.env,
          ZCODE_ENV: "test",
          ZCODE_DATA_BASE_DIR: data,
          ZCODE_DESKTOP_HOME_DIR: data,
          ZCODE_HOME: join(data, ".zcode"),
          ZCODE_SESSION_DB_PATH: join(data, "agent-sessions.sqlite"),
          ZCODE_STORAGE_DIR: join(data, "agent-storage"),
          ZCODE_DESKTOP_USER_DATA_DIR: join(data, "electron"),
          ZCODE_DESKTOP_APPLICATION_NAME: "LinkAgent Stop E2E",
          ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT: "1",
          ELECTRON_RENDERER_URL: "http://localhost:5174",
        },
      });
      const page = await app.firstWindow();
      page.setDefaultTimeout(30_000);
      await page.getByTestId("task-settings-button").waitFor({ timeout: 120_000 });
      await page.keyboard.press(process.platform === "darwin" ? "Meta+," : "Control+,");
      await page.getByTestId("settings-section-nav-modelProvider").click();
      await page.getByTestId("model-provider-template-item-custom").click();
      await page.getByTestId("model-provider-base-url-input").fill(`${fixture.baseUrl}/v1`);
      await page.getByTestId("model-provider-base-url-input").press("Tab");
      await page.getByTestId("model-provider-api-key-input").fill("local-model-placeholder");
      await page.getByTestId("model-provider-api-key-input").press("Tab");
      await page.getByTestId("model-provider-add-model-button").click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("textbox").first().fill(PUBLISH_MODEL_ID);
      await dialog.getByRole("button", { name: /^(添加|保存|Add|Save)$/ }).click();
      await dialog.waitFor({ state: "hidden" });
      await page.getByTestId("settings-back-button").click();

      const panel = page.getByTestId("backlinks-sidebar-panel");
      const row = panel.getByTestId("backlinks-batch-615");
      await row.getByRole("button", { name: "发布", exact: true }).click();
      await page
        .getByRole("listbox", { name: "本次执行哪些条目范围？" })
        .getByRole("option", { name: /全部可执行（推荐）/ })
        .click();
      await page
        .getByRole("listbox", { name: "本次采用哪种执行模式？" })
        .getByRole("option", { name: /智能匹配（推荐）/ })
        .click();
      await waitFor(() => fixture.state.claims === 1 && fixture.state.childWaiting, 90_000);

      await panel.getByRole("button", { name: "刷新", exact: true }).click();
      const stop = row.getByRole("button", { name: "停止", exact: true });
      await stop.waitFor();
      await stop.click();
      await waitFor(() => fixture.state.childCancelled && fixture.state.releases === 1, 60_000);
      await row.getByRole("button", { name: "发布", exact: true }).waitFor();

      assert.equal(fixture.state.submissions, 0);
      assert.equal(fixture.state.reports.length, 0);
      assert.deepEqual(fixture.state.errors, []);
      await page.screenshot({ path: join(evidence, "stopped.png") });
    } catch (error) {
      const page = app?.windows()[0];
      if (page) {
        await writeFile(join(evidence, "failure.txt"), await page.locator("body").innerText());
        await page.screenshot({ path: join(evidence, "failure.png") });
      }
      throw error;
    } finally {
      await app?.close();
      await fixture.close();
    }
  },
);

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for fixture state");
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
}
