import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createBacklinksRuntime } from "../src/node.js";

test("browser reuse settings accept a dedicated profile or local CDP and reject ambiguous targets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "backlinks-browser-config-"));
  try {
    const runtime = createBacklinksRuntime({ dataBaseDir: dir, env: {} });
    const saved = await runtime.updateSettings({
      browser: { cdpEndpoint: "http://localhost:9222/", userDataDir: "" },
    });
    assert.equal(saved.browser.cdpEndpoint, "http://127.0.0.1:9222");
    for (const cdpEndpoint of [
      "https://remote.test",
      "http://127.0.0.1:9222/path",
      "http://user:secret@127.0.0.1:9222",
      "http://127.0.0.1:9222?key=secret",
    ])
      await assert.rejects(runtime.updateSettings({ browser: { cdpEndpoint } }));
    await assert.rejects(
      runtime.updateSettings({ browser: { userDataDir: join(dir, "profile") } }),
    );
    assert.equal((await runtime.getSettings()).browser.userDataDir || "", "");
    const profile = await runtime.updateSettings({
      browser: { cdpEndpoint: "", userDataDir: join(dir, "profile") },
    });
    assert.equal(profile.browser.userDataDir, join(dir, "profile"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("correcting an unauthorized Agent Token recovers the same runtime without exposing credentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "backlinks-auth-"));
  const requests: string[] = [];
  try {
    const runtime = createBacklinksRuntime({
      dataBaseDir: dir,
      env: {},
      fetch: async (_url, init) => {
        const authorization = new Headers(init?.headers).get("authorization") ?? "";
        requests.push(init?.method ?? "GET");
        return authorization === "Bearer valid-agent-token"
          ? Response.json({ batches: [] })
          : Response.json({ error: "Unauthorized" }, { status: 401 });
      },
    });
    await runtime.updateSettings({
      supermanager: { baseUrl: "https://batches.test", token: "wrong-agent-token" },
    });
    await assert.rejects(runtime.listBatches(), (error: unknown) => {
      assert.equal((error as { code: string }).code, "BACKLINKS_UNAUTHORIZED");
      assert.match((error as Error).message, /Agent Token/);
      assert.doesNotMatch((error as Error).message, /wrong-agent-token/);
      return true;
    });
    assert.deepEqual(requests, ["GET"], "authentication failure must not be retried");
    await runtime.updateSettings({ supermanager: { token: "valid-agent-token" } });
    assert.deepEqual(await runtime.listBatches(), []);
    assert.doesNotMatch(JSON.stringify(await runtime.getSettings()), /valid-agent-token/);
    assert.deepEqual(requests, ["GET", "GET"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("settings are shared, atomic, secret-redacted, hot-reloaded and preserve blank tokens", async () => {
  const dir = await mkdtemp(join(tmpdir(), "backlinks-config-"));
  try {
    const env = {
      SUPERMANAGER_TOKEN: "legacy",
      ZCODE_BACKLINKS_SUPERMANAGER_TOKEN: "preferred",
      ZCODE_BACKLINKS_MAILBOX_DOMAIN: "mail.test",
    };
    const first = createBacklinksRuntime({ dataBaseDir: dir, env });
    const second = createBacklinksRuntime({ dataBaseDir: dir, env });
    assert.equal((await first.getSettings()).supermanager.tokenConfigured, true);
    await first.updateSettings({
      supermanager: { baseUrl: "https://sm.test", token: "saved-token" },
    });
    await second.updateSettings({
      supermanager: { token: "  " },
      cloudMail: { baseUrl: "https://mail.test/api", token: "mail-token" },
    });
    const snapshot = await first.getSettings();
    assert.equal(snapshot.cloudMail.baseUrl, "https://mail.test/api");
    assert.equal(JSON.stringify(snapshot).includes("saved-token"), false);
    assert.equal(snapshot.mailboxDomain, "mail.test");
    const path = join(dir, ".zcode", "v2", "backlinks.json");
    assert.equal(JSON.parse(await readFile(path, "utf8")).supermanager.token, "saved-token");
    if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
    await Promise.all([
      first.updateSettings({ mailboxDomain: "other.test" }),
      second.updateSettings({ browser: { headless: true } }),
    ]);
    const latest = await first.getSettings();
    assert.equal(latest.mailboxDomain, "other.test");
    assert.equal(latest.browser.headless, true);
    await assert.rejects(first.updateSettings({ supermanager: { baseUrl: "javascript:bad" } }));
    assert.equal((await second.getSettings()).supermanager.baseUrl, "https://sm.test");
    await first.updateSettings({ supermanager: { clearToken: true } });
    assert.equal((await first.getSettings()).supermanager.tokenConfigured, false);
    await writeFile(path, "{invalid");
    await assert.rejects(first.getSettings(), { code: "BACKLINKS_INVALID_REQUEST" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("independent processes preserve each other's settings updates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "backlinks-processes-"));
  const moduleUrl = new URL("../src/node.ts", import.meta.url).href;
  const cwd = fileURLToPath(new URL("../../../", import.meta.url));
  const update = (patch: unknown) =>
    new Promise<void>((resolve, reject) => {
      const source = `import {createBacklinksRuntime} from ${JSON.stringify(moduleUrl)}; await createBacklinksRuntime({dataBaseDir:${JSON.stringify(dir)},env:{}}).updateSettings(${JSON.stringify(patch)});`;
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "--eval", source],
        { cwd, stdio: ["ignore", "ignore", "pipe"] },
      );
      let error = "";
      child.stderr.on("data", (data) => {
        error += String(data);
      });
      child.once("error", reject);
      child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(error))));
    });
  try {
    const first = createBacklinksRuntime({ dataBaseDir: dir, env: {} });
    await first.updateSettings({});
    await writeFile(
      join(dir, ".zcode", "v2", "backlinks.json.lock"),
      JSON.stringify({ pid: 2147483647, hostname: hostname(), token: "dead-owner" }),
    );
    await Promise.all([
      update({ supermanager: { baseUrl: "https://sm.test", token: "secret" } }),
      update({
        cloudMail: { baseUrl: "https://mail.test/api", token: "mail-secret" },
        mailboxDomain: "mail.test",
      }),
    ]);
    const settings = await createBacklinksRuntime({ dataBaseDir: dir, env: {} }).getSettings();
    assert.equal(settings.supermanager.baseUrl, "https://sm.test");
    assert.equal(settings.cloudMail.baseUrl, "https://mail.test/api");
    assert.equal(settings.mailboxDomain, "mail.test");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("browser display mode defaults to visible and maps the legacy headless flag", async () => {
  const dir = await mkdtemp(join(tmpdir(), "backlinks-display-mode-"));
  try {
    const runtime = createBacklinksRuntime({ dataBaseDir: dir, env: {} });
    const initial = await runtime.getSettings();
    assert.equal(initial.browser.displayMode, "visible");
    assert.equal(initial.browser.headless, false);
    const path = join(dir, ".zcode", "v2", "backlinks.json");
    await runtime.updateSettings({});
    await writeFile(path, JSON.stringify({ version: 1, browser: { headless: true } }));
    const legacy = await runtime.getSettings();
    assert.equal(legacy.browser.displayMode, "headless");
    assert.equal(legacy.browser.headless, true);
    // 只发送 headless 的旧客户端：false 表示从无窗口回到默认可见。
    const legacyWindowed = await runtime.updateSettings({ browser: { headless: false } });
    assert.equal(legacyWindowed.browser.displayMode, "visible");
    assert.equal(legacyWindowed.browser.headless, false);
    const visible = await runtime.updateSettings({ browser: { displayMode: "visible" } });
    assert.equal(visible.browser.displayMode, "visible");
    assert.equal(visible.browser.headless, false);
    const stored = JSON.parse(await readFile(path, "utf8"));
    // 默认可见不写字段，旧版本读取同一文件不会因为新字段失败。
    assert.equal("displayMode" in stored.browser, false);
    assert.equal(stored.browser.headless, false);
    const background = await runtime.updateSettings({ browser: { displayMode: "background" } });
    assert.equal(background.browser.displayMode, "background");
    // 静默后台显式持久化，缺省（可见）不会被误读为后台。
    const backgroundFile = JSON.parse(await readFile(path, "utf8"));
    assert.equal(backgroundFile.browser.displayMode, "background");
    assert.equal(backgroundFile.browser.headless, false);
    await runtime.updateSettings({ browser: { displayMode: "headless" } });
    const headlessFile = JSON.parse(await readFile(path, "utf8"));
    assert.equal("displayMode" in headlessFile.browser, false);
    assert.equal(headlessFile.browser.headless, true);
    assert.equal((await runtime.getSettings()).browser.displayMode, "headless");
    await runtime.updateSettings({ browser: { displayMode: "background" } });
    await assert.rejects(
      runtime.updateSettings({ browser: { displayMode: "offscreen" as never } }),
      { code: "BACKLINKS_INVALID_REQUEST" },
    );
    assert.equal((await runtime.getSettings()).browser.displayMode, "background");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("settings files from newer versions keep unknown fields readable and preserved", async () => {
  const dir = await mkdtemp(join(tmpdir(), "backlinks-forward-compat-"));
  try {
    const runtime = createBacklinksRuntime({ dataBaseDir: dir, env: {} });
    await runtime.updateSettings({});
    const path = join(dir, ".zcode", "v2", "backlinks.json");
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        futureTopLevel: { enabled: true },
        browser: { channel: "chrome", futureBrowserOption: "kept" },
      }),
    );
    assert.equal((await runtime.getSettings()).browser.channel, "chrome");
    await runtime.updateSettings({ mailboxDomain: "mail.test" });
    const stored = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(stored.futureTopLevel, { enabled: true });
    assert.equal(stored.browser.futureBrowserOption, "kept");
    assert.equal(
      "futureBrowserOption" in (await runtime.getSettings()).browser,
      false,
      "unknown fields never leak into snapshots",
    );
    await assert.rejects(
      runtime.updateSettings({ browser: { futureBrowserOption: "x" } as never }),
      { code: "BACKLINKS_INVALID_REQUEST" },
      "user input stays strictly validated",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("browser launch flags remain opt-in and cannot override the dedicated profile", async () => {
  const dir = await mkdtemp(join(tmpdir(), "backlinks-browser-settings-"));
  try {
    const runtime = createBacklinksRuntime({ dataBaseDir: dir, env: {} });
    const initial = await runtime.getSettings();
    assert.deepEqual(initial.browser.launchArgs, []);
    assert.deepEqual(initial.browser.ignoreDefaultArgs, []);
    await runtime.updateSettings({
      browser: { windowPosition: "-32000,-32000", ignoreDefaultArgs: ["--enable-automation"] },
    });
    assert.equal((await runtime.getSettings()).browser.windowPosition, "-32000,-32000");
    for (const browser of [
      { launchArgs: ["--user-data-dir=/private"] },
      { ignoreDefaultArgs: ["--profile-directory"] },
      { windowPosition: "Infinity,0" },
    ]) {
      await assert.rejects(runtime.updateSettings({ browser }), {
        code: "BACKLINKS_INVALID_REQUEST",
      });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
