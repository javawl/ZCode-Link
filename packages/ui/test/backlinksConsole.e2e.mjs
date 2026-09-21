import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

const here = dirname(fileURLToPath(import.meta.url));
const executablePath = process.env.ZCODE_BACKLINKS_TEST_BROWSER || chromium.executablePath();
const mime = {
  ".js": "application/javascript",
  ".css": "text/css",
  ".html": "text/html",
  ".woff2": "font/woff2",
};

test(
  "native backlink console: selection, failure recovery, admission, settings and mobile layout",
  {
    skip: !existsSync(executablePath)
      ? "Chromium is not installed; install it with playwright-core or set ZCODE_BACKLINKS_TEST_BROWSER"
      : false,
    timeout: 120_000,
  },
  async () => {
    const output = await mkdtemp(join(tmpdir(), "zcode-backlinks-ui-"));
    let browser;
    let server;
    try {
      await build({
        configFile: false,
        root: join(here, "fixtures", "backlinks"),
        plugins: [tailwindcss()],
        logLevel: "error",
        resolve: { alias: { "@": resolve(here, "../src") } },
        define: {
          __ZCODE_VERSION__: JSON.stringify("test"),
          __ZCODE_ENV__: JSON.stringify("test"),
          __ZCODE_COMMIT__: JSON.stringify("test"),
        },
        build: { outDir: output, emptyOutDir: true },
      });
      server = createServer(async (request, response) => {
        const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
        const path = resolve(output, `.${pathname === "/" ? "/index.html" : pathname}`);
        if (!path.startsWith(`${output}${sep}`)) {
          response.writeHead(403).end();
          return;
        }
        try {
          response.setHeader("content-type", mime[extname(path)] ?? "application/octet-stream");
          response.end(await readFile(path));
        } catch {
          response.writeHead(404).end();
        }
      });
      await new Promise((done) => server.listen(0, "127.0.0.1", done));
      browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
      const page = await browser.newPage({
        viewport: { width: 1100, height: 850 },
        locale: "zh-CN",
      });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.getByRole("checkbox", { name: "选择批次 #389 389.example" }).waitFor();
      assert.deepEqual(
        await page
          .getByRole("checkbox", { name: /^选择批次/ })
          .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label"))),
        ["选择批次 #389 389.example", "选择批次 #100 100.example", "选择批次 #99 99.example"],
      );
      await page.getByRole("button", { name: /#389 389.example/ }).click();
      await page.getByText("executed", { exact: true }).waitFor();
      const successColor = await page
        .getByText("executed", { exact: true })
        .evaluate((node) => getComputedStyle(node).color);
      const failedColor = await page
        .getByText("failed", { exact: true })
        .evaluate((node) => getComputedStyle(node).color);
      assert.notEqual(successColor, failedColor);
      await page.evaluate(() => {
        document.documentElement.className = "theme-zai-dark dark";
      });
      assert.notEqual(
        await page
          .getByText("executed", { exact: true })
          .evaluate((node) => getComputedStyle(node).color),
        successColor,
      );
      await page.evaluate(() => {
        document.documentElement.className = "theme-zai-light";
      });
      await page.getByRole("checkbox", { name: "选择批次 #99 99.example" }).check();
      await page.getByRole("textbox", { name: "搜索网站、域名或批次号" }).fill("389");
      await page.getByRole("checkbox", { name: "全选当前筛选结果" }).check();
      await page.getByRole("button", { name: "批量发布 (2)", exact: true }).waitFor();
      await page.evaluate(() => {
        window.backlinksTest.failPublish = true;
      });
      await page.getByRole("button", { name: "批量发布 (2)", exact: true }).click();
      await page.getByRole("alert").filter({ hasText: "Test admission failed" }).waitFor();
      assert.equal(
        await page.getByRole("checkbox", { name: "全选当前筛选结果" }).isChecked(),
        true,
      );
      await page.evaluate(() => {
        window.backlinksTest.failPublish = false;
        window.backlinksTest.holdPublish = true;
      });
      await page.getByRole("button", { name: "批量发布 (2)", exact: true }).click();
      await page.getByRole("button", { name: "正在创建任务…", exact: true }).waitFor();
      assert.equal(
        await page.getByRole("checkbox", { name: "全选当前筛选结果" }).isDisabled(),
        true,
      );
      await page.waitForFunction(() => window.backlinksTest.holding);
      await page.evaluate(() => window.backlinksTest.release());
      await page.getByRole("button", { name: "批量发布 (0)", exact: true }).waitFor();
      assert.deepEqual(await page.evaluate(() => window.backlinksTest.messages), [
        "/backlink-publish 389 99\n请按以上批次号顺序依次发布，仅处理这些批次。",
      ]);
      assert.deepEqual(await page.evaluate(() => window.backlinksTest.opened), ["test-task"]);
      await page.getByRole("button", { name: "连接与浏览器", exact: true }).click();
      assert.deepEqual(
        await page
          .locator('input[type="password"]')
          .evaluateAll((nodes) => nodes.map((node) => node.value)),
        ["", ""],
      );
      await page.getByRole("button", { name: "保存设置", exact: true }).click();
      await page.getByRole("status").filter({ hasText: "设置已保存" }).waitFor();
      const saved = await page.evaluate(() => window.backlinksTest.settingsPatches[0]);
      assert.equal(Object.hasOwn(saved.supermanager, "token"), false);
      assert.equal(Object.hasOwn(saved.cloudMail, "token"), false);
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        true,
      );
      await page.locator('input[type="password"]').first().fill("test-only-replacement");
      await page.getByRole("button", { name: "保存设置", exact: true }).click();
      assert.equal(await page.locator('input[type="password"]').first().inputValue(), "");
      assert.equal(
        await page.evaluate(() => window.backlinksTest.settingsPatches[1].supermanager.token),
        "test-only-replacement",
      );
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      if (server) await new Promise((done) => server.close(done));
      await rm(output, { recursive: true, force: true });
    }
  },
);
