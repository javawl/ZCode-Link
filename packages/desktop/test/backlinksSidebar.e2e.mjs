import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { _electron } from "playwright-core";

const require = createRequire(import.meta.url);
const desktop = resolve(import.meta.dirname, "..");
const batches = [99, 614, 615].map((id) => ({
  id,
  name: `Fixture ${id}`,
  websiteId: id,
  websiteName: `Site ${id}`,
  websiteHost: `${id}.example`,
  plannedAt: "2026-09-21",
  executing: id === 99,
  counts: { pending: 6, executed: 4, failed: 8, skipped: 0, total: 18 },
}));

test(
  "sidebar batch tab, auth recovery, selection and task views share the existing services",
  { timeout: 120_000 },
  async () => {
    const data = await mkdtemp(join(tmpdir(), "linkagent-sidebar-e2e-"));
    const evidence = join(data, "evidence");
    await mkdir(evidence);
    console.log("Isolated sidebar evidence:", evidence);
    let writes = 0;
    let queries = 0;
    const server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.method !== "GET") {
        writes += 1;
        res.statusCode = 405;
        res.end("{}");
        return;
      }
      if (req.headers.authorization !== "Bearer valid-fixture-agent-token") {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
      if (req.url === "/api/agent/batches") {
        queries += 1;
        res.end(JSON.stringify({ batches }));
        return;
      }
      const id = Number(req.url?.split("/").at(-1));
      const batch = batches.find((value) => value.id === id);
      res.end(
        JSON.stringify({
          batch,
          website: {
            id,
            name: `Site ${id}`,
            siteUrl: `https://${id}.example`,
            siteHost: `${id}.example`,
            shortDescription: null,
            longDescription: null,
            logoUrl: null,
            screenshotUrl: null,
            keyFeatures: null,
            pricingType: null,
          },
          anchors: [],
          items: ["executed", "failed", "skipped", "pending"].map((status, index) => ({
            id: index + 1,
            sourceId: index + 1,
            sourceName: `Directory ${index}`,
            sourceHost:
              index === 2
                ? "a-very-long-publishing-directory-name-for-layout.example"
                : `${status}.example`,
            sourceUrl: `https://${status}.example`,
            status,
            submitUrl: null,
            sourceNotes: null,
            category: null,
            tags: [],
            paymentType: "free",
            linkType: "dofollow",
            failureMode: null,
            failureReason: status === "failed" ? "Fixture rejection" : null,
            publishedUrl: null,
            publishStatus: null,
            plannedAt: "2026-09-22",
          })),
        }),
      );
    });
    await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const port = server.address().port;
    const settingsDir = join(data, ".zcode/v2");
    await mkdir(settingsDir, { recursive: true });
    await writeFile(
      join(settingsDir, "backlinks.json"),
      JSON.stringify({
        version: 1,
        supermanager: {
          baseUrl: `http://127.0.0.1:${port}`,
          token: "invalid-fixture-agent-token",
        },
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
          ZCODE_DESKTOP_USER_DATA_DIR: join(data, "electron"),
          ZCODE_DESKTOP_APPLICATION_NAME: "LinkAgent Sidebar E2E",
          ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT: "1",
          ELECTRON_RENDERER_URL: "http://localhost:5174",
        },
      });
      const page = await app.firstWindow();
      page.setDefaultTimeout(25_000);
      const sidebar = page.getByTestId("sidebar");
      const tab = sidebar.getByTestId("backlinks-sidebar-tab");
      await tab.waitFor({ timeout: 60_000 });
      assert.deepEqual(await sidebar.getByRole("tab").allTextContents(), [
        "分组",
        "项目",
        "发布批次",
      ]);
      assert.equal(await page.getByTestId("backlinks-sidebar-open").count(), 0);
      await tab.click();
      let panel = page.getByTestId("backlinks-sidebar-panel");
      await panel.getByRole("alert").filter({ hasText: "Agent Token" }).waitFor();
      assert.match(await panel.getByRole("alert").innerText(), /401/);
      await panel.getByRole("button", { name: "连接与浏览器" }).click();
      const settings = page.getByTestId("backlinks-section");
      await settings
        .getByRole("group", { name: /^Supermanager/ })
        .getByLabel("访问令牌", { exact: true })
        .fill("valid-fixture-agent-token");
      await settings.getByRole("button", { name: "保存设置", exact: true }).click();
      await settings.getByRole("status").filter({ hasText: "设置已保存" }).waitFor();
      await page.getByTestId("settings-back-button").click();
      await tab.click();
      panel = page.getByTestId("backlinks-sidebar-panel");
      await panel.getByTestId("backlinks-batch-615").waitFor();
      assert.equal(await panel.locator("article").count(), 3);
      assert.equal(
        await panel.locator("article").first().getAttribute("data-testid"),
        "backlinks-batch-99",
      );
      await panel.getByRole("textbox", { name: "搜索网站、域名或批次号" }).fill("615");
      assert.equal(await panel.locator("article").count(), 1);
      await panel.getByLabel("全选当前列表", { exact: true }).click();
      await panel.getByRole("button", { name: "批量发布 (1)", exact: true }).waitFor();
      await panel.getByRole("textbox").fill("");
      await panel.getByTestId("backlinks-batch-615").getByRole("button", { name: /#615/ }).click();
      const details = panel.getByTestId("backlinks-compact-details");
      await details.waitFor();
      assert.equal(await details.getByTestId("backlinks-detail-row").count(), 4);
      assert.equal(await panel.locator("table").count(), 0);
      assert.deepEqual(await details.getByTestId("backlinks-detail-status").allTextContents(), [
        "executed",
        "failed",
        "skipped",
        "pending",
      ]);
      const layout = await details.getByTestId("backlinks-detail-row").evaluateAll((rows) =>
        rows.map((row) => {
          const host = row.querySelector('[data-testid="backlinks-detail-host"]');
          const status = row.querySelector('[data-testid="backlinks-detail-status"]');
          return {
            right: Math.round(status.getBoundingClientRect().right),
            height: row.getBoundingClientRect().height,
            color: getComputedStyle(status).color,
            ellipsis: getComputedStyle(host).textOverflow,
          };
        }),
      );
      assert.equal(new Set(layout.map((row) => row.right)).size, 1);
      assert.ok(layout.every((row) => row.height <= 20 && row.ellipsis === "ellipsis"));
      assert.notEqual(layout[0].color, layout[1].color);
      assert.equal(layout[2].color, layout[3].color);
      assert.equal(
        await panel.evaluate((element) => element.scrollWidth <= element.clientWidth),
        true,
      );
      await page.screenshot({ path: join(evidence, "sidebar-batches.png") });
      await sidebar.getByRole("tab", { name: "项目", exact: true }).click();
      assert.equal(await panel.count(), 0);
      await sidebar.getByRole("tab", { name: "分组", exact: true }).click();
      assert.equal(await panel.count(), 0);
      await tab.click();
      await panel.getByTestId("backlinks-batch-615").waitFor();
      assert.ok(queries >= 2);
      assert.equal(writes, 0, "E2E must not publish or mutate backend batches");
    } catch (error) {
      const page = app?.windows()[0];
      if (page) {
        await writeFile(join(evidence, "failure.txt"), await page.locator("body").innerText());
        await page.screenshot({ path: join(evidence, "failure.png") });
      }
      throw error;
    } finally {
      await app?.close();
      await new Promise((resolveClose) => server.close(resolveClose));
    }
  },
);
