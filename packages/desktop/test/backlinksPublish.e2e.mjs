import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  createBacklinksPublishFixture,
  PUBLISH_MODEL_ID,
  PUBLISH_COMPLETION,
} from "./fixtures/backlinksPublishServer.mjs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { _electron } from "playwright-core";

const require = createRequire(import.meta.url);
const desktop = resolve(import.meta.dirname, "..");
const modelId = PUBLISH_MODEL_ID;

test(
  "publish completes real Agent, skill, MCP, browser submission, result reporting and lease release",
  { timeout: 180_000 },
  async () => {
    const data = await mkdtemp(join(tmpdir(), "linkagent-publish-e2e-"));
    const evidence = join(data, "evidence");
    await mkdir(evidence);
    console.log("Isolated publish evidence:", evidence);
    const fixture = await createBacklinksPublishFixture(evidence);
    const baseUrl = fixture.baseUrl;
    await mkdir(join(data, ".zcode/v2"), { recursive: true });
    await writeFile(
      join(data, ".zcode/v2/backlinks.json"),
      JSON.stringify({
        version: 1,
        supermanager: { baseUrl, token: "local-fixture-token" },
        browser: { headless: true, channel: "chrome" },
      }),
      { mode: 0o600 },
    );
    let app;
    let approvalTimer;
    let approving = false;
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
          ZCODE_DESKTOP_APPLICATION_NAME: "LinkAgent Publish E2E",
          ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT: "1",
          ELECTRON_RENDERER_URL: "http://localhost:5174",
        },
      });
      const page = await app.firstWindow();
      page.setDefaultTimeout(30_000);
      // 只批准本测试脚本产生的工具调用；服务、网页和模型均指向临时 loopback fixture。
      approvalTimer = setInterval(async () => {
        if (approving) return;
        approving = true;
        try {
          const allow = page.locator('[data-permission-option-kind="allowOnce"]').first();
          if (await allow.isVisible()) await allow.click({ timeout: 500 });
        } catch {
          /* 页面关闭或审批卡片在检查后已移除。 */
        } finally {
          approving = false;
        }
      }, 150);
      await page.getByTestId("task-settings-button").waitFor({ timeout: 60_000 });
      await page.keyboard.press(process.platform === "darwin" ? "Meta+," : "Control+,");
      await page.getByTestId("settings-section-nav-modelProvider").click();
      await page.getByTestId("model-provider-template-item-custom").click();
      await page.getByTestId("model-provider-base-url-input").fill(`${baseUrl}/v1`);
      await page.getByTestId("model-provider-base-url-input").press("Tab");
      await page.getByTestId("model-provider-api-key-input").fill("local-model-placeholder");
      await page.getByTestId("model-provider-api-key-input").press("Tab");
      await page.getByTestId("model-provider-add-model-button").click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("textbox").first().fill(modelId);
      await dialog.getByRole("button", { name: /^(添加|保存|Add|Save)$/ }).click();
      await dialog.waitFor({ state: "hidden" });
      await page.getByTestId("settings-back-button").click();
      await page.getByTestId("backlinks-sidebar-tab").click();
      const row = page.getByTestId("backlinks-batch-615");
      await row.getByRole("button", { name: "发布", exact: true }).click();
      await page.waitForFunction(
        () =>
          document.body.innerText.includes("LINKAGENT_PUBLISH_ACCEPTED") ||
          document.body.innerText.includes("FOREIGN KEY constraint failed"),
        undefined,
        { timeout: 90_000 },
      );
      const text = await page.locator("body").innerText();
      assert.doesNotMatch(text, /FOREIGN KEY constraint failed/);
      assert.ok(fixture.state.modelRequests.some((request) => request.hasPublishCommand));
      assert.deepEqual(fixture.state.errors, []);
      assert.equal(fixture.state.skillLoaded, true);
      assert.equal(fixture.state.claims, 1);
      assert.equal(fixture.state.submissions, 1);
      assert.equal(fixture.state.anchorObserved, true);
      assert.equal(fixture.state.reports.length, 1);
      assert.equal(fixture.state.releases, 1);
      assert.ok(fixture.state.heartbeats > 0);
      assert.ok(fixture.state.traces.length > 0);
      const db = new DatabaseSync(join(data, "agent-sessions.sqlite"), { readOnly: true });
      try {
        assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
        assert.ok(
          db
            .prepare(
              "SELECT count(*) AS count FROM session_input i JOIN session s ON i.session_id = s.id",
            )
            .get().count > 0,
        );
      } finally {
        db.close();
      }
      assert.ok(text.includes(PUBLISH_COMPLETION));
      // 发布成功不能让侧栏跳回项目 tab，主区仍正常显示被接纳的新任务。
      assert.equal(
        await page.getByTestId("backlinks-sidebar-tab").getAttribute("aria-selected"),
        "true",
      );
      assert.equal(await page.getByTestId("backlinks-sidebar-panel").isVisible(), true);
      assert.equal(await row.isVisible(), true);
      await page.screenshot({ path: join(evidence, "accepted.png") });
    } catch (error) {
      const page = app?.windows()[0];
      if (page) {
        await writeFile(join(evidence, "failure.txt"), await page.locator("body").innerText());
        await page.screenshot({ path: join(evidence, "failure.png") });
      }
      throw error;
    } finally {
      clearInterval(approvalTimer);
      await app?.close();
      await fixture.close();
    }
  },
);
