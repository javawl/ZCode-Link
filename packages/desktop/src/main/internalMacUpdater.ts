import { app } from "electron";
import pkg from "electron-updater";
import type { DownloadUpdateOptions } from "electron-updater/out/AppUpdater.js";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import semver from "semver";
import yauzl from "yauzl";
import {
  downloadVerifiedArchive,
  UPDATE_MANIFEST_NAME,
  validateArchiveEntry,
  verifyArchiveFile,
  verifySignedUpdate,
} from "../../resources/internal-update/internal-update-protocol.mjs";
import {
  macAppPath,
  prepareMacInstall,
} from "../../resources/internal-update/mac-update-install.mjs";

export async function validateMacUpdateZip(path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(error ?? new Error("Invalid update ZIP"));
      let count = 0;
      let expandedBytes = 0;
      const fail = (failure: unknown) => {
        zip.close();
        reject(failure);
      };
      zip.on("error", fail);
      zip.on("end", resolve);
      zip.on("entry", (entry) => {
        void (async () => {
          validateArchiveEntry(entry.fileName);
          expandedBytes += entry.uncompressedSize;
          if (++count > 200_000 || expandedBytes > 6 * 2 ** 30)
            throw new Error("Update ZIP exceeds extraction limit");
          if (((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000) {
            if (entry.uncompressedSize > 4096) throw new Error("Invalid update symlink");
            const target = await new Promise<string>((done, failStream) => {
              zip.openReadStream(entry, (streamError, stream) => {
                if (streamError || !stream) return failStream(streamError);
                const chunks: Buffer[] = [];
                stream.on("data", (chunk: Buffer) => chunks.push(chunk));
                stream.on("error", failStream);
                stream.on("end", () => done(Buffer.concat(chunks).toString("utf8")));
              });
            });
            validateArchiveEntry(entry.fileName, target);
          }
          zip.readEntry();
        })().catch(fail);
      });
      zip.readEntry();
    });
  });
}

// 内部 Mac 不把 ZIP 交给要求 Apple 签名的 Squirrel；检查、缓存和 UI 事件仍复用同一 updater。
export class InternalMacUpdater extends pkg.AppUpdater {
  private signedUpdate: { payload: string; signature: string } | null = null;
  private downloadedVersion: string | null = null;
  private preparedPlan: Awaited<ReturnType<typeof prepareMacInstall>> | null = null;
  private installHelper: ChildProcess | null = null;

  constructor() {
    super(undefined);
  }

  protected override async doDownloadUpdate(options: DownloadUpdateOptions): Promise<string[]> {
    const { info, provider } = options.updateInfoAndProvider;
    const name = `LinkAgent-${info.version}-mac-${process.arch}.zip`;
    const file = provider
      .resolveFiles(info)
      .find((candidate) => basename(decodeURIComponent(candidate.url.pathname)) === name);
    if (!file) throw new Error("No update ZIP for the running Mac architecture");
    const controller = new AbortController();
    const cancel = () => controller.abort(new Error("Update download cancelled"));
    options.cancellationToken.once("cancel", cancel);
    if (options.cancellationToken.cancelled) cancel();
    try {
      const manifestUrl = new URL(UPDATE_MANIFEST_NAME, file.url);
      const response = await this.netSession.fetch(manifestUrl.href, { signal: controller.signal });
      if (!response.ok || !response.body)
        throw new Error(`Signed update manifest unavailable: HTTP ${response.status}`);
      let length = 0;
      const chunks: Uint8Array[] = [];
      for await (const chunk of response.body) {
        length += chunk.length;
        if (length > 65_536) {
          controller.abort();
          throw new Error("Update manifest exceeds size limit");
        }
        chunks.push(chunk);
      }
      const signedUpdate = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const expected = verifySignedUpdate(signedUpdate, {
        version: info.version,
        arch: process.arch,
      });
      if (file.info.sha512 !== expected.sha512 || file.info.size !== expected.size)
        throw new Error("GitHub manifest does not match the signed update");
      return await this.executeDownload({
        fileExtension: "zip",
        fileInfo: file,
        downloadUpdateOptions: options,
        task: (destination, downloadOptions) =>
          downloadVerifiedArchive({
            url: file.url.href,
            destination,
            expected,
            signal: controller.signal,
            fetcher: (url: string, request: RequestInit) => this.netSession.fetch(url, request),
            onProgress: downloadOptions.onProgress,
          }),
        done: async (event) => {
          controller.signal.throwIfAborted();
          await verifyArchiveFile(event.downloadedFile, expected);
          await validateMacUpdateZip(event.downloadedFile);
          controller.signal.throwIfAborted();
          await this.cancelPreparedInstall();
          this.signedUpdate = signedUpdate;
          this.downloadedVersion = info.version;
          this.dispatchUpdateDownloaded(event);
        },
      });
    } finally {
      options.cancellationToken.removeListener("cancel", cancel);
    }
  }

