import assert from "node:assert/strict";
import { generateKeyPairSync, createHash, sign } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createSignedUpdate,
  verifySignedUpdate,
  validateArchiveEntry,
  downloadVerifiedArchive,
} from "../resources/internal-update/internal-update-protocol.mjs";
import { runMacInstall } from "../resources/internal-update/mac-update-install.mjs";

const keys = generateKeyPairSync("ed25519");
const version = "4.0.1";
const bytes = Buffer.from("verified test update");
const file = {
  arch: "arm64",
  name: `LinkAgent-${version}-mac-arm64.zip`,
  sha512: createHash("sha512").update(bytes).digest("base64"),
  size: bytes.length,
};
const envelope = () => createSignedUpdate({ version, files: [file] }, keys.privateKey);

test("only the pinned release key, identity, version and exact architecture authorize a Mac ZIP", () => {
  const signed = envelope();
  assert.deepEqual(verifySignedUpdate(signed, { version, arch: "arm64" }, keys.publicKey), file);
  assert.throws(
    () => verifySignedUpdate(signed, { version, arch: "x64" }, keys.publicKey),
    /architecture/,
  );
  assert.throws(
    () => verifySignedUpdate(signed, { version: "4.0.2", arch: "arm64" }, keys.publicKey),
    /version/,
  );
  assert.throws(() => verifySignedUpdate(signed, { version, arch: "arm64" }), /signature/);
  for (const field of ["repository", "appId", "version"]) {
    const payload = JSON.parse(signed.payload);
    payload[field] = "wrong";
    assert.throws(
      () =>
        verifySignedUpdate(
          { ...signed, payload: JSON.stringify(payload) },
          { version, arch: "arm64" },
          keys.publicKey,
        ),
      /signature/,
    );
    const raw = JSON.stringify(payload);
    assert.throws(
      () =>
        verifySignedUpdate(
          {
            payload: raw,
            signature: sign(null, Buffer.from(raw), keys.privateKey).toString("base64"),
          },
          { version, arch: "arm64" },
          keys.publicKey,
        ),
      /identity|repository|version/,
    );
  }
  assert.throws(
    () =>
      verifySignedUpdate({ payload: signed.payload }, { version, arch: "arm64" }, keys.publicKey),
    /signature/,
  );
});

test("archive traversal and symlinks escaping the app are rejected before extraction", () => {
  for (const name of [
    "../bad",
    "/tmp/bad",
    "LinkAgent.app/../bad",
    "LinkAgent.app/a/../../bad",
    "bad.app/a",
    "LinkAgent.app\\..\\bad",
  ]) {
    assert.throws(() => validateArchiveEntry(name), /archive/);
  }
  validateArchiveEntry("LinkAgent.app/Contents/Frameworks/F.framework/Versions/Current", "A");
  assert.throws(
    () => validateArchiveEntry("LinkAgent.app/Contents/evil", "../../../outside"),
    /symlink/,
  );
});

test("download corruption and cancellation never become a ready update", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "linkagent-download-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const destination = join(root, "update.zip");
  await assert.rejects(
    downloadVerifiedArchive({
      url: "https://test.invalid/update.zip",
      destination,
      expected: file,
      fetcher: async () => new Response("corrupt"),
    }),
    /checksum|size/,
  );
  await assert.rejects(access(destination));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    downloadVerifiedArchive({
      url: "https://test.invalid/update.zip",
      destination,
      expected: file,
      signal: controller.signal,
      fetcher: async () => new Response(bytes),
    }),
    /cancel|abort/i,
  );
  await assert.rejects(access(destination));
  await downloadVerifiedArchive({
    url: "https://test.invalid/update.zip",
    destination,
    expected: file,
    fetcher: async () => new Response(bytes),
  });
  assert.deepEqual(await readFile(destination), bytes);
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "linkagent-install-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const appPath = join(root, "LinkAgent.app");
  const jobPath = join(root, ".linkagent-update-test");
  const stagedApp = join(jobPath, "staging", "LinkAgent.app");
  await mkdir(appPath, { recursive: true });
  await mkdir(stagedApp, { recursive: true });
  await writeFile(join(appPath, "version"), "4.0.0");
  await writeFile(join(stagedApp, "version"), version);
  const archivePath = join(jobPath, "payload.zip");
  await writeFile(archivePath, bytes);
  const plan = {
    schemaVersion: 1,
    appPath,
    jobPath,
    stagedApp,
    archivePath,
    signedUpdate: envelope(),
    currentVersion: "4.0.0",
    version,
    arch: "arm64",
    token: "a".repeat(64),
    parentPid: process.pid + 1,
    startupTimeoutMs: 1000,
    exitTimeoutMs: 1000,
    launchEnvironment: {},
    resultPath: join(root, "result.json"),
  };
  const ports = {
    publicKey: keys.publicKey,
    waitForParentExit: async () => {},
    validateApp: async (path) =>
      assert.equal(await readFile(join(path, "version"), "utf8"), version),
    validateCurrentApp: async (path) =>
      assert.equal(await readFile(join(path, "version"), "utf8"), "4.0.0"),
    launchAndWait: async () => {},
  };
  return { plan, ports, appPath, jobPath };
}

test("successful install swaps only the app and keeps user data", async (t) => {
  const { plan, ports, appPath } = await fixture(t);
  await writeFile(plan.resultPath + ".user-data", "settings and tasks");
  const result = await runMacInstall(plan, ports);
  assert.equal(result.status, "installed");
  assert.equal(await readFile(join(appPath, "version"), "utf8"), version);
  assert.equal(await readFile(plan.resultPath + ".user-data", "utf8"), "settings and tasks");
});

test("startup failure restores and launches the old version", async (t) => {
  const { plan, ports, appPath } = await fixture(t);
  const launches = [];
  ports.launchAndWait = async (path, updating) => {
    launches.push({ path, updating });
    if (updating) throw new Error("new main window did not acknowledge startup");
  };
  const result = await runMacInstall(plan, ports);
  assert.equal(result.status, "rolled-back");
  assert.equal(await readFile(join(appPath, "version"), "utf8"), "4.0.0");
  assert.deepEqual(
    launches.map((x) => x.updating),
    [true, false],
  );
});

test("invalid archive and a parent that does not exit leave the old app untouched", async (t) => {
  const { plan, ports, appPath } = await fixture(t);
  await writeFile(plan.archivePath, "bad");
  await assert.rejects(runMacInstall(plan, ports), /checksum|size/);
  assert.equal(await readFile(join(appPath, "version"), "utf8"), "4.0.0");
  await writeFile(plan.archivePath, bytes);
  ports.waitForParentExit = async () => {
    throw new Error("parent exit deadline");
  };
  await assert.rejects(runMacInstall(plan, ports), /parent exit/);
  assert.equal(await readFile(join(appPath, "version"), "utf8"), "4.0.0");
});

test("exclusive install lock rejects a second helper without touching the app", async (t) => {
  const { plan, ports, appPath } = await fixture(t);
  await mkdir(appPath + ".linkagent-update-lock");
  await assert.rejects(runMacInstall(plan, ports), /lock|EEXIST/);
  assert.equal(await readFile(join(appPath, "version"), "utf8"), "4.0.0");
});

test("a changed installed app is rejected before it can be backed up or overwritten", async (t) => {
  const { plan, ports, appPath } = await fixture(t);
  await writeFile(join(appPath, "version"), "unrelated app");
  await assert.rejects(runMacInstall(plan, ports));
  assert.equal(await readFile(join(appPath, "version"), "utf8"), "unrelated app");
});
