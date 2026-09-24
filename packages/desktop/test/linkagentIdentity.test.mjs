import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { Icns } from "@fiahfy/icns";
import {
  resolveDesktopProductIdentity,
  resolveWindowsAppUserModelId,
  DESKTOP_UPDATES_ENABLED,
  DESKTOP_FORCE_UPDATES_ENABLED,
  LINKAGENT_UPDATE_REPOSITORY,
} from "../scripts/desktop-product-identity.mjs";
import {
  DEV_ELECTRON_APP_NAME,
  DEV_ELECTRON_APP_BUNDLE_ID,
} from "../scripts/devElectronAppBundle.mjs";

test("packaged LinkAgent uses a separate identity on every desktop platform", () => {
  const identity = resolveDesktopProductIdentity({ ZCODE_ENV: "production" });
  assert.equal(identity.productName, "LinkAgent");
  assert.equal(identity.appId, "dev.linkagent.app");
  assert.equal(identity.linuxExecutableName, "linkagent");
  assert.equal(identity.linuxPackageName, "linkagent");
  assert.equal(resolveWindowsAppUserModelId({ ZCODE_ENV: "production" }), identity.appId);
});

test("LinkAgent enables only its own GitHub release feed", () => {
  assert.equal(DESKTOP_UPDATES_ENABLED, true);
  assert.equal(DESKTOP_FORCE_UPDATES_ENABLED, false);
  assert.deepEqual(LINKAGENT_UPDATE_REPOSITORY, {
    provider: "github",
    owner: "javawl",
    repo: "ZCode-Link",
  });
});

test("desktop icon formats contain the expected dimensions and alpha", async () => {
  for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
    const png = await readFile(new URL(`../build/icons/${size}x${size}.png`, import.meta.url));
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
    assert.equal(png[25], 6, "RGBA color type must preserve generated alpha");
  }
  const ico = await readFile(new URL("../build/icon.ico", import.meta.url));
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 7);
  const icns = Icns.from(await readFile(new URL("../build/icon.icns", import.meta.url)));
  assert.equal(icns.images.length, 7);
});

test("preview and dev do not take over the original ZCode installation identity", () => {
  const identity = resolveDesktopProductIdentity({ ZCODE_ENV: "test" });
  assert.equal(identity.productName, "LinkAgent Preview");
  assert.equal(identity.appId, "dev.linkagent.app.preview");
  assert.equal(identity.linuxExecutableName, "linkagent-preview");
  assert.equal(DEV_ELECTRON_APP_NAME, "LinkAgent Dev");
  assert.equal(DEV_ELECTRON_APP_BUNDLE_ID, "dev.linkagent.app.development");
});
