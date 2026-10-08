import { spawn, execFile } from "node:child_process";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
  open,
} from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { randomBytes } from "node:crypto";
import {
  UPDATE_APP_ID,
  verifyArchiveFile,
  verifySignedUpdate,
} from "./internal-update-protocol.mjs";

const execute = promisify(execFile);
const executable = (appPath) => join(appPath, "Contents", "MacOS", "LinkAgent");

export function macAppPath(execPath) {
  if (!execPath.endsWith("/Contents/MacOS/LinkAgent"))
    throw new Error("请先将 LinkAgent 安装到可写目录后再更新");
  return dirname(dirname(dirname(execPath)));
}

export async function validateMacApp(path, version, arch) {
  if (!(await lstat(path)).isDirectory() || (await realpath(path)) !== resolve(path))
    throw new Error("Update app path is not a real directory");
  for (const [key, expected] of [
    ["CFBundleIdentifier", UPDATE_APP_ID],
    ["CFBundleShortVersionString", version],
    ["CFBundleExecutable", "LinkAgent"],
  ]) {
    const { stdout } = await execute("/usr/libexec/PlistBuddy", [
      "-c",
      `Print :${key}`,
      join(path, "Contents", "Info.plist"),
    ]);
    if (stdout.trim() !== expected) throw new Error(`Update app identity/version mismatch: ${key}`);
  }
  const binary = await open(executable(path), "r");
  const header = Buffer.alloc(8);
  try {
    await binary.read(header, 0, 8, 0);
  } finally {
    await binary.close();
  }
  if (
    header.readUInt32LE(0) !== 0xfeedfacf ||
    header.readUInt32LE(4) !== (arch === "arm64" ? 0x100000c : 0x1000007)
  )
    throw new Error("Update executable architecture mismatch");
  await access(executable(path), constants.X_OK);
}

export async function prepareMacInstall({
  appPath,
  archivePath,
  signedUpdate,
  version,
  arch,
  currentVersion,
  userDataPath,
  parentPid,
  launchEnvironment = {},
  helperSourceDir,
}) {
  const expected = verifySignedUpdate(signedUpdate, { version, arch });
  await verifyArchiveFile(archivePath, expected);
  await validateMacApp(appPath, currentVersion, arch);
  if (appPath.startsWith("/Volumes/") || (await realpath(dirname(appPath))) !== dirname(appPath))
    throw new Error("请将 LinkAgent 移到当前用户可写的应用目录后再更新");
  try {
    await access(dirname(appPath), constants.W_OK);
  } catch {
    throw new Error("安装目录不可写，请将 LinkAgent 移到当前用户可写目录后再更新");
  }
  const jobPath = await mkdtemp(join(dirname(appPath), ".linkagent-update-"));
  await chmod(jobPath, 0o700);
  try {
    const staging = join(jobPath, "staging");
    await mkdir(staging);
    await execute("/usr/bin/ditto", ["-x", "-k", archivePath, staging], { timeout: 120_000 });
    const stagedApp = join(staging, "LinkAgent.app");
    await validateMacApp(stagedApp, version, arch);
    const resultPath = join(userDataPath, "internal-mac-update", "last-result.json");
    await mkdir(dirname(resultPath), { recursive: true, mode: 0o700 });
    const plan = {
      schemaVersion: 1,
      appPath,
      archivePath,
      signedUpdate,
      version,
      arch,
      currentVersion,
      jobPath,
      stagedApp,
      parentPid,
      token: randomBytes(32).toString("hex"),
      startupTimeoutMs: 120_000,
      exitTimeoutMs: 60_000,
      launchEnvironment,
      resultPath,
    };
    for (const name of [
      "mac-update-helper.mjs",
      "mac-update-install.mjs",
      "internal-update-protocol.mjs",
    ])
      await copyFile(join(helperSourceDir, name), join(jobPath, name));
    await writeFile(join(jobPath, "plan.json"), JSON.stringify(plan), { mode: 0o600, flag: "wx" });
    return plan;
  } catch (error) {
    await rm(jobPath, { recursive: true, force: true });
    throw error;
  }
}

function validatePlan(plan) {
  if (
    plan.schemaVersion !== 1 ||
    !/^[a-f0-9]{64}$/.test(plan.token) ||
    !Number.isSafeInteger(plan.parentPid) ||
    plan.parentPid < 1 ||
    !["arm64", "x64"].includes(plan.arch)
  )
    throw new Error("Invalid install transaction");
  if (
    resolve(plan.appPath) !== plan.appPath ||
    !plan.appPath.endsWith(".app") ||
    dirname(plan.jobPath) !== dirname(plan.appPath) ||
    !basename(plan.jobPath).startsWith(".linkagent-update-") ||
    plan.stagedApp !== join(plan.jobPath, "staging", "LinkAgent.app")
  )
    throw new Error("Unsafe install transaction paths");
}

