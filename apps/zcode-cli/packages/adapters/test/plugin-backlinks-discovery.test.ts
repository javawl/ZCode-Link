import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { PluginConfig } from "@zcode/contracts";
import { discoverNodePluginsSync } from "../src/plugins/index.js";

const pluginId = "backlinks@zcode-plugins-official";
const pluginRoot = fileURLToPath(new URL("../../backlinks-plugin", import.meta.url));

test("installed backlinks exposes both skills and workspace MCP only after explicit enable", async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), "zcode-backlinks-discovery-"));
  const config: PluginConfig = {
    dirs: [],
    enabled: true,
    enabledPlugins: {},
    extraKnownMarketplaces: {},
    options: {},
    suppressedBuiltins: [],
  };
  const discover = () =>
    discoverNodePluginsSync({
      config,
      storageRoot,
      officialPluginRoots: [pluginRoot],
      env: {},
      workingDirectory: storageRoot,
    });
  try {
    const disabled = discover();
    assert.deepEqual(disabled.diagnostics, []);
    assert.equal(disabled.plugins[0]?.id, pluginId);
    assert.equal(disabled.plugins[0]?.enabled, false);
    assert.deepEqual(disabled.mcpServers, {});
    assert.deepEqual(disabled.skillRoots, []);

    config.enabledPlugins[pluginId] = true;
    const enabled = discover();
    assert.deepEqual(enabled.diagnostics, []);
    assert.equal(enabled.plugins[0]?.enabled, true);
    assert.equal(enabled.plugins[0]?.skillCount, 2);
    const names = enabled.plugins[0]?.components.flatMap(({ items }) =>
      items.map(({ name }) => name),
    );
    assert.ok(names?.includes("backlink-publish"));
    assert.ok(names?.includes("google-session"));
    const server = enabled.mcpServers["plugin:backlinks:backlinks"];
    assert.equal(server?.type, "stdio");
    assert.equal(server?.isolation, "workspace");
    if (server?.type === "stdio") {
      assert.equal(server.cwd, storageRoot);
      assert.equal(server.env?.ZCODE_PROJECT_DIR, storageRoot);
      assert.equal(server.args?.[0], `${pluginRoot}/dist/mcp/server.js`);
    }

    config.enabledPlugins[pluginId] = false;
    assert.deepEqual(discover().mcpServers, {});
    assert.deepEqual(discover().skillRoots, []);
  } finally {
    await rm(storageRoot, { recursive: true, force: true });
  }
});
