import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import type { PluginDiagnostic } from "@zcode/contracts";
import { resolvePluginMcpServers } from "../src/plugins/mcp.js";

function resolveServer(server: Record<string, unknown>) {
  const diagnostics: PluginDiagnostic[] = [];
  const servers = resolvePluginMcpServers({
    dataPath: join("example", "data"),
    definitions: { backlinks: server },
    diagnostics,
    env: {},
    loaded: {
      id: "backlinks@zcode-plugins-official",
      manifest: { name: "backlinks", version: "0.1.0" },
      manifestPath: join("example", "plugin", ".zcode-plugin", "plugin.json"),
      marketplace: "zcode-plugins-official",
      rootPath: join("example", "plugin"),
      source: "cache",
    },
    options: {},
    workingDirectory: join("example", "workspace"),
  });
  return { diagnostics, server: servers["plugin:backlinks:backlinks"] };
}

for (const transport of ["stdio", "http", "sse"] as const) {
  for (const isolation of ["session", "workspace"] as const) {
    test(`${transport} preserves explicit ${isolation} pooling scope`, () => {
      const result = resolveServer({
        type: transport,
        command: "node",
        url: "https://example.test/mcp",
        isolation,
        timeoutMs: 180_000,
        enabled: true,
      });
      assert.deepEqual(result.diagnostics, []);
      assert.equal(result.server?.isolation, isolation);
      assert.equal(result.server?.timeoutMs, 180_000);
      assert.equal(result.server?.enabled, true);
    });
  }
}

test("omitted isolation preserves the host's existing default", () => {
  const result = resolveServer({ command: "node" });
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.server?.isolation, undefined);
});

for (const isolation of ["global", "Workspace", null, false, 1]) {
  test(`invalid isolation ${String(isolation)} disables the server with a diagnostic`, () => {
    const result = resolveServer({ command: "node", isolation });
    assert.equal(result.server, undefined);
    assert.equal(result.diagnostics[0]?.code, "plugin_mcp_server_disabled");
    assert.match(result.diagnostics[0]?.message ?? "", /isolation/);
  });
}

test("stdio workspace scope retains working directory and trusted plugin identity", () => {
  const result = resolveServer({
    command: "node",
    args: ["${ZCODE_PLUGIN_ROOT}/dist/mcp/server.js"],
    cwd: "${ZCODE_PROJECT_DIR}",
    env: { ZCODE_PLUGIN_ID: "forged@source" },
    isolation: "workspace",
  });
  assert.equal(result.server?.type, "stdio");
  if (result.server?.type !== "stdio") return;
  assert.equal(result.server.cwd, join("example", "workspace"));
  assert.equal(result.server.env?.ZCODE_PROJECT_DIR, join("example", "workspace"));
  assert.equal(result.server.env?.ZCODE_PLUGIN_ID, "backlinks@zcode-plugins-official");
  assert.deepEqual(result.server.source, { kind: "builtin" });
});

test("official auth retains workspace isolation and authoritative provenance", () => {
  const result = resolveServer({
    type: "http",
    url: "https://example.test/mcp",
    auth: { type: "zcode_official", provider: "jwt_token" },
    isolation: "workspace",
  });
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.server?.type, "http");
  if (result.server?.type !== "http") return;
  assert.equal(result.server.isolation, "workspace");
  assert.deepEqual(result.server.official, {
    mcpKey: "backlinks",
    pluginId: "backlinks@zcode-plugins-official",
    source: "plugin",
  });
});

test("OAuth configuration retains all supported fields alongside scope", () => {
  const oauth = {
    type: "authorization_code",
    clientId: "example-client",
    clientSecret: "fixture-only",
    clientName: "Example",
    redirectPath: "/callback",
    scope: "read",
  };
  const result = resolveServer({ type: "http", url: "https://example.test/mcp", oauth });
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.server?.type, "http");
  if (result.server?.type !== "http") return;
  assert.deepEqual(result.server.oauth, oauth);
});
