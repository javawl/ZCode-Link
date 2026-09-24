// 先运行 pnpm dev:desktop:test（5174），本测试启动独立的 Electron / 空白数据目录。
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { _electron } from "playwright-core";

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, "../../..");
const desktop = join(root, "packages/desktop");

async function assertNoCommerce(page) {
  const visibleText = await page.locator("body").innerText();
  assert.doesNotMatch(
    visibleText,
    /Start Plan|Coding Plan|升级套餐|购买套餐|支付|充值|Upgrade plan|Buy plan/i,
  );
}

test(
  "signed-out desktop: workspace, custom model settings, persistence and backlinks",
  { timeout: 180_000 },
  async () => {
    const data = await mkdtemp(join(tmpdir(), "linkagent-e2e-"));
    const evidence = join(data, "evidence");
    await mkdir(evidence);
    console.log("Isolated E2E data and evidence:", data);
    let app;
    const launch = async () => {
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
          ZCODE_DESKTOP_USER_DATA_DIR: join(data, "electron"),
          ZCODE_DESKTOP_APPLICATION_NAME: "LinkAgent E2E",
          ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT: "1",
          ELECTRON_RENDERER_URL: "http://localhost:5174",
        },
      });
      const page = await app.firstWindow();
      page.setDefaultTimeout(30_000);
      return page;
    };
    const openModels = async (page) => {
      await page.keyboard.press(process.platform === "darwin" ? "Meta+," : "Control+,");
      await page.getByTestId("settings-page").waitFor();
      await page.getByTestId("settings-section-nav-modelProvider").click();
      await page.getByTestId("model-provider-add-provider-button").waitFor();
      await assertNoCommerce(page);
    };
    try {
      let page = await launch();
      await page.getByTestId("task-settings-button").waitFor({ timeout: 60_000 });
      assert.equal(await page.title(), "LinkAgent");
      assert.equal(await page.getByTestId("onboarding-page").count(), 0);
      assert.equal(await page.getByTestId("login-use-api-key-button").count(), 0);
      await page.screenshot({ path: join(evidence, "01-workspace.png") });
      await page.getByTestId("login-trigger").click();
      await assertNoCommerce(page);
      await page.getByTestId("login-menu-item").click();
      await page.getByTestId("login-back-to-workspace").click();
      await page.getByTestId("task-settings-button").waitFor();
      await openModels(page);
      await page.getByTestId("model-provider-add-provider-button").click();
      await assertNoCommerce(page);
      await page.getByTestId("model-provider-template-item-custom").click();
      const endpoint = page.getByTestId("model-provider-base-url-input");
      await endpoint.fill("http://127.0.0.1:18765/v1");
      await endpoint.press("Tab");
      const key = page.getByTestId("model-provider-api-key-input");
      await key.fill("linkagent-local-e2e-placeholder");
      await key.press("Tab");
      await page.getByTestId("model-provider-add-model-button").click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("textbox").first().fill("linkagent-test-model");
      await dialog.getByRole("button", { name: /^(添加|保存|Add|Save)$/ }).click();
      await dialog.waitFor({ state: "hidden" });
      await page.getByText("linkagent-test-model", { exact: true }).first().waitFor();
      await page.screenshot({ path: join(evidence, "02-custom-model.png") });
      await app.close();
      page = await launch();
      await page.getByTestId("task-settings-button").waitFor({ timeout: 60_000 });
      await openModels(page);
      await page
        .getByTestId(/^model-provider-nav-item-custom/)
        .last()
        .click();
      assert.equal(
        await page.getByTestId("model-provider-base-url-input").inputValue(),
        "http://127.0.0.1:18765/v1",
      );
      await page.getByText("linkagent-test-model", { exact: true }).first().waitFor();
      await page.getByTestId("model-provider-actions-button").click();
      await page.getByRole("menuitem", { name: /^(删除|Delete)$/ }).click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: /删除|Delete/ })
        .click();
      await page.getByTestId("settings-section-nav-backlinks").click();
      await page
        .getByText(/连接与浏览器|Connections/)
        .first()
        .waitFor();
      await page.screenshot({ path: join(evidence, "03-backlinks.png") });
      assert.deepEqual(
        await page.locator('[data-testid^="settings-section-nav-"]').allTextContents(),
        ["常规", "外观", "模型设置", "外链发布"],
      );
      assert.equal(await page.getByTestId("settings-section-nav-usage").count(), 0);
      await assertNoCommerce(page);
      await app.close();
      page = await launch();
      await page.getByTestId("task-settings-button").waitFor({ timeout: 60_000 });
      assert.equal(await page.getByTestId("onboarding-page").count(), 0);
    } catch (error) {
      const page = app?.windows()[0];
      if (page) {
        await writeFile(join(evidence, "failure.txt"), await page.locator("body").innerText());
        await page.screenshot({ path: join(evidence, "failure.png") });
      }
      throw error;
    } finally {
      await app?.close();
    }
  },
);
