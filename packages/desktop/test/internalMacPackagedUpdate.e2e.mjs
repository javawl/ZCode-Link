import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { cp, mkdtemp, mkdir, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { _electron } from "playwright-core";
import { stringify } from "yaml";
import { createSignedUpdate } from "../resources/internal-update/internal-update-protocol.mjs";

const execute = promisify(execFile);
const appSource = process.env.LINKAGENT_MAC_QA_APP;
const keyFile = process.env.LINKAGENT_UPDATE_SIGNING_KEY_FILE;
const enabled = process.platform === "darwin" && appSource && keyFile;

async function patchFixtureAsar(path, failStartup) {
  const handle = await open(path, "r+");
  try {
    const prefix = Buffer.alloc(16);
    await handle.read(prefix, 0, 16, 0);
    const headerSize = prefix.readUInt32LE(4);
    const jsonSize = prefix.readUInt32LE(12);
    const json = Buffer.alloc(jsonSize);
    await handle.read(json, 0, jsonSize, 16);
    const header = JSON.parse(json.toString());
    for (const name of ["package.json", ...(failStartup ? ["out/main/index.js"] : [])]) {
      let entry = header;
      for (const part of name.split("/")) entry = entry.files[part];
      assert(!entry.unpacked);
      const data = Buffer.alloc(entry.size);
      const offset = 8 + headerSize + Number(entry.offset);
      await handle.read(data, 0, data.length, offset);
      const replaced =
        name === "package.json"
          ? Buffer.from(data.toString().replace(/("version"\s*:\s*")4\.0\.0(")/, "$14.0.1$2"))
          : Buffer.from("process.exit(42);".padEnd(data.length, " "));
      assert.equal(replaced.length, data.length);
      if (entry.integrity) {
        entry.integrity.hash = createHash("sha256").update(replaced).digest("hex");
        entry.integrity.blocks = [];
        for (let i = 0; i < replaced.length; i += entry.integrity.blockSize)
          entry.integrity.blocks.push(
            createHash("sha256")
              .update(replaced.subarray(i, i + entry.integrity.blockSize))
              .digest("hex"),
          );
      }
      await handle.write(replaced, 0, replaced.length, offset);
    }
    const updated = Buffer.from(JSON.stringify(header));
    assert.equal(updated.length, json.length);
    await handle.write(updated, 0, updated.length, 16);
    return createHash("sha256").update(updated).digest("hex");
  } finally {
    await handle.close();
  }
}

for (const failStartup of [false, true]) {
  test(
    `packaged 4.0.0 ${failStartup ? "rolls back after a failed successor" : "installs and launches a verified 4.0.1"}`,
    { timeout: 360_000, skip: !enabled },
    async (t) => {
      const temporary = await mkdtemp(join(tmpdir(), "linkagent-packaged-update-"));
      const root = await realpath(temporary);
      const oldApp = join(root, "LinkAgent.app");
      const candidateRoot = join(root, "candidate");
      const candidate = join(candidateRoot, "LinkAgent.app");
      const data = join(root, "data");
      await mkdir(candidateRoot);
      await mkdir(data);
      await execute("/usr/bin/ditto", [appSource, oldApp], { timeout: 120_000 });
      await execute("/usr/bin/ditto", [appSource, candidate], { timeout: 120_000 });
      const plist = join(candidate, "Contents/Info.plist");
      for (const key of ["CFBundleShortVersionString", "CFBundleVersion"])
        await execute("/usr/libexec/PlistBuddy", ["-c", `Set :${key} 4.0.1`, plist]);
      const headerHash = await patchFixtureAsar(
        join(candidate, "Contents/Resources/app.asar"),
        failStartup,
      );
      await execute("/usr/libexec/PlistBuddy", [
        "-c",
        `Set :ElectronAsarIntegrity:Resources/app.asar:hash ${headerHash}`,
        plist,
      ]);
      const { stdout: archText } = await execute("/usr/bin/lipo", [
        "-archs",
        join(candidate, "Contents/MacOS/LinkAgent"),
      ]);
      const arch = archText.trim() === "arm64" ? "arm64" : "x64";
      const version = "4.0.1";
      const name = `LinkAgent-${version}-mac-${arch}.zip`;
      const archivePath = join(root, name);
      await execute("/usr/bin/ditto", ["-c", "-k", "--keepParent", candidate, archivePath], {
        timeout: 120_000,
      });
      const archive = await readFile(archivePath);
      const file = {
        arch,
        name,
        size: archive.length,
        sha512: createHash("sha512").update(archive).digest("base64"),
      };
      const signed = createSignedUpdate({ version, files: [file] }, await readFile(keyFile));
      const server = createServer((request, response) => {
        const path = new URL(request.url, "http://localhost").pathname;
        if (path.endsWith(".atom"))
          return response.end(
            `<feed><entry><title>Internal update QA</title><link href="https://github.com/javawl/ZCode-Link/releases/tag/v4.0.1"/><content>Local QA only</content></entry></feed>`,
          );
        if (path.endsWith("/latest")) return response.end(JSON.stringify({ tag_name: "v4.0.1" }));
        if (path.endsWith("/latest-mac.yml"))
          return response.end(
            stringify({
              version,
              files: [{ url: name, size: file.size, sha512: file.sha512 }],
              path: name,
              sha512: file.sha512,
            }),
          );
        if (path.endsWith("/linkagent-update.json")) return response.end(JSON.stringify(signed));
        if (basename(path) === name) {
          response.writeHead(200, { "Content-Length": archive.length });
          createReadStream(archivePath).pipe(response);
          return;
        }
        response.writeHead(404).end();
      });
      await new Promise((done) => server.listen(0, "127.0.0.1", done));
      let electron;
      let result;
      let stage = "launch";
      let stderr = "";
      const evidence = process.env.LINKAGENT_UPDATE_QA_EVIDENCE_DIR;
      t.after(async () => {
        server.closeAllConnections();
        server.close();
        if (!result && evidence) {
          const failurePath = join(
            evidence,
            `${arch}-${failStartup ? "rollback" : "success"}-failure`,
          );
          await mkdir(failurePath, { recursive: true });
          await writeFile(join(failurePath, "stderr.txt"), stderr);
          await cp(join(data, ".zcode/v2/logs"), join(failurePath, "logs"), {
            recursive: true,
          }).catch(() => {});
          console.error(
            `Packaged ${arch} failed at ${stage}; windows: ${electron
              ?.windows()
              .map((window) => window.url())
              .join(", ")}`,
          );
          for (const [i, window] of (electron?.windows() ?? []).entries())
            await window.screenshot({ path: join(failurePath, `window-${i}.png`) }).catch(() => {});
        }
        if (result?.pid) {
          try {
            process.kill(-result.pid, "SIGTERM");
          } catch (error) {
            if (error.code !== "ESRCH") throw error;
          }
        }
        await electron?.close().catch(() => {});
        await delay(500);
        await rm(root, { recursive: true, force: true });
      });
      const port = server.address().port;
      const sentinel = join(data, "settings-and-tasks-sentinel.txt");
      await writeFile(sentinel, "Keep existing user data");
      electron = await _electron.launch({
        executablePath: join(oldApp, "Contents/MacOS/LinkAgent"),
        args: [],
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: undefined,
          ZCODE_DATA_BASE_DIR: data,
          ZCODE_HOME: join(data, ".zcode"),
          ZCODE_DESKTOP_HOME_DIR: data,
          ZCODE_DESKTOP_USER_DATA_DIR: join(data, "electron"),
          ZCODE_DESKTOP_APPLICATION_NAME: "LinkAgent Update QA",
          ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT: "1",
        },
      });
      electron.process().stderr.on("data", (chunk) => {
        stderr = (stderr + chunk).slice(-1_000_000);
      });
      const page = await electron.firstWindow();
      page.setDefaultTimeout(90_000);
      stage = "main window ready";
      await page.getByTestId("task-settings-button").waitFor();
      stage = "check";
      await electron.evaluate(({ session }, port) => {
        session.fromPartition("electron-updater", { cache: false }).webRequest.onBeforeRequest(
          {
            urls: [
              "https://github.com/javawl/ZCode-Link/*",
              "https://api.github.com/repos/javawl/ZCode-Link/*",
            ],
          },
          (details, callback) =>
            callback({ redirectURL: `http://127.0.0.1:${port}${new URL(details.url).pathname}` }),
        );
      }, port);
      const deadline = Date.now() + 120_000;
      while ((await page.evaluate(() => window.zcode.getUpdateState())).kind === "checking") {
        assert(Date.now() < deadline, "initial check must finish");
        await delay(200);
      }
      await electron.evaluate(({ Menu }) => {
        const item = Menu.getApplicationMenu().getMenuItemById("check-for-update");
        item.click(item, null, {});
      });
      let state;
      do {
        state = await page.evaluate(() => window.zcode.getUpdateState());
        assert(Date.now() < deadline, JSON.stringify(state));
        await delay(200);
      } while (state.kind !== "update-available");
      stage = "download";
      await page.evaluate(() => window.zcode.downloadUpdate());
      do {
        state = await page.evaluate(() => window.zcode.getUpdateState());
        assert(Date.now() < deadline, JSON.stringify(state));
        await delay(200);
      } while (state.kind !== "update-downloaded");
      if (evidence) {
        await mkdir(evidence, { recursive: true });
        await page.screenshot({
          path: join(evidence, `${arch}-${failStartup ? "rollback" : "success"}-ready.png`),
        });
      }
      stage = "install";
      const install = page.evaluate(() => window.zcode.quitAndInstallUpdate()).catch(() => {});
      const resultPath = join(data, "electron/internal-mac-update/last-result.json");
      const installDeadline = Date.now() + 180_000;
      do {
        try {
          result = JSON.parse(await readFile(resultPath, "utf8"));
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        assert(Date.now() < installDeadline, "packaged install did not finish");
        await delay(200);
      } while (!result?.pid);
      await install;
      assert.equal(result.status, failStartup ? "rolled-back" : "installed");
      const { stdout } = await execute("/usr/libexec/PlistBuddy", [
        "-c",
        "Print :CFBundleShortVersionString",
        join(oldApp, "Contents/Info.plist"),
      ]);
      assert.equal(stdout.trim(), failStartup ? "4.0.0" : "4.0.1");
      assert.equal(await readFile(sentinel, "utf8"), "Keep existing user data");
      process.kill(result.pid, 0);
      console.log(
        `Verified packaged ${arch}: ${result.status}; successor main-window acknowledgement and user data checked`,
      );
    },
  );
}
