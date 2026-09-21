import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveZCodeCustomCommandPrompt } from "../src/custom-command-prompt.js";
import { listProtocolSlashCommands } from "../src/zcode-protocol/slash-commands.js";

test("Web/Desktop prompt resolver seeds and expands /backlink-publish only when enabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-backlinks-prompt-"));
  const projectConfigPath = join(root, "config.json");
  const config = {
    storage: { dir: root },
    plugins: {
      enabled: true,
      enabledPlugins: { "backlinks@zcode-plugins-official": true },
    },
  };
  const options = {
    projectConfigPath,
    skipUserConfig: true,
    homeDirectory: root,
    workingDirectory: root,
    env: { HOME: root },
  };
  try {
    await writeFile(projectConfigPath, JSON.stringify(config));
    const prompt = await resolveZCodeCustomCommandPrompt("/backlink-publish 321, 320", options);
    assert.ok(prompt, "The prompt must resolve through the native command loader");
    assert.match(prompt, /Required skills: `backlinks:backlink-publish`/);
    assert.match(prompt, /321, 320/);
    assert.equal(prompt.includes("$ARGUMENTS"), false);
    const catalog = await listProtocolSlashCommands(options);
    assert.ok(
      catalog.some(({ name, source }) => name === "backlink-publish" && source === "custom"),
    );
    const seededRoot = join(
      root,
      "cli",
      "plugins",
      "cache",
      "zcode-plugins-official",
      "backlinks",
      "0.1.0",
    );
    assert.match(
      await readFile(join(seededRoot, "docs", "browser.md"), "utf8"),
      /backlinks_browser/,
    );
    assert.match(
      await readFile(join(seededRoot, "commands", "backlink-publish.md"), "utf8"),
      /\$ARGUMENTS/,
    );

    config.plugins.enabledPlugins["backlinks@zcode-plugins-official"] = false;
    await writeFile(projectConfigPath, JSON.stringify(config));
    assert.equal(
      await resolveZCodeCustomCommandPrompt("/backlink-publish 321", options),
      undefined,
    );
    assert.equal(
      (await listProtocolSlashCommands(options)).some(({ name }) => name === "backlink-publish"),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
