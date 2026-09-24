import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ACTIVE_OFFICIAL_PLUGIN_DEFINITIONS,
  DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS,
  OFFICIAL_PLUGIN_DEFINITIONS,
} from "../src/app/official-plugin-definitions.js";
import { writeOfficialPluginRuntimeManifest } from "../src/app/official-plugin-runtime.js";

test("backlinks is the default LinkAgent plugin with a complete runtime seed", () => {
  const definition = OFFICIAL_PLUGIN_DEFINITIONS.find(({ name }) => name === "backlinks");
  assert.ok(definition);
  assert.equal(definition.version, "0.1.0");
  assert.equal(definition.defaultEnabled, true);
  assert.equal(DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS.has("backlinks@zcode-plugins-official"), true);
  assert.deepEqual(
    ACTIVE_OFFICIAL_PLUGIN_DEFINITIONS.map(({ name }) => name),
    ["backlinks"],
  );
  assert.equal(definition.listing?.author?.name, "javawl");
  assert.ok(definition.listing?.displayName);
  assert.ok(definition.listing?.displayName_i18n?.["zh-CN"]);
  assert.equal(definition.listing?.icon, undefined);
  assert.ok(definition.rootCandidates.includes("packages/backlinks-plugin"));
  assert.ok(definition.runtimeTopLevelPaths?.includes("runtime"));
  for (const path of [
    "agents/backlink-publisher.md",
    "commands/backlink-publish.md",
    "docs/browser.md",
    "dist/configure.js",
    "dist/mcp/server.js",
    "runtime/playwright-core/package.json",
    "skills/backlink-publish/SKILL.md",
    "skills/google-session/SKILL.md",
  ]) {
    assert.ok(definition.requiredSeedPaths?.includes(path), path);
  }
});

test("host manifest rewrite preserves workspace scope, cwd, timeout and permissions", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "zcode-backlinks-manifest-"));
  const manifestPath = join(rootPath, ".zcode-plugin", "plugin.json");
  const permissions = { allow: ["mcp__backlinks__*"] };
  try {
    await mkdir(join(rootPath, ".zcode-plugin"));
    await writeFile(
      manifestPath,
      JSON.stringify({
        name: "backlinks",
        version: "0.1.0",
        permissions,
        mcpServers: {
          backlinks: {
            type: "stdio",
            command: "node",
            args: ["${ZCODE_PLUGIN_ROOT}/dist/mcp/server.js"],
            cwd: "${ZCODE_PROJECT_DIR}",
            isolation: "workspace",
            timeoutMs: 180_000,
            env: { EXAMPLE_SETTING: "retained" },
          },
        },
      }),
    );
    writeOfficialPluginRuntimeManifest({ pluginName: "backlinks", rootPath });
    const rewritten = JSON.parse(await readFile(manifestPath, "utf8"));
    const server = rewritten.mcpServers.backlinks;
    assert.equal(server.command, process.execPath);
    assert.equal(server.args.at(-1), join(rootPath, "dist", "mcp", "server.js"));
    assert.equal(server.isolation, "workspace");
    assert.equal(server.cwd, "${ZCODE_PROJECT_DIR}");
    assert.equal(server.timeoutMs, 180_000);
    assert.equal(server.env.EXAMPLE_SETTING, "retained");
    assert.equal(server.env.ELECTRON_RUN_AS_NODE, "1");
    assert.deepEqual(rewritten.permissions, permissions);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});
