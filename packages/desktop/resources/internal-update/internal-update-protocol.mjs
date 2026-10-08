import { createHash, sign, verify } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, posix } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

// 内部更新不能把未签名的 GitHub 元数据直接当可信代码；公钥随 4.0.0 固定，私钥不入库。
export const UPDATE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAAXFDA07Jfd+zbiC0vVxpq2a+ajGApyih+h6eV0IfoOw=
-----END PUBLIC KEY-----
`;
export const UPDATE_MANIFEST_NAME = "linkagent-update.json";
export const UPDATE_REPOSITORY = "javawl/ZCode-Link";
export const UPDATE_APP_ID = "dev.linkagent.app";

export function createSignedUpdate({ version, files }, privateKey) {
  const payload = JSON.stringify({
    schemaVersion: 1,
    repository: UPDATE_REPOSITORY,
    appId: UPDATE_APP_ID,
    version,
    files,
  });
  return { payload, signature: sign(null, Buffer.from(payload), privateKey).toString("base64") };
}

export function verifySignedUpdate(envelope, { version, arch }, publicKey = UPDATE_PUBLIC_KEY) {
  if (
    typeof envelope?.payload !== "string" ||
    envelope.payload.length > 32_768 ||
    typeof envelope.signature !== "string" ||
    !/^[A-Za-z0-9+/]{86}==$/.test(envelope.signature) ||
    !verify(
      null,
      Buffer.from(envelope.payload),
      publicKey,
      Buffer.from(envelope.signature, "base64"),
    )
  ) {
    throw new Error("Invalid LinkAgent update signature");
  }
  const payload = JSON.parse(envelope.payload);
  if (
    payload.schemaVersion !== 1 ||
    payload.repository !== UPDATE_REPOSITORY ||
    payload.appId !== UPDATE_APP_ID
  )
    throw new Error("Wrong update repository or app identity");
  if (payload.version !== version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
    throw new Error("Wrong update version");
  if (
    !Array.isArray(payload.files) ||
    payload.files.length < 1 ||
    payload.files.length > 2 ||
    new Set(payload.files.map((f) => f.arch)).size !== payload.files.length
  )
    throw new Error("Invalid update architecture list");
  for (const f of payload.files) {
    if (
      !["arm64", "x64"].includes(f.arch) ||
      f.name !== `LinkAgent-${version}-mac-${f.arch}.zip` ||
      !Number.isSafeInteger(f.size) ||
      f.size <= 0 ||
      f.size > 2 ** 31 ||
      typeof f.sha512 !== "string" ||
      !/^[A-Za-z0-9+/]{86}==$/.test(f.sha512)
    )
      throw new Error("Invalid update file metadata");
  }
  const file = payload.files.find((f) => f.arch === arch);
  if (!file) throw new Error("Update architecture is unavailable");
  return file;
}

export async function verifyArchiveFile(path, expected) {
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if ((await stat(path)).size !== expected.size || hash.digest("base64") !== expected.sha512)
    throw new Error("Update archive size/checksum mismatch");
}

export function validateArchiveEntry(name, symlinkTarget) {
  const hasControl = (value) => [...value].some((char) => char.charCodeAt(0) < 32);
  if (
    typeof name !== "string" ||
    name.includes("\\") ||
    hasControl(name) ||
    name.startsWith("/") ||
    name.split("/").includes("..") ||
    !/^(LinkAgent\.app(?:\/|$)|__MACOSX\/)/.test(name)
  )
    throw new Error("Unsafe archive entry");
  if (symlinkTarget !== undefined) {
    const target = posix.normalize(posix.join(posix.dirname(name), symlinkTarget));
    if (
      symlinkTarget.startsWith("/") ||
      hasControl(symlinkTarget) ||
      symlinkTarget.includes("\\") ||
      !target.startsWith("LinkAgent.app/")
    )
      throw new Error("Unsafe archive symlink");
  }
}

export async function downloadVerifiedArchive({
  url,
  destination,
  expected,
  signal,
  fetcher = fetch,
  onProgress,
}) {
  signal?.throwIfAborted();
  await mkdir(dirname(destination), { recursive: true });
  let transferred = 0;
  const hash = createHash("sha512");
  const start = Date.now();
  try {
    const response = await fetcher(url, { signal });
    if (!response.ok || !response.body)
      throw new Error(`Update download failed: HTTP ${response.status}`);
    const transform = new Transform({
      transform(chunk, _encoding, callback) {
        transferred += chunk.length;
        hash.update(chunk);
        if (transferred > expected.size) return callback(new Error("Update size mismatch"));
        onProgress?.({
          total: expected.size,
          transferred,
          delta: chunk.length,
          percent: (transferred / expected.size) * 100,
          bytesPerSecond: Math.round(transferred / Math.max((Date.now() - start) / 1000, 0.001)),
        });
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body),
      transform,
      createWriteStream(destination, { flags: "wx", mode: 0o600 }),
      { signal },
    );
    signal?.throwIfAborted();
    if (transferred !== expected.size || hash.digest("base64") !== expected.sha512)
      throw new Error("Update size/checksum mismatch");
  } catch (error) {
    await rm(destination, { force: true });
    throw error;
  }
}
