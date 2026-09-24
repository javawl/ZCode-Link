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
    assert.match(prompt, /AskUserQuestion/);
    assert.match(prompt, /执行范围/);
    assert.match(prompt, /执行模式/);
    assert.match(prompt, /不得调用 `batch_claim`/);
    assert.match(prompt, /backlinks:backlink-publisher/);
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
    const seededCommand = await readFile(
      join(seededRoot, "commands", "backlink-publish.md"),
      "utf8",
    );
    assert.match(seededCommand, /\$ARGUMENTS/);
    assert.match(seededCommand, /AskUserQuestion/);
    const seededSkill = await readFile(
      join(seededRoot, "skills", "backlink-publish", "SKILL.md"),
      "utf8",
    );
    assert.match(seededSkill, /"question": "本次执行哪些条目范围？"/);
    assert.match(seededSkill, /"question": "本次采用哪种执行模式？"/);
    assert.match(seededSkill, /两项回答都存在且可解析之前，不得调用 `batch_claim`/);
    assert.match(seededSkill, /最多 3 个并发槽/);
    assert.match(seededSkill, /backlinks:backlink-publisher/);
    assert.doesNotMatch(seededSkill, /未指定时使用上述默认值/);
    const seededAgent = await readFile(
      join(seededRoot, "agents", "backlink-publisher.md"),
      "utf8",
    );
    assert.match(seededAgent, /name: backlink-publisher/);
    assert.match(seededAgent, /mcp__plugin_backlinks_backlinks__backlinks_worker/);
    assert.doesNotMatch(seededAgent, /mcp__plugin_backlinks_backlinks__backlinks(?:\s|,|\])/);

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
