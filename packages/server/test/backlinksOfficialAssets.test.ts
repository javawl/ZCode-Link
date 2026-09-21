import assert from "node:assert/strict";
import test from "node:test";
import { backlinksPluginPackage } from "../../../scripts/backlinks-plugin-assets.mjs";
import { OFFICIAL_PLUGIN_DEFINITIONS } from "../../../apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.js";
import {
  REMOTE_AGENT_OFFICIAL_PLUGIN_INCLUDED_TOP_LEVEL_PATHS,
  REMOTE_AGENT_OFFICIAL_PLUGIN_PACKAGE_NAMES,
  REMOTE_AGENT_OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS,
  buildRemoteAgentOfficialPluginRequiredPaths,
} from "../src/remote/zcodeAgentOfficialPluginAssets.js";

test("remote development and release assets require the same complete backlinks seed", () => {
  const definition = OFFICIAL_PLUGIN_DEFINITIONS.find(({ name }) => name === "backlinks");
  assert.ok(definition);
  assert.ok(REMOTE_AGENT_OFFICIAL_PLUGIN_PACKAGE_NAMES.includes("backlinks-plugin"));
  assert.ok(REMOTE_AGENT_OFFICIAL_PLUGIN_INCLUDED_TOP_LEVEL_PATHS.includes("runtime"));
  assert.deepEqual(
    [...definition.requiredSeedPaths!].sort(),
    [...backlinksPluginPackage.requiredRuntimePaths].sort(),
  );
  const remotePaths = new Set<string>(REMOTE_AGENT_OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS);
  for (const path of [".zcode-plugin/plugin.json", ...definition.requiredSeedPaths!]) {
    assert.ok(remotePaths.has(`backlinks-plugin/${path}`), path);
  }
});

test("remote required paths preserve a provider directory containing spaces", () => {
  const paths = buildRemoteAgentOfficialPluginRequiredPaths("/example/remote workspace/glm");
  assert.ok(
    paths.includes(
      "/example/remote workspace/glm/packages/backlinks-plugin/runtime/playwright-core/index.mjs",
    ),
  );
  assert.ok(
    paths.includes(
      "/example/remote workspace/glm/packages/backlinks-plugin/skills/google-session/SKILL.md",
    ),
  );
});