export async function waitForParentExit(plan, signal) {
  const end = Date.now() + plan.exitTimeoutMs;
  while (Date.now() < end) {
    try {
      process.kill(plan.parentPid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    await delay(200, undefined, { signal });
  }
  throw new Error("Parent did not exit before the update deadline");
}

export async function launchAndWait(appPath, updating, plan) {
  const args = updating
    ? [
        "--linkagent-update-plan",
        join(plan.jobPath, "plan.json"),
        "--linkagent-update-token",
        plan.token,
      ]
    : [];
  const child = spawn(executable(appPath), args, {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, ...plan.launchEnvironment, ELECTRON_RUN_AS_NODE: undefined },
  });
  await new Promise((resolvePromise, reject) => {
    child.once("spawn", resolvePromise);
    child.once("error", reject);
  });
  child.unref();
  if (!updating) return { pid: child.pid };
  const end = Date.now() + plan.startupTimeoutMs;
  try {
    while (Date.now() < end) {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error("Updated app exited before startup acknowledgement");
      try {
        const ack = JSON.parse(await readFile(join(plan.jobPath, "startup.json"), "utf8"));
        if (
          ack.token === plan.token &&
          ack.version === plan.version &&
          ack.appPath === plan.appPath &&
          ack.pid === child.pid
        )
          return { pid: child.pid };
        throw new Error("Invalid update startup acknowledgement");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await delay(200);
    }
    throw new Error("Updated main window did not acknowledge startup before deadline");
  } catch (error) {
    // 回滚前只回收本 helper 创建的新进程，不能按应用名杀掉其他窗口或用户进程。
    if (child.exitCode === null && child.signalCode === null) {
      process.kill(-child.pid, "SIGTERM");
      for (let i = 0; i < 50 && child.exitCode === null && child.signalCode === null; i++)
        await delay(100);
      if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, "SIGKILL");
    }
    throw error;
  }
}

export async function runMacInstall(plan, ports = {}) {
  validatePlan(plan);
  const expected = verifySignedUpdate(plan.signedUpdate, plan, ports.publicKey);
  await verifyArchiveFile(plan.archivePath, expected);
  await (ports.validateApp ?? validateMacApp)(plan.stagedApp, plan.version, plan.arch);
  const lock = `${plan.appPath}.linkagent-update-lock`;
  await mkdir(lock, { mode: 0o700 });
  const backup = join(plan.jobPath, "backup.app");
  let backedUp = false;
  let installed = false;
  let acknowledged = false;
  const journal = async (state) =>
    writeFile(
      join(plan.jobPath, "journal.json"),
      JSON.stringify({ state, token: plan.token, version: plan.version }),
      { mode: 0o600 },
    );
  try {
    await journal("prepared");
    await ports.onReady?.();
    await (ports.waitForParentExit ?? waitForParentExit)(plan);
    await verifyArchiveFile(plan.archivePath, expected);
    await (ports.validateCurrentApp ?? validateMacApp)(
      plan.appPath,
      plan.currentVersion,
      plan.arch,
    );
    await rename(plan.appPath, backup);
    backedUp = true;
    await journal("backed-up");
    await rename(plan.stagedApp, plan.appPath);
    installed = true;
    await journal("installed-awaiting-startup");
    let launched;
    try {
      launched = await (ports.launchAndWait ?? launchAndWait)(plan.appPath, true, plan);
    } catch (error) {
      await rename(plan.appPath, join(plan.jobPath, "failed.app"));
      installed = false;
      await rename(backup, plan.appPath);
      backedUp = false;
      await journal("rolled-back");
      const result = {
        status: "rolled-back",
        version: plan.version,
        reason: String(error.message ?? error),
      };
      await writeFile(plan.resultPath, JSON.stringify(result), { mode: 0o600 });
      const restored = await (ports.launchAndWait ?? launchAndWait)(plan.appPath, false, plan);
      if (restored?.pid) {
        result.pid = restored.pid;
        await writeFile(plan.resultPath, JSON.stringify(result), { mode: 0o600 });
      }
      return result;
    }
    acknowledged = true;
    await journal("acknowledged");
    const result = {
      status: "installed",
      version: plan.version,
      ...(launched?.pid ? { pid: launched.pid } : {}),
    };
    await writeFile(plan.resultPath, JSON.stringify(result), { mode: 0o600 });
    await rm(backup, { recursive: true, force: true });
    backedUp = false;
    return result;
  } catch (error) {
    // 替换后的日志/启动失败同样必须回滚；已收到真实启动确认后，清理失败保留备份供排查。
    if (backedUp && !acknowledged) {
      if (installed) await rename(plan.appPath, join(plan.jobPath, "failed.app"));
      await rename(backup, plan.appPath);
      await (ports.launchAndWait ?? launchAndWait)(plan.appPath, false, plan);
    }
    throw error;
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

export async function acknowledgeMacStartup({ argv, execPath, version }) {
  const i = argv.indexOf("--linkagent-update-plan");
  const j = argv.indexOf("--linkagent-update-token");
  if (i < 0 || j < 0) return;
  const planPath = argv[i + 1];
  const plan = JSON.parse(await readFile(planPath, "utf8"));
  validatePlan(plan);
  verifySignedUpdate(plan.signedUpdate, plan);
  if (
    planPath !== join(plan.jobPath, "plan.json") ||
    argv[j + 1] !== plan.token ||
    version !== plan.version ||
    macAppPath(execPath) !== plan.appPath
  )
    throw new Error("Invalid update startup identity");
  await writeFile(
    join(plan.jobPath, "startup.json"),
    JSON.stringify({ token: plan.token, version, appPath: plan.appPath, pid: process.pid }),
    { mode: 0o600, flag: "wx" },
  );
}
