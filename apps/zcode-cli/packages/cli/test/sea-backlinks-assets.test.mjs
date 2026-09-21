import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  collectSeaOfficialPluginAssets,
  officialSeaPlugins,
  seaOfficialPluginAssetPrefix,
} from "../scripts/sea-official-plugin-assets.mjs";

const requiredPaths = [
  "commands/backlink-publish.md",
  "docs/browser.md",
  "dist/configure.js",
  "dist/mcp/server.js",
  "runtime/playwright-core/package.json",
  "skills/backlink-publish/SKILL.md",
  "skills/google-session/SKILL.md",
];

async function writeFixture(path, text = "fixture") {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

async function createFixture(root) {
  for (const plugin of officialSeaPlugins) {
    const pluginRoot = join(root, plugin.rootPath);
    await writeFixture(
      join(pluginRoot, ".zcode-plugin", "plugin.json"),
      JSON.stringify({
        name: plugin.name,
        version: plugin.version,
      }),
    );
    for (const path of [
      ...(plugin.requiredSeedPaths ?? []),
      ...(plugin.requiredRuntimePaths ?? []),
    ]) {
      await writeFixture(join(pluginRoot, path));
    }
  }
}

test("SEA ships the opt-in backlinks plugin with runtime, license and skill guides", async () => {
  const plugin = officialSeaPlugins.find(({ name }) => name === "backlinks");
  assert.ok(plugin);
  assert.equal(plugin.version, "0.1.0");
  for (const path of requiredPaths) assert.ok(plugin.requiredRuntimePaths.includes(path), path);
  const root = await mkdtemp(join(tmpdir(), "zcode-sea-backlinks-"));
  try {
    await createFixture(root);
    const extraPaths = [
      "runtime/playwright-core/index.mjs",
      "runtime/playwright-core/lib/server/registry/index.js",
      "runtime/playwright-core/LICENSE",
      "skills/backlink-publish/站点指南.md",
    ];
    for (const path of extraPaths) await writeFixture(join(root, plugin.rootPath, path));
    await writeFixture(join(root, plugin.rootPath, "node_modules", "excluded", "index.js"));
    const { assets, manifest } = await collectSeaOfficialPluginAssets({
      requireRuntime: true,
      root,
      stagingDirectory: join(root, "staging"),
    });
    const files = manifest.plugins.find(({ name }) => name === "backlinks").files;
    for (const path of [...requiredPaths, ...extraPaths]) {
      assert.ok(
        files.some((file) => file.path === path),
        path,
      );
      const key = `${seaOfficialPluginAssetPrefix}zcode-plugins-official/backlinks/0.1.0/${path}`;
      assert.equal(await readFile(assets[key], "utf8"), "fixture");
    }
    assert.equal(
      files.some(({ path }) => path.startsWith("node_modules/")),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const missingPath of requiredPaths) {
  test(`SEA refuses backlinks with missing ${missingPath}`, async () => {
    const plugin = officialSeaPlugins.find(({ name }) => name === "backlinks");
    assert.ok(plugin);
    const root = await mkdtemp(join(tmpdir(), "zcode-sea-backlinks-missing-"));
    try {
      await createFixture(root);
      await rm(join(root, plugin.rootPath, missingPath));
      await assert.rejects(
        collectSeaOfficialPluginAssets({
          requireRuntime: true,
          root,
          stagingDirectory: join(root, "staging"),
        }),
        /Missing backlinks/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
