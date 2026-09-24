import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { assembleLinkAgentRelease } from "../scripts/assemble-linkagent-release.mjs";

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
