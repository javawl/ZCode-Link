import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { _electron } from "playwright-core";
import { stringify } from "yaml";
import yazl from "yazl";
import { createSignedUpdate } from "../resources/internal-update/internal-update-protocol.mjs";

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, "../../..");
const keyFile = process.env.LINKAGENT_UPDATE_SIGNING_KEY_FILE;

test(
  "Electron Mac updater downloads, revalidates cache, rejects bad signatures and cancels without ready",
  { timeout: 60_000, skip: !keyFile || process.platform !== "darwin" },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "linkagent-updater-e2e-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.alloc(4 * 1024 * 1024, 42), "LinkAgent.app/Contents/fixture", {
      compress: false,
    });
    zip.end();
    const chunks = [];
    for await (const chunk of zip.outputStream) chunks.push(chunk);
    const archive = Buffer.concat(chunks);
    const version = "4.0.1";
    const name = `LinkAgent-${version}-mac-${process.arch}.zip`;
    const file = {
      arch: process.arch,
      name,
      size: archive.length,
      sha512: createHash("sha512").update(archive).digest("base64"),
    };
    const signed = createSignedUpdate({ version, files: [file] }, await readFile(keyFile));
    let mode = "valid";
    let downloads = 0;
    const server = createServer((request, response) => {
      const path = new URL(request.url, "http://localhost").pathname;
      if (path === "/latest-mac.yml")
        return response.end(
          stringify({
            version,
            files: [{ url: name, size: file.size, sha512: file.sha512 }],
            path: name,
            sha512: file.sha512,
          }),
        );
      if (path === "/linkagent-update.json")
        return response.end(
          JSON.stringify(
            mode === "bad-signature" ? { ...signed, signature: "A".repeat(86) + "==" } : signed,
          ),
        );
      if (path === "/" + name) {
        downloads++;
        response.writeHead(200, { "Content-Length": archive.length });
        if (mode !== "slow") return response.end(archive);
        let offset = 0;
        const timer = setInterval(() => {
          response.write(archive.subarray(offset, (offset += 8192)));
          if (offset >= archive.length) {
            clearInterval(timer);
            response.end();
          }
        }, 10);
        response.on("close", () => clearInterval(timer));
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    const url = `http://127.0.0.1:${server.address().port}`;
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "linkagent-update-e2e", version: "4.0.0", main: "main.cjs" }),
    );
    await symlink(join(root, "node_modules"), join(dir, "node_modules"));
    await mkdir(join(dir, "data"));
    const source = `import {app,BrowserWindow} from 'electron';
import pkg,{CancellationToken} from 'electron-updater';
import {InternalMacUpdater} from ${JSON.stringify(join(root, "packages/desktop/src/main/internalMacUpdater.ts"))};
app.setPath('userData',${JSON.stringify(join(dir, "data"))});
app.whenReady().then(()=>{const win=new BrowserWindow({show:false});win.loadURL('data:text/html,Update QA');
let updater,token;const events=[];
globalThis.harness={reset(){updater=new InternalMacUpdater();updater.forceDevUpdateConfig=true;updater.autoDownload=false;updater.updateConfigPath=${JSON.stringify(join(dir, "app-update.yml"))};updater.setFeedURL({provider:'generic',url:${JSON.stringify(url)}});for(const event of ['update-downloaded','download-progress','error'])updater.on(event,(data)=>events.push({event,version:data.version}));},async check(){return (await updater.checkForUpdates()).updateInfo.version;},async download(){token=new CancellationToken();try{return {files:await updater.downloadUpdate(token)}}catch(e){return {error:e.message}}},cancel(){token.cancel();},events};globalThis.harness.reset();});`;
    await writeFile(join(dir, "app-update.yml"), "updaterCacheDirName: linkagent-e2e-cache\n");
    await writeFile(join(dir, "entry.ts"), source);
    await build({
      entryPoints: [join(dir, "entry.ts")],
      outfile: join(dir, "main.cjs"),
      bundle: true,
      platform: "node",
      format: "cjs",
      external: ["electron", "yauzl"],
    });
    const electron = await _electron.launch({
      executablePath: require("electron"),
      args: [dir],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
    });
    t.after(() => electron.close());
    await electron.firstWindow();
    assert.equal(await electron.evaluate(() => globalThis.harness.check()), version);
    const downloaded = await electron.evaluate(() => globalThis.harness.download());
    assert.equal(downloaded.error, undefined);
    assert.equal(downloads, 1);
    await electron.evaluate(() => globalThis.harness.download());
    assert.equal(downloads, 1, "verified cache should be reused");
    const before = await electron.evaluate(
      () => globalThis.harness.events.filter((e) => e.event === "update-downloaded").length,
    );
    mode = "bad-signature";
    const refused = await electron.evaluate(() => globalThis.harness.download());
    assert.match(refused.error, /signature/);
    assert.equal(
      await electron.evaluate(
        () => globalThis.harness.events.filter((e) => e.event === "update-downloaded").length,
      ),
      before,
    );
    mode = "slow";
    await rm(downloaded.files[0], { force: true });
    const cancelling = electron.evaluate(() => globalThis.harness.download());
    await new Promise((done) => setTimeout(done, 200));
    await electron.evaluate(() => globalThis.harness.cancel());
    assert.match((await cancelling).error, /cancel|abort/i);
    assert.equal(
      await electron.evaluate(
        () => globalThis.harness.events.filter((e) => e.event === "update-downloaded").length,
      ),
      before,
    );
  },
);
