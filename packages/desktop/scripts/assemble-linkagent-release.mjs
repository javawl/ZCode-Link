import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse, stringify } from "yaml";
import {
  createSignedUpdate,
  UPDATE_MANIFEST_NAME,
  UPDATE_PUBLIC_KEY,
  verifySignedUpdate,
} from "../resources/internal-update/internal-update-protocol.mjs";

const allTargets = ["mac-x64", "mac-arm64", "win-x64", "win-arm64"];

async function readSizeAndSha512(path) {
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { size: (await stat(path)).size, sha512: hash.digest("base64") };
}

async function copyVerified(source, destination, expected) {
  const actual = await readSizeAndSha512(source);
  if (actual.size !== expected.size || actual.sha512 !== expected.sha512) {
    throw new Error(`builder checksum mismatch: ${source}`);
  }
  try {
    const existing = await readSizeAndSha512(destination);
    if (existing.size !== actual.size || existing.sha512 !== actual.sha512) {
      throw new Error(`release output already contains different bytes: ${destination}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await copyFile(source, destination);
  }
}

function expectedNames(version, target) {
  const [platform, arch] = target.split("-");
  const stem = `LinkAgent-${version}-${platform}-${arch}`;
  return platform === "mac" ? [`${stem}.zip`, `${stem}.dmg`] : [`${stem}.exe`];
}

export async function assembleLinkAgentRelease({
  version,
  inputs,
  output,
  selectedTargets = allTargets,
  signingKeyFile = process.env.LINKAGENT_UPDATE_SIGNING_KEY_FILE,
  trustedPublicKey = UPDATE_PUBLIC_KEY,
}) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`invalid release version: ${version}`);
  }
  if (
    !Array.isArray(selectedTargets) ||
    selectedTargets.length === 0 ||
    new Set(selectedTargets).size !== selectedTargets.length ||
    selectedTargets.some((target) => !allTargets.includes(target))
  ) {
    throw new Error(`invalid release targets: ${JSON.stringify(selectedTargets)}`);
  }
  // 三平台发布不能隐式要求未构建的 Windows ARM64；仍按固定顺序保留旧版 x64 fallback。
  const targets = allTargets.filter((target) => selectedTargets.includes(target));
  const needsSignedMacUpdate =
    Number(version.split(".")[0]) >= 4 && targets.some((target) => target.startsWith("mac-"));
  let signingKey;
  if (needsSignedMacUpdate) {
    if (!signingKeyFile)
      throw new Error(
        "Mac internal updates require LINKAGENT_UPDATE_SIGNING_KEY_FILE; never regenerate the pinned release key",
      );
    signingKey = createPrivateKey(await readFile(signingKeyFile));
    if (
      signingKey.asymmetricKeyType !== "ed25519" ||
      !createPublicKey(signingKey)
        .export({ type: "spki", format: "der" })
        .equals(createPublicKey(trustedPublicKey).export({ type: "spki", format: "der" }))
    )
      throw new Error("Release signing key does not match the client's pinned public key");
  }
  const collected = { mac: [], win: [] };
  await mkdir(output, { recursive: true });

  for (const target of targets) {
    const directory = inputs[target];
    if (!directory) throw new Error(`missing input directory: ${target}`);
    const platform = target.startsWith("mac-") ? "mac" : "win";
    const manifestName = platform === "mac" ? "latest-mac.yml" : "latest.yml";
    const manifest = parse(await readFile(join(directory, manifestName), "utf8"));
    if (manifest?.version !== version || !Array.isArray(manifest.files)) {
      throw new Error(`wrong version or missing files in ${target}/${manifestName}`);
    }
    for (const name of expectedNames(version, target)) {
      const entry = manifest.files.find((file) => file?.url === name);
      if (!entry || typeof entry.sha512 !== "string" || !Number.isSafeInteger(entry.size)) {
        throw new Error(`missing expected artifact in ${target}/${manifestName}: ${name}`);
      }
      await copyVerified(join(directory, name), join(output, name), entry);
      // 差分下载可能读取 blockmap；缺失时必须在公开发布前失败，而非客户端回退整包。
      const blockmap = `${name}.blockmap`;
      await copyVerified(
        join(directory, blockmap),
        join(output, blockmap),
        await readSizeAndSha512(join(directory, blockmap)),
      );
      collected[platform].push({ url: name, sha512: entry.sha512, size: entry.size });
    }
  }

  const releaseDate = new Date().toISOString();
  for (const [platform, filename] of [
    ["mac", "latest-mac.yml"],
    ["win", "latest.yml"],
  ]) {
    const files = collected[platform];
    if (files.length === 0) continue;
    // x64 排在前面供旧版 fallback 使用；electron-updater 6.8.3 按文件名里的 process.arch 选包。
    const first = files[0];
    await writeFile(
      join(output, filename),
      stringify({ version, files, path: first.url, sha512: first.sha512, releaseDate }),
      { flag: "wx" },
    );
  }
  if (needsSignedMacUpdate) {
    const files = collected.mac
      .filter((file) => file.url.endsWith(".zip"))
      .map((file) => ({
        arch: file.url.includes("-arm64.") ? "arm64" : "x64",
        name: file.url,
        size: file.size,
        sha512: file.sha512,
      }));
    const envelope = createSignedUpdate({ version, files }, signingKey);
    for (const file of files)
      verifySignedUpdate(envelope, { version, arch: file.arch }, trustedPublicKey);
    await writeFile(join(output, UPDATE_MANIFEST_NAME), JSON.stringify(envelope, null, 2) + "\n", {
      flag: "wx",
    });
  }
  return collected;
}

function readArg(name) {
  const position = process.argv.indexOf(name);
  return position < 0 ? null : (process.argv[position + 1] ?? null);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const version = readArg("--version");
  const inputRoot = readArg("--input-root");
  const output = readArg("--output");
  const targetArgument = readArg("--targets");
  if (!version || !inputRoot || !output) {
    throw new Error(
      "usage: assemble-linkagent-release --version V --input-root DIR --output DIR [--targets mac-x64,mac-arm64,win-x64,win-arm64]",
    );
  }
  if (process.argv.includes("--targets") && !targetArgument) {
    throw new Error("invalid release targets: --targets requires a comma-separated selection");
  }
  const selectedTargets = targetArgument?.split(",").map((target) => target.trim()) ?? allTargets;
  const inputs = Object.fromEntries(allTargets.map((target) => [target, join(inputRoot, target)]));
  const files = await assembleLinkAgentRelease({ version, inputs, output, selectedTargets });
  console.log(
    `[linkagent-release] verified ${files.mac.length} macOS and ${files.win.length} Windows artifacts in ${output}`,
  );
}
