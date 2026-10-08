import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { assembleLinkAgentRelease } from "../scripts/assemble-linkagent-release.mjs";
import { verifySignedUpdate } from "../resources/internal-update/internal-update-protocol.mjs";

test("release assembly keeps both architectures in each verified update manifest", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "linkagent-release-test-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  const version = "3.15.0";
  const inputs = {};
  for (const [target, names] of Object.entries({
    "mac-arm64": ["LinkAgent-3.15.0-mac-arm64.dmg", "LinkAgent-3.15.0-mac-arm64.zip"],
    "mac-x64": ["LinkAgent-3.15.0-mac-x64.dmg", "LinkAgent-3.15.0-mac-x64.zip"],
    "win-arm64": ["LinkAgent-3.15.0-win-arm64.exe"],
    "win-x64": ["LinkAgent-3.15.0-win-x64.exe"],
  })) {
    const directory = join(root, target);
    inputs[target] = directory;
    await mkdir(directory);
    const files = [];
    for (const name of names) {
      const data = Buffer.from(`payload:${name}`);
      await writeFile(join(directory, name), data);
      await writeFile(join(directory, `${name}.blockmap`), `blockmap:${name}`);
      files.push({
        url: name,
        size: data.length,
        sha512: createHash("sha512").update(data).digest("base64"),
      });
    }
    const manifest = target.startsWith("mac-") ? "latest-mac.yml" : "latest.yml";
    const { stringify } = await import("yaml");
    await writeFile(join(directory, manifest), stringify({ version, files }));
  }
  const output = join(root, "ready");
  await assembleLinkAgentRelease({ version, inputs, output });
  for (const [manifest, expectedCount] of [
    ["latest-mac.yml", 4],
    ["latest.yml", 2],
  ]) {
    const parsed = parse(await readFile(join(output, manifest), "utf8"));
    assert.equal(parsed.version, version);
    assert.equal(parsed.files.length, expectedCount);
    assert(parsed.files.some((file) => file.url.includes("arm64")));
    assert(parsed.files.some((file) => file.url.includes("x64")));
    for (const file of parsed.files) {
      const data = await readFile(join(output, file.url));
      assert.equal(file.size, data.length);
      assert.equal(file.sha512, createHash("sha512").update(data).digest("base64"));
    }
  }
});

test("release assembly rejects a stale or mismatched builder checksum", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "linkagent-release-test-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  const inputs = {};
  for (const target of ["mac-arm64", "mac-x64", "win-arm64", "win-x64"]) {
    const directory = join(root, target);
    inputs[target] = directory;
    await mkdir(directory);
    await writeFile(
      join(directory, target.startsWith("mac-") ? "latest-mac.yml" : "latest.yml"),
      "version: 3.15.0\nfiles: []\n",
    );
  }
  await assert.rejects(
    assembleLinkAgentRelease({ version: "3.15.0", inputs, output: join(root, "ready") }),
    /missing expected artifact/,
  );
});

test("selected three-platform release never includes an unbuilt Windows ARM64 artifact", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "linkagent-selected-release-test-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  const version = "4.0.0";
  const keys = generateKeyPairSync("ed25519");
  const signingKeyFile = join(root, "fixture-private.pem");
  await writeFile(signingKeyFile, keys.privateKey.export({ type: "pkcs8", format: "pem" }));
  const signing = {
    signingKeyFile,
    trustedPublicKey: keys.publicKey.export({ type: "spki", format: "pem" }),
  };
  const inputs = {};
  const { stringify } = await import("yaml");
  for (const target of ["mac-arm64", "mac-x64", "win-x64"]) {
    const directory = join(root, target);
    inputs[target] = directory;
    await mkdir(directory);
    const extensions = target.startsWith("mac-") ? ["dmg", "zip"] : ["exe"];
    const files = [];
    for (const extension of extensions) {
      const name = `LinkAgent-${version}-${target}.${extension}`;
      const data = Buffer.from(`payload:${name}`);
      await writeFile(join(directory, name), data);
      await writeFile(join(directory, `${name}.blockmap`), `blockmap:${name}`);
      files.push({
        url: name,
        size: data.length,
        sha512: createHash("sha512").update(data).digest("base64"),
      });
    }
    await writeFile(
      join(directory, target.startsWith("mac-") ? "latest-mac.yml" : "latest.yml"),
      stringify({ version, files }),
    );
  }
  const output = join(root, "ready");
  await assembleLinkAgentRelease({
    version,
    inputs,
    output,
    selectedTargets: ["mac-arm64", "win-x64", "mac-x64"],
    ...signing,
  });
  const mac = parse(await readFile(join(output, "latest-mac.yml"), "utf8"));
  const win = parse(await readFile(join(output, "latest.yml"), "utf8"));
  assert.equal(mac.files.length, 4);
  assert.equal(mac.path, "LinkAgent-4.0.0-mac-x64.zip");
  assert.deepEqual(
    win.files.map((file) => file.url),
    ["LinkAgent-4.0.0-win-x64.exe"],
  );
  assert(!(await readdir(output)).some((name) => name.includes("win-arm64")));
  const signed = JSON.parse(await readFile(join(output, "linkagent-update.json"), "utf8"));
  for (const arch of ["arm64", "x64"])
    assert.equal(
      verifySignedUpdate(signed, { version, arch }, keys.publicKey).name,
      `LinkAgent-${version}-mac-${arch}.zip`,
    );

  const macOnly = join(root, "mac-only");
  await assembleLinkAgentRelease({
    version,
    inputs,
    output: macOnly,
    selectedTargets: ["mac-arm64"],
    ...signing,
  });
  assert(!(await readdir(macOnly)).includes("latest.yml"));
  const signedMacOnly = JSON.parse(await readFile(join(macOnly, "linkagent-update.json"), "utf8"));
  assert.throws(
    () => verifySignedUpdate(signedMacOnly, { version, arch: "x64" }, keys.publicKey),
    /architecture/,
  );

  await writeFile(join(inputs["win-x64"], "LinkAgent-4.0.0-win-x64.exe"), "corrupted");
  await assert.rejects(
    assembleLinkAgentRelease({
      version,
      inputs,
      output: join(root, "corrupt"),
      selectedTargets: ["win-x64"],
    }),
    /builder checksum mismatch/,
  );
});

test("release assembly rejects an empty, duplicate, or unknown target selection", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "linkagent-invalid-target-test-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  for (const selectedTargets of [[], ["win-x64", "win-x64"], ["win-ia32"]]) {
    await assert.rejects(
      assembleLinkAgentRelease({
        version: "4.0.0",
        inputs: {},
        output: join(root, "unused"),
        selectedTargets,
      }),
      /invalid release targets/,
    );
  }
});

test("Mac v4 release cannot be assembled with a missing or regenerated signing key", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "linkagent-key-test-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  const options = {
    version: "4.0.0",
    inputs: {},
    output: join(root, "unused"),
    selectedTargets: ["mac-arm64"],
  };
  await assert.rejects(
    assembleLinkAgentRelease({ ...options, signingKeyFile: null }),
    /SIGNING_KEY_FILE/,
  );
  const keys = generateKeyPairSync("ed25519");
  const file = join(root, "wrong-private.pem");
  await writeFile(file, keys.privateKey.export({ type: "pkcs8", format: "pem" }));
  await assert.rejects(
    assembleLinkAgentRelease({ ...options, signingKeyFile: file }),
    /pinned public key/,
  );
});
