import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createBacklinksRuntime } from "../src/node.js";

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
