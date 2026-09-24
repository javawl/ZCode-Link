import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const packageRoot = resolve(import.meta.dirname, "..");
const execFileAsync = promisify(execFile);

test(
  "a relocated built plugin serves the real MCP client without repository dependencies",
  { timeout: 30_000 },
  async () => {
    await access(join(packageRoot, "dist", "mcp", "server.js"));
    const temporary = await mkdtemp(join(tmpdir(), "zcode-backlinks-distribution-"));
    const root = join(temporary, "plugin");
    const dataBaseDir = join(temporary, "data");
    await cp(join(packageRoot, "dist"), join(root, "dist"), { recursive: true });
    await cp(join(packageRoot, "runtime"), join(root, "runtime"), { recursive: true });
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    env.ZCODE_DATA_BASE_DIR = dataBaseDir;
    env.ZCODE_PROJECT_DIR = temporary;
    for (const key of Object.keys(env))
      if (/^(ZCODE_BACKLINKS_|SUPERMANAGER_|CLOUDMAIL_|DSH_BACKLINKS_)/.test(key)) delete env[key];
    const client = new Client(
      { name: "backlinks-distribution-test", version: "1.0.0" },
      {
        capabilities: {},
        versionNegotiation: { mode: "auto" },
      },
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(root, "dist", "mcp", "server.js")],
      cwd: temporary,
      env,
      stderr: "pipe",
    });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
        "backlinks",
        "backlinks_browser",
        "backlinks_cleanup",
        "backlinks_status",
        "backlinks_worker",
      ]);
      const status = await client.callTool({ name: "backlinks_status", arguments: {} });
      assert.equal(status.isError, undefined);
      assert.match(JSON.stringify(status), /tokenConfigured/);
      const browser = await client.callTool({
        name: "backlinks_browser",
        arguments: { action: "status" },
        _meta: {
          "com.zcode/request-context": {
            trace_id: "test-trace",
            session_id: "test-session",
            workspace_path: temporary,
          },
        },
      });
      assert.equal(browser.isError, undefined);
      assert.match(JSON.stringify(browser), /"running":false/);
      const missing = await client.callTool({
        name: "backlinks",
        arguments: { action: "batch_list" },
      });
      assert.equal(missing.isError, true);
      assert.doesNotMatch(JSON.stringify(missing), /Bearer|Authorization:/);
      const configured = await execFileAsync(
        process.execPath,
        [join(root, "dist", "configure.js")],
        { env, cwd: temporary },
      );
      assert.equal(JSON.parse(configured.stdout).browser.channel, "chrome");
    } finally {
      await client.close();
      await rm(temporary, { recursive: true, force: true });
    }
  },
);
