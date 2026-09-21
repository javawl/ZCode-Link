import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBacklinksRuntime } from "@zcode/backlinks/node";
import { ProxyChannel } from "@zcode/rpc";
import { createBacklinksService } from "../src/backlinks/backlinksService.js";
import type { IBacklinksService } from "../src/backlinks/contract.js";
import { setDataBaseDir } from "../src/paths.js";

test("service and MCP runtime observe the same config without a service cache", async () => {
  const dataBaseDir = await mkdtemp(join(tmpdir(), "zcode-backlinks-service-"));
  try {
    const runtime = createBacklinksRuntime({ dataBaseDir, env: {} });
    const service = createBacklinksService({ runtime });
    const toolRuntime = createBacklinksRuntime({ dataBaseDir, env: {} });
    await service.updateSettings({
      supermanager: { baseUrl: "https://first.example", token: "test-only-token" },
    });
    assert.equal((await toolRuntime.getSettings()).supermanager.baseUrl, "https://first.example");
    await toolRuntime.updateSettings({ supermanager: { baseUrl: "https://second.example" } });
    const snapshot = await service.getSettings();
    assert.equal(snapshot.supermanager.baseUrl, "https://second.example");
    assert.equal(snapshot.supermanager.tokenConfigured, true);
    assert.equal(JSON.stringify(snapshot).includes("test-only-token"), false);
    const uiChannel = ProxyChannel.fromService(service);
    assert.throws(() => uiChannel.call("renderer", "claim", [1]), /Method not found: claim/);
  } finally {
    await rm(dataBaseDir, { recursive: true, force: true });
  }
});

test("host data directory is captured when its service is created", async () => {
  const first = await mkdtemp(join(tmpdir(), "zcode-backlinks-host-first-"));
  const second = await mkdtemp(join(tmpdir(), "zcode-backlinks-host-second-"));
  try {
    setDataBaseDir(first);
    const service = createBacklinksService();
    setDataBaseDir(second);
    await service.updateSettings({ supermanager: { baseUrl: "https://host.example" } });
    const persisted = await readFile(join(first, ".zcode", "v2", "backlinks.json"), "utf8");
    assert.ok(persisted.includes("https://host.example"));
    await assert.rejects(readFile(join(second, ".zcode", "v2", "backlinks.json")), {
      code: "ENOENT",
    });
  } finally {
    setDataBaseDir(null);
    await Promise.all([
      rm(first, { recursive: true, force: true }),
      rm(second, { recursive: true, force: true }),
    ]);
  }
});

test("service preserves upstream errors instead of accepting or masking failed writes", async () => {
  const failure = new Error("configuration update rejected");
  const runtime: IBacklinksService = {
    getSettings: () => Promise.reject(failure),
    updateSettings: () => Promise.reject(failure),
    listBatches: () => Promise.reject(failure),
    getBatch: () => Promise.reject(failure),
  };
  const service = createBacklinksService({ runtime });
  await assert.rejects(service.getSettings(), (error) => error === failure);
  await assert.rejects(service.updateSettings({}), (error) => error === failure);
  await assert.rejects(service.listBatches(), (error) => error === failure);
  await assert.rejects(service.getBatch(7), (error) => error === failure);
});
