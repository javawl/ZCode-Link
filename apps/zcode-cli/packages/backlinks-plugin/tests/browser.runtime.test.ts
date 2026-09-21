import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { backlinkBrowserInputSchema, createBacklinkBrowserRuntime } from "../src/browser/index.js";
import { createFakeChromium } from "./browser-fixtures.js";

const request = { traceId: "trace-fixture", sessionId: "session-fixture" };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zcode-backlinks-browser-"));
  const workspacePath = join(root, "workspace");
  await mkdir(workspacePath);
  const fake = createFakeChromium();
  const runtime = createBacklinkBrowserRuntime({
    profilePath: join(root, "profile"),
    workspacePath,
    loadChromium: async () => fake.chromium,
  });
  return { root, workspacePath, fake, runtime };
}

test("browser schema rejects missing page, invalid URLs and empty uploads before launch", () => {
  for (const input of [
    { action: "click", selector: "text:Submit" },
    { action: "navigate", page: "job", url: "file:///private/file" },
    { action: "navigate", page: "job", url: "https://user:secret@example.test/" },
    { action: "upload", page: "job", selector: "input", files: [] },
    { action: "waitFor", page: "job" },
    { action: "snapshot", page: "job", maxChars: 100000000 },
  ])
    assert.equal(backlinkBrowserInputSchema.safeParse(input).success, false);
  assert.equal(
    backlinkBrowserInputSchema.safeParse({
      action: "fill",
      page: "job",
      selector: "label:Name",
      value: "",
    }).success,
    true,
  );
});

