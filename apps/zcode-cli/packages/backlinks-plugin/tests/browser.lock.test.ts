import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBacklinkBrowserRuntime } from "../src/browser/index.js";
import { createFakeChromium } from "./browser-fixtures.js";

const request = { traceId: "lock-fixture", sessionId: "lock-session" };

async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
  assert.ok(child.pid);
  return child.pid;
}

test("only one runtime recovers a verified dead same-host profile lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-backlinks-stale-lock-"));
  const lockPath = join(root, ".zcode-backlinks.lock");
  const stale = { version: 1, owner: randomUUID(), pid: await exitedPid(), hostname: hostname() };
  await writeFile(lockPath, JSON.stringify(stale));
  const makeRuntime = () =>
    createBacklinkBrowserRuntime({
      profilePath: root,
      workspacePath: root,
      loadChromium: async () => createFakeChromium().chromium,
    });
  const first = makeRuntime();
  const second = makeRuntime();
  try {
    const results = await Promise.allSettled(
      [first, second].map((runtime) =>
        runtime.execute({ action: "navigate", page: "job", url: "https://example.test/" }, request),
      ),
    );
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.equal(rejected?.status === "rejected" && rejected.reason.code, "BROWSER_PROFILE_IN_USE");
    const current = JSON.parse(await readFile(lockPath, "utf8")) as { owner: string; pid: number };
    assert.notEqual(current.owner, stale.owner);
    assert.equal(current.pid, process.pid);
  } finally {
    await first.close();
    await second.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("profile recovery never removes live, malformed, foreign-host or guarded locks", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-backlinks-lock-refusal-"));
  const lockPath = join(root, ".zcode-backlinks.lock");
  const deadPid = await exitedPid();
  const base = { version: 1, owner: randomUUID(), pid: deadPid, hostname: hostname() };
  const records = [
    JSON.stringify({ ...base, pid: process.pid }),
    "unknown legacy lock",
    JSON.stringify({ ...base, hostname: "another-host.invalid" }),
  ];
  try {
    for (const text of records) {
      await writeFile(lockPath, text);
      const runtime = createBacklinkBrowserRuntime({
        profilePath: root,
        workspacePath: root,
        loadChromium: async () => createFakeChromium().chromium,
      });
      await assert.rejects(
        runtime.execute({ action: "navigate", page: "job", url: "https://example.test/" }, request),
        { code: "BROWSER_PROFILE_IN_USE" },
      );
      await runtime.close();
      assert.equal(await readFile(lockPath, "utf8"), text);
    }
    const staleText = JSON.stringify(base);
    await writeFile(lockPath, staleText);
    await writeFile(`${lockPath}.recovery`, "unknown recovery owner");
    const guarded = createBacklinkBrowserRuntime({
      profilePath: root,
      workspacePath: root,
      loadChromium: async () => createFakeChromium().chromium,
    });
    await assert.rejects(
      guarded.execute({ action: "navigate", page: "job", url: "https://example.test/" }, request),
      { code: "BROWSER_PROFILE_IN_USE" },
    );
    await guarded.close();
    assert.equal(await readFile(lockPath, "utf8"), staleText);
    assert.equal(await readFile(`${lockPath}.recovery`, "utf8"), "unknown recovery owner");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