  async prepareForInstall(): Promise<void> {
    const archivePath = this.downloadedUpdateHelper?.file;
    if (
      !archivePath ||
      !this.signedUpdate ||
      !this.downloadedVersion ||
      !semver.gt(this.downloadedVersion, app.getVersion())
    )
      throw new Error("No newer verified Mac update is ready");
    if (
      this.preparedPlan &&
      this.installHelper?.exitCode === null &&
      this.installHelper.signalCode === null
    )
      return;
    await this.cancelPreparedInstall();
    const launchEnvironment = Object.fromEntries(
      [
        "ZCODE_DATA_BASE_DIR",
        "ZCODE_HOME",
        "ZCODE_DESKTOP_HOME_DIR",
        "ZCODE_DESKTOP_USER_DATA_DIR",
        "ZCODE_DESKTOP_APPLICATION_NAME",
        "ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT",
      ].flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])),
    );
    this.preparedPlan = await prepareMacInstall({
      appPath: macAppPath(process.execPath),
      archivePath,
      signedUpdate: this.signedUpdate,
      version: this.downloadedVersion,
      arch: process.arch,
      currentVersion: app.getVersion(),
      userDataPath: app.getPath("userData"),
      parentPid: process.pid,
      launchEnvironment,
      helperSourceDir: join(process.resourcesPath, "internal-update"),
    });
    try {
      await this.startInstallHelper();
    } catch (error) {
      await this.cancelPreparedInstall();
      throw error;
    }
  }

  private async startInstallHelper(): Promise<void> {
    const plan = this.preparedPlan!;
    const child = spawn(
      process.execPath,
      [join(plan.jobPath, "mac-update-helper.mjs"), join(plan.jobPath, "plan.json")],
      {
        detached: true,
        stdio: "ignore",
        env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME, ELECTRON_RUN_AS_NODE: "1" },
      },
    );
    this.installHelper = child;
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
    const end = Date.now() + 15_000;
    while (Date.now() < end) {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error("Mac install helper exited before readiness");
      try {
        const ready = JSON.parse(await readFile(join(plan.jobPath, "helper-ready.json"), "utf8"));
        if (ready.token !== plan.token || ready.pid !== child.pid)
          throw new Error("Invalid Mac install helper readiness");
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await delay(100);
    }
    child.kill("SIGTERM");
    throw new Error("Mac install helper did not become ready before deadline");
  }

  async cancelPreparedInstall(): Promise<void> {
    const child = this.installHelper;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      for (let i = 0; i < 100 && child.exitCode === null && child.signalCode === null; i++)
        await delay(50);
      if (child.exitCode === null && child.signalCode === null)
        throw new Error("Install helper has not acknowledged cancellation");
    }
    this.installHelper = null;
    if (this.preparedPlan) await rm(this.preparedPlan.jobPath, { recursive: true, force: true });
    this.preparedPlan = null;
  }

  override async quitAndInstall(): Promise<void> {
    if (
      !this.preparedPlan ||
      !this.installHelper ||
      this.installHelper.exitCode !== null ||
      this.installHelper.signalCode !== null
    )
      throw new Error("Mac install helper is not ready");
    app.quit();
  }
}