test("persistent browser launches lazily, reuses named tabs and exposes observed popups", async () => {
  const { root, runtime, fake } = await fixture();
  try {
    assert.deepEqual(await runtime.execute({ action: "status" }, request), {
      kind: "status",
      running: false,
      headless: false,
      persistent: true,
    });
    assert.equal(fake.launches.length, 0);
    await runtime.execute(
      { action: "navigate", page: "job", url: "https://example.test/" },
      request,
    );
    await runtime.execute(
      { action: "navigate", page: "job", url: "https://example.test/form" },
      request,
    );
    assert.equal(fake.launches.length, 1);
    assert.equal(fake.pages.length, 1);
    assert.equal((fake.launches[0]!.options as { channel: string }).channel, "chrome");
    fake.addPage(fake.pages[0]);
    const result = await runtime.execute({ action: "tabs" }, request);
    assert.equal(result.kind, "tabs");
    if (result.kind !== "tabs") assert.fail("expected tabs");
    assert.equal(result.tabs.length, 2);
    assert.equal(result.tabs[1]?.openerPage, "job");
    const capture = await runtime.execute(
      { action: "snapshot", page: "job", format: "aria" },
      request,
    );
    assert.equal(capture.kind, "page");
    if (capture.kind !== "page") assert.fail("expected page");
    assert.match(capture.text, /link "Example"/u);
    await assert.rejects(
      runtime.execute({ action: "click", page: "unknown", selector: "text:X" }, request),
      { code: "BROWSER_PAGE_NOT_FOUND" },
    );
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("browser preserves semantic iframe selectors, empty fill, coordinate click and bounded capture", async () => {
  const { root, runtime, fake } = await fixture();
  try {
    await runtime.execute(
      { action: "navigate", page: "job", url: "https://example.test/" },
      request,
    );
    await runtime.execute(
      {
        action: "fill",
        page: "job",
        selector: 'frame(iframe[title="a)b"])>>frame(#inner)>>label:Email',
        value: "",
      },
      request,
    );
    await runtime.execute({ action: "click", page: "job", selector: "xy:12,45" }, request);
    await runtime.execute({ action: "press", page: "job", key: "End" }, request);
    const snapshot = await runtime.execute(
      { action: "snapshot", page: "job", maxChars: 10 },
      request,
    );
    assert.equal(snapshot.kind, "page");
    if (snapshot.kind !== "page") assert.fail("expected page");
    assert.equal(snapshot.text.length, 10);
    assert.equal(snapshot.truncated, true);
    assert.match(
      fake.actions.find((action) => action.action === "fill")?.selector ?? "",
      /frame\(#inner\).*label:Email/u,
    );
    assert.deepEqual(fake.actions.find((action) => action.action === "xy")?.value, [12, 45]);
    await assert.rejects(
      runtime.execute({ action: "fill", page: "job", selector: "xy:1,2", value: "x" }, request),
      { code: "BROWSER_INVALID_SELECTOR" },
    );
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("same tab serializes and a cancelled dispatched click remains uncertain without racing its successor", async () => {
  const { root, runtime, fake } = await fixture();
  try {
    await runtime.execute({ action: "navigate", page: "one", url: "https://one.test/" }, request);
    await runtime.execute({ action: "navigate", page: "two", url: "https://two.test/" }, request);
    let releaseClick!: () => void;
    let startedClick!: () => void;
    const started = new Promise<void>((resolve) => {
      startedClick = resolve;
    });
    fake.setNextClick(async () => {
      startedClick();
      await new Promise<void>((resolve) => {
        releaseClick = resolve;
      });
    });
    const controller = new AbortController();
    const click = runtime.execute(
      { action: "click", page: "one", selector: "text:Submit" },
      { ...request, signal: controller.signal },
    );
    await started;
    const later = runtime.execute(
      { action: "fill", page: "one", selector: "label:Name", value: "later" },
      request,
    );
    await runtime.execute(
      { action: "fill", page: "two", selector: "label:Name", value: "parallel" },
      request,
    );
    controller.abort();
    await assert.rejects(click, { code: "BROWSER_ABORTED", sideEffect: "uncertain" });
    assert.equal(
      fake.actions.some((action) => action.value === "later"),
      false,
    );
    releaseClick();
    await later;
    assert.equal(
      fake.actions.some((action) => action.value === "later"),
      true,
    );
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("upload accepts workspace files and rejects traversal and symlink escape", async () => {
  const { root, workspacePath, runtime, fake } = await fixture();
  try {
    const outside = join(root, "outside.txt");
    await writeFile(outside, "private");
    await writeFile(join(workspacePath, "logo.txt"), "asset");
    await symlink(outside, join(workspacePath, "escape.txt"));
    await runtime.execute(
      { action: "navigate", page: "job", url: "https://example.test/" },
      request,
    );
    await runtime.execute(
      { action: "upload", page: "job", selector: "input[type=file]", files: ["logo.txt"] },
      request,
    );
    for (const files of [["../outside.txt"], ["escape.txt"], [outside]]) {
      await assert.rejects(
        runtime.execute(
          { action: "upload", page: "job", selector: "input[type=file]", files },
          request,
        ),
        { code: "BROWSER_UPLOAD_OUTSIDE_WORKSPACE" },
      );
    }
    assert.equal(fake.actions.filter((action) => action.action === "upload").length, 1);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("profile lock refuses a second runtime and is removed only by its owner", async () => {
  const { root, workspacePath, runtime } = await fixture();
  const other = createBacklinkBrowserRuntime({
    profilePath: join(root, "profile"),
    workspacePath,
    loadChromium: async () => createFakeChromium().chromium,
  });
  try {
    await runtime.execute(
      { action: "navigate", page: "job", url: "https://example.test/" },
      request,
    );
    await assert.rejects(
      other.execute({ action: "navigate", page: "other", url: "https://example.test/" }, request),
      { code: "BROWSER_PROFILE_IN_USE" },
    );
    await other.close();
    assert.match(await readFile(join(root, "profile", ".zcode-backlinks.lock"), "utf8"), /owner/u);
    await runtime.close();
    await assert.rejects(readFile(join(root, "profile", ".zcode-backlinks.lock")), {
      code: "ENOENT",
    });
  } finally {
    await runtime.close();
    await other.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("cancelled calls never launch and disposal during lazy launch closes the late browser", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-backlinks-lifecycle-"));
  const fake = createFakeChromium();
  let releaseLoad!: () => void;
  let enteredLoad!: () => void;
  const entered = new Promise<void>((resolve) => {
    enteredLoad = resolve;
  });
  const runtime = createBacklinkBrowserRuntime({
    profilePath: join(root, "profile"),
    workspacePath: root,
    loadChromium: async () => {
      enteredLoad();
      await new Promise<void>((resolve) => {
        releaseLoad = resolve;
      });
      return fake.chromium;
    },
  });
  try {
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(
      runtime.execute(
        { action: "navigate", page: "job", url: "https://example.test/" },
        { ...request, signal: cancelled.signal },
      ),
      { code: "BROWSER_ABORTED" },
    );
    assert.equal(fake.launches.length, 0);
    const pending = runtime.execute(
      { action: "navigate", page: "job", url: "https://example.test/" },
      request,
    );
    await entered;
    const closing = runtime.close();
    releaseLoad();
    await assert.rejects(pending, { code: "BROWSER_SESSION_CLOSED" });
    await closing;
    assert.equal(fake.isClosed(), true);
    assert.equal(fake.actions.length, 0);
    await assert.rejects(readFile(join(root, "profile", ".zcode-backlinks.lock")), {
      code: "ENOENT",
    });
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("launch options preserve explicit flags but cannot override workspace profile isolation", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-backlinks-launch-options-"));
  const fake = createFakeChromium();
  const options = {
    profilePath: join(root, "profile"),
    workspacePath: root,
    loadChromium: async () => fake.chromium,
  };
  for (const overrides of [
    { launchArgs: ["--user-data-dir=/private/profile"] },
    { launchArgs: ["--profile-directory", "Default"] },
    { ignoreDefaultArgs: ["--USER-DATA-DIR"] },
    { windowPosition: "10,20 --user-data-dir=/private/profile" },
  ])
    assert.throws(() => createBacklinkBrowserRuntime({ ...options, ...overrides }), {
      code: "BROWSER_INVALID_INPUT",
    });
  const runtime = createBacklinkBrowserRuntime({
    ...options,
    launchArgs: ["--disable-blink-features=AutomationControlled"],
    ignoreDefaultArgs: ["--enable-automation"],
    windowPosition: "-32000,-32000",
  });
  try {
    await runtime.execute(
      { action: "navigate", page: "job", url: "https://example.test/" },
      request,
    );
    assert.deepEqual((fake.launches[0]!.options as { args: string[] }).args, [
      "--disable-blink-features=AutomationControlled",
      "--window-position=-32000,-32000",
    ]);
    assert.deepEqual(
      (fake.launches[0]!.options as { ignoreDefaultArgs: string[] }).ignoreDefaultArgs,
      ["--enable-automation"],
    );
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});
