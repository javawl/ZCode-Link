import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createBacklinkBrowserRuntime } from "../src/browser/index.js";

// 真实桌面验收：会短暂启动有界面 Chrome，只在 macOS 且显式开启时运行。
const executablePath =
  process.env.ZCODE_BACKLINKS_TEST_BROWSER ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const enabled =
  process.platform === "darwin" &&
  process.env.ZCODE_BACKLINKS_FOCUS_TEST === "1" &&
  existsSync(executablePath);
const request = { traceId: "trace-focus", sessionId: "session-focus" };

const run = (file: string, args: string[]) =>
  new Promise<string>((resolve, reject) =>
    execFile(file, args, { timeout: 3_000 }, (error, stdout) =>
      error ? reject(error) : resolve(String(stdout)),
    ),
  );

async function frontPid(): Promise<number | undefined> {
  const asn = (await run("lsappinfo", ["front"]).catch(() => "")).trim();
  if (!asn) return undefined;
  const info = await run("lsappinfo", ["info", "-only", "pid", asn]).catch(() => "");
  return Number(/(\d+)\s*$/u.exec(info.trim())?.[1]) || undefined;
}

async function chromePid(profilePath: string): Promise<number | undefined> {
  const children = (await run("pgrep", ["-P", String(process.pid)]).catch(() => ""))
    .split(/\s+/u)
    .map(Number)
    .filter(Boolean);
  for (const pid of children)
    if (
      (await run("ps", ["-o", "command=", "-p", String(pid)]).catch(() => "")).includes(profilePath)
    )
      return pid;
  return undefined;
}

test(
  "background mode publishes without taking the foreground and recycles finished pages",
  {
    skip: !enabled && "Set ZCODE_BACKLINKS_FOCUS_TEST=1 on macOS with Google Chrome installed",
    timeout: 90_000,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-backlinks-focus-"));
    const workspacePath = join(root, "workspace");
    await mkdir(workspacePath);
    const server = createServer((incoming, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      if (incoming.url?.startsWith("/done")) {
        response.end('<h1>Listed</h1><a href="https://target.example/">Fixture Project</a>');
        return;
      }
      if (incoming.url === "/oauth") {
        response.end("<h1>Sign in</h1>");
        return;
      }
      response.end(`<!doctype html><form action="/done"><label>Name<input name="n"></label>
        <button type="submit">Submit</button></form>
        <button id="popup" onclick="window.open('/oauth','oauth','width=480,height=520')">Continue with Google</button>`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const profilePath = join(root, "profile");
    const runtime = createBacklinkBrowserRuntime({
      profilePath,
      workspacePath,
      executablePath,
      displayMode: "background",
    });
    let pid: number | undefined;
    let sampling = true;
    let phase = "launch";
    const stolen = new Map<string, number>();
    const sampler = (async () => {
      while (sampling) {
        pid ??= await chromePid(profilePath);
        if (pid && (await frontPid()) === pid) stolen.set(phase, (stolen.get(phase) ?? 0) + 100);
        await delay(100);
      }
    })();
    try {
      await runtime.execute(
        { action: "navigate", page: "batch-1-item-1", url: `${baseUrl}/form` },
        request,
      );
      await delay(2_000);
      phase = "publish";
      await runtime.execute(
        { action: "fill", page: "batch-1-item-1", selector: "label:Name", value: "Fixture" },
        request,
      );
      await runtime.execute(
        { action: "click", page: "batch-1-item-1", selector: "role:button|Submit" },
        request,
      );
      await runtime.execute(
        {
          action: "waitFor",
          page: "batch-1-item-1",
          selector: 'a[href="https://target.example/"]',
        },
        request,
      );
      const shot = await runtime.execute({ action: "screenshot", page: "batch-1-item-1" }, request);
      assert.equal(shot.kind, "screenshot", "parked background pages still render");
      await runtime.releaseItemPages(1, "recycle");
      await runtime.execute(
        { action: "navigate", page: "batch-1-item-2", url: `${baseUrl}/form` },
        request,
      );
      await runtime.execute(
        { action: "navigate", page: "batch-1-item-3", url: `${baseUrl}/form` },
        request,
      );
      await delay(1_500);
      phase = "popup";
      await runtime.execute(
        { action: "click", page: "batch-1-item-2", selector: "#popup" },
        request,
      );
      await delay(2_500);
      phase = "finish";
      const withPopup = await runtime.execute({ action: "tabs" }, request);
      assert.ok(
        withPopup.kind === "tabs" &&
          withPopup.tabs.some((tab) => tab.openerPage === "batch-1-item-2" && tab.itemId === 2),
      );
      await runtime.releaseItemPages(2, "recycle");
      await runtime.releaseItemPages(3, "hold");
      await delay(1_500);
      const tabs = await runtime.execute({ action: "tabs" }, request);
      assert.ok(tabs.kind === "tabs");
      assert.deepEqual(
        tabs.tabs.map((tab) => [tab.page, tab.held]),
        [["batch-1-item-3", true]],
        "finished pages and their popup are gone; only the held page remains",
      );
    } finally {
      sampling = false;
      await sampler;
      await runtime.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
    console.log(`focus samples (ms Chrome was frontmost by phase): ${JSON.stringify([...stolen])}`);
    // 启动与站点弹窗会短暂抢占前台，随后必须在 2 秒内归还；普通发布动作一次都不能抢占。
    assert.ok(pid, "the Chrome process was observed");
    assert.equal(stolen.get("publish") ?? 0, 0, `publishing stole focus: ${[...stolen]}`);
    assert.equal(stolen.get("finish") ?? 0, 0, `recycling stole focus: ${[...stolen]}`);
    assert.ok((stolen.get("launch") ?? 0) <= 2_000, `launch kept focus: ${[...stolen]}`);
    assert.ok((stolen.get("popup") ?? 0) <= 2_000, `popup kept focus: ${[...stolen]}`);
  },
);
