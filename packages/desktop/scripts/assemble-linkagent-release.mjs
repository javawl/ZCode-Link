import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse, stringify } from "yaml";

const targets = ["mac-x64", "mac-arm64", "win-x64", "win-arm64"];

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

export async function assembleLinkAgentRelease({ version, inputs, output }) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`invalid release version: ${version}`);
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
    // x64 排在前面供旧版 fallback 使用；electron-updater 6.8.3 按文件名里的 process.arch 选包。
    const first = files[0];
    await writeFile(
      join(output, filename),
      stringify({ version, files, path: first.url, sha512: first.sha512, releaseDate }),
      { flag: "wx" },
    );
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
  if (!version || !inputRoot || !output) {
    throw new Error("usage: assemble-linkagent-release --version V --input-root DIR --output DIR");
  }
  const inputs = Object.fromEntries(targets.map((target) => [target, join(inputRoot, target)]));
  const files = await assembleLinkAgentRelease({ version, inputs, output });
  console.log(
    `[linkagent-release] verified ${files.mac.length} macOS and ${files.win.length} Windows artifacts in ${output}`,
  );
}
