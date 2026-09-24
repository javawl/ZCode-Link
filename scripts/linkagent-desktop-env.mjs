import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export const LINK_AGENT_DEV_DATA_BASE_DIR_ENV = "LINKAGENT_DEV_DATA_BASE_DIR";

export function resolveLinkAgentDevDataBaseDir(env = process.env, homeDir = homedir()) {
  const configured = env[LINK_AGENT_DEV_DATA_BASE_DIR_ENV]?.trim();
  if (!configured) {
    return join(homeDir, ".zcode-link-dev-home");
  }
  if (!isAbsolute(configured)) {
    throw new Error(`${LINK_AGENT_DEV_DATA_BASE_DIR_ENV} must be an absolute path`);
  }
  return configured;
}

export function createLinkAgentDesktopEnvOverrides(env = process.env, homeDir = homedir()) {
  const dataBaseDir = resolveLinkAgentDevDataBaseDir(env, homeDir);
  return {
    ZCODE_DATA_BASE_DIR: dataBaseDir,
    ZCODE_DESKTOP_HOME_DIR: dataBaseDir,
    ZCODE_HOME: join(dataBaseDir, ".zcode"),
    ZCODE_DESKTOP_USER_DATA_DIR: join(dataBaseDir, "electron-user-data"),
    ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT: "1",
  };
}
