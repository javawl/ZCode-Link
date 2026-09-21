import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createNodeCustomCommandAdapter } from "@zcode/adapters/commands";
import { discoverNodePluginsSync } from "@zcode/adapters/plugins";
import { createCommandCenter } from "../src/command-center/create.js";
import type { CommandCenterApp } from "../src/command-center/types.js";

test("TUI /backlink-publish passes batch IDs to the real plugin command and required skill", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-backlinks-slash-"));
  try {
    const plugin = discoverNodePluginsSync({
      config: {
        dirs: [],
        enabled: true,
        enabledPlugins: { "backlinks@zcode-plugins-official": true },
        extraKnownMarketplaces: {},
        options: {},
        suppressedBuiltins: [],
      },
      officialPluginRoots: [fileURLToPath(new URL("../../backlinks-plugin", import.meta.url))],
      storageRoot: root,
      workingDirectory: root,
      env: {},
    });
    const commands = createNodeCustomCommandAdapter({ homeDirectory: root });
    const prompts: string[] = [];
    const app: CommandCenterApp = {
      sessionId: "fixture-session",
      traceId: "fixture-trace",
      async resume() {
        throw new Error("The slash command must not resume a session");
      },
      async submitPrompt(input) {
        prompts.push(typeof input === "string" ? input : input.text);
        return { response: "accepted" };
      },
    };
    const submit = createCommandCenter({
      getApp: async () => app,
      resumeApp: async () => {
        throw new Error("The slash command must not resume a session");
      },
      loadCustomCommand: (name) =>
        commands.loadCommand({
          name,
          roots: plugin.commandRoots,
          workingDirectory: root,
        }),
      listCustomCommands: () =>
        commands.discoverCommands({
          roots: plugin.commandRoots,
          workingDirectory: root,
        }),
    });
    const result = await submit("/backlink-publish 321, 320", {
      abortSignal: new AbortController().signal,
      onEvent() {},
    });
    assert.equal(result.response, "accepted");
    assert.equal(prompts.length, 1);
    assert.match(prompts[0]!, /Run custom command \/backlink-publish/);
    assert.match(prompts[0]!, /Required skills: `backlinks:backlink-publish`/);
    assert.match(prompts[0]!, /321, 320/);
    assert.equal(prompts[0]!.includes("$ARGUMENTS"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
