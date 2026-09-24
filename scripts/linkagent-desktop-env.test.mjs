import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";

import {
  LINK_AGENT_DEV_DATA_BASE_DIR_ENV,
  createLinkAgentDesktopEnvOverrides,
} from "./linkagent-desktop-env.mjs";

test("defaults every LinkAgent desktop path to the same isolated data root", () => {
  const homeDir = resolve("fixtures", "linkagent-home");
  const overrides = createLinkAgentDesktopEnvOverrides(
    {
      ZCODE_DATA_BASE_DIR: resolve("fixtures", "zcode-home"),
      ZCODE_DESKTOP_HOME_DIR: resolve("fixtures", "another-zcode-home"),
      ZCODE_HOME: resolve("fixtures", "zcode-storage"),
      ZCODE_DESKTOP_USER_DATA_DIR: resolve("fixtures", "zcode-electron"),
    },
    homeDir,
  );
  const expectedRoot = resolve(homeDir, ".zcode-link-dev-home");

  assert.deepEqual(overrides, {
    ZCODE_DATA_BASE_DIR: expectedRoot,
    ZCODE_DESKTOP_HOME_DIR: expectedRoot,
    ZCODE_HOME: resolve(expectedRoot, ".zcode"),
    ZCODE_DESKTOP_USER_DATA_DIR: resolve(expectedRoot, "electron-user-data"),
    ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT: "1",
  });
});

test("uses only the dedicated absolute LinkAgent data-root override", () => {
  const configuredRoot = resolve("fixtures", "alternate-linkagent-home");
  const overrides = createLinkAgentDesktopEnvOverrides({
    [LINK_AGENT_DEV_DATA_BASE_DIR_ENV]: `  ${configuredRoot}  `,
    ZCODE_DATA_BASE_DIR: resolve("fixtures", "zcode-home"),
  });

  assert.equal(overrides.ZCODE_DATA_BASE_DIR, configuredRoot);
  assert.equal(overrides.ZCODE_DESKTOP_HOME_DIR, configuredRoot);
  assert.equal(overrides.ZCODE_HOME, resolve(configuredRoot, ".zcode"));
  assert.equal(
    overrides.ZCODE_DESKTOP_USER_DATA_DIR,
    resolve(configuredRoot, "electron-user-data"),
  );
});

test("rejects a relative LinkAgent data-root override", () => {
  assert.throws(
    () =>
      createLinkAgentDesktopEnvOverrides({
        [LINK_AGENT_DEV_DATA_BASE_DIR_ENV]: "relative/linkagent-home",
      }),
    new RegExp(`${LINK_AGENT_DEV_DATA_BASE_DIR_ENV} must be an absolute path`),
  );
});
