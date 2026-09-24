import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  createBacklinksPublishFixture,
  PUBLISH_DEFAULT_MODEL_ID,
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
  "publish completes real parent and publishing subagent, MCP, browser submission, result reporting and lease release",
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
      await page.getByTestId("task-settings-button").waitFor({ timeout: 60_000 });
      await page.keyboard.press(process.platform === "darwin" ? "Meta+," : "Control+,");
      await page.getByTestId("settings-section-nav-modelProvider").click();
      await page.getByTestId("model-provider-template-item-custom").click();
      await page.getByTestId("model-provider-base-url-input").fill(`${baseUrl}/v1`);
      await page.getByTestId("model-provider-base-url-input").press("Tab");
      await page.getByTestId("model-provider-api-key-input").fill("local-model-placeholder");
      await page.getByTestId("model-provider-api-key-input").press("Tab");
      for (const nextModelId of [modelId, PUBLISH_DEFAULT_MODEL_ID]) {
        await page.getByTestId("model-provider-add-model-button").click();
        const dialog = page.getByRole("dialog");
        const modelIdInput = dialog.getByRole("textbox").first();
        await modelIdInput.fill(nextModelId);
        await modelIdInput.press("Tab");
        await dialog.getByRole("button", { name: /^(添加|保存|Add|Save)$/ }).click();
        await page
          .locator(`[data-testid^="model-row-"][data-testid$="-${nextModelId}"]`)
          .waitFor({ timeout: 60_000 });
        await dialog.waitFor({ state: "hidden", timeout: 60_000 });
      }
      const defaultModelRow = page.locator(
        `[data-testid^="model-row-"][data-testid$="-${PUBLISH_DEFAULT_MODEL_ID}"]`,
      );
      await defaultModelRow.getByRole("button", { name: "设为默认模型", exact: true }).click();
      await defaultModelRow.getByText("默认", { exact: true }).waitFor();
      await page.getByTestId("settings-back-button").click();
      assert.equal(
        await page.getByTestId("backlinks-sidebar-tab").getAttribute("aria-selected"),
        "true",
      );
      const row = page.getByTestId("backlinks-batch-615");
      await row.getByRole("button", { name: "发布", exact: true }).click();
      const scopeQuestion = page.getByRole("listbox", {
        name: "本次执行哪些条目范围？",
      });
      await scopeQuestion.waitFor({ state: "visible", timeout: 90_000 });
      const permissionStatus = page.getByTestId("chat-mode-select-trigger");
      assert.equal(await permissionStatus.getAttribute("data-permission-mode"), "yolo");
      assert.equal(await permissionStatus.getAttribute("data-permission-mutable"), "false");
      assert.equal(await page.locator('[data-testid^="chat-mode-select-item"]').count(), 0);
      assert.equal(fixture.state.claims, 0, "the runtime must not claim before both answers");
      assert.equal(await scopeQuestion.getByRole("option").count(), 2);
      await scopeQuestion.getByRole("option", { name: /全部可执行（推荐）/ }).click();
      const modeQuestion = page.getByRole("listbox", {
        name: "本次采用哪种执行模式？",
      });
      await modeQuestion.waitFor({ state: "visible" });
      assert.equal(fixture.state.claims, 0, "the second question must still block the claim");
      assert.equal(await modeQuestion.getByRole("option").count(), 2);
      await modeQuestion.getByRole("option", { name: /智能匹配（推荐）/ }).click();
      await page.waitForFunction(
        () =>
          document.body.innerText.includes("LINKAGENT_PUBLISH_ACCEPTED") ||
          document.body.innerText.includes("FOREIGN KEY constraint failed"),
        undefined,
        { timeout: 90_000 },
      );
      const text = await page.locator("body").innerText();
      assert.equal(
        await page.locator("[data-permission-option-kind]").count(),
        0,
        "Backlinks MCP calls must not create a permission dialog in fixed full-access mode",
      );
      assert.doesNotMatch(text, /FOREIGN KEY constraint failed/);
      assert.ok(
        fixture.state.modelRequests.some(
          (request) => request.hasPublishCommand && request.model === PUBLISH_DEFAULT_MODEL_ID,
        ),
      );
      assert.deepEqual(fixture.state.errors, []);
      assert.equal(fixture.state.skillLoaded, true);
      assert.equal(fixture.state.questionsAsked, true);
      assert.equal(fixture.state.answersObserved, true);
      assert.equal(fixture.state.claims, 1);
      assert.equal(fixture.state.agentsLaunched, 1);
      assert.equal(fixture.state.childCompleted, true);
      assert.ok(fixture.state.childToolSets.length > 0);
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
        assert.equal(
          db.prepare("SELECT count(*) AS count FROM session WHERE parent_id IS NOT NULL").get()
            .count,
          1,
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
      await app?.close();
      await fixture.close();
    }
  },
);
