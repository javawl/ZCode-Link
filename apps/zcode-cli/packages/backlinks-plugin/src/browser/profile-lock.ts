import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { BacklinkBrowserError } from "./contract.js";

const PROFILE_LOCK_NAME = ".zcode-backlinks.lock";
const MAX_LOCK_BYTES = 4_096;
const OWNER_FORMAT = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu;

interface ProfileLock {
  version: 1;
  owner: string;
  pid: number;
  hostname: string;
  dev: number;
  ino: number;
}

function inUse(cause?: unknown): BacklinkBrowserError {
  return new BacklinkBrowserError(
    "BROWSER_PROFILE_IN_USE",
    "This workspace browser profile is in use or its owner cannot be safely verified. Close its owning runtime before retrying; never remove a live or unknown lock",
    { cause },
  );
}

function sameLock(left: ProfileLock, right: ProfileLock): boolean {
  return left.owner === right.owner && left.dev === right.dev && left.ino === right.ino;
}

function provenDead(lock: ProfileLock): boolean {
  if (lock.hostname !== hostname()) return false;
  try {
    process.kill(lock.pid, 0);
    return false;
  } catch (error) {
    // EPERM 仍可能是活进程；只有本机 ESRCH 能证明 PID 已不存在。
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function readLock(lockPath: string): Promise<ProfileLock | undefined> {
  const before = await lstat(lockPath);
  if (!before.isFile() || before.size > MAX_LOCK_BYTES) return undefined;
  const handle = await open(lockPath, "r");
  try {
    const current = await handle.stat();
    if (current.ino !== before.ino || current.dev !== before.dev) return undefined;
    let record: Partial<ProfileLock>;
    try {
      record = JSON.parse(await handle.readFile("utf8")) as Partial<ProfileLock>;
    } catch {
      return undefined;
    }
    if (
      !record ||
      record.version !== 1 ||
      typeof record.owner !== "string" ||
      !OWNER_FORMAT.test(record.owner) ||
      !Number.isSafeInteger(record.pid) ||
      record.pid! <= 0 ||
      typeof record.hostname !== "string" ||
      !record.hostname
    )
      return undefined;
    return {
      version: 1,
      owner: record.owner,
      pid: record.pid!,
      hostname: record.hostname,
      dev: current.dev,
      ino: current.ino,
    };
  } finally {
    await handle.close();
  }
}

async function createLock(lockPath: string): Promise<ProfileLock> {
  const record = {
    version: 1 as const,
    owner: randomUUID(),
    pid: process.pid,
    hostname: hostname(),
  };
  const handle = await open(lockPath, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(record));
    const stats = await handle.stat();
    return { ...record, dev: stats.dev, ino: stats.ino };
  } finally {
    await handle.close();
  }
}

async function releaseLock(lockPath: string, expected: ProfileLock): Promise<void> {
  try {
    const current = await readLock(lockPath);
    // 只有 token 与实际 inode 同时匹配才释放，不能删掉其他宿主的新锁。
    if (current && sameLock(expected, current)) await rm(lockPath);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new BacklinkBrowserError(
      "BROWSER_PROFILE_ERROR",
      "Unable to release the browser profile lock",
      { cause },
    );
  }
}

async function recoverLock(lockPath: string): Promise<ProfileLock> {
  let stale: ProfileLock | undefined;
  try {
    stale = await readLock(lockPath);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return await createLock(lockPath);
    throw cause;
  }
  if (!stale || !provenDead(stale)) throw inUse();
  const guardPath = `${lockPath}.recovery`;
  // 短暂互斥回收区：两个回收者不能在先后读到旧 inode 后误删对方刚创建的新锁。
  // 未知/遗留的 recovery guard 不自动删除，宁可报告需要人工确认。
  const guard = await createLock(guardPath);
  try {
    const current = await readLock(lockPath);
    if (!current || !sameLock(stale, current) || !provenDead(current)) throw inUse();
    await rm(lockPath);
    // 另一个正常 wx 创建若抢先成功，本次直接失败；绝不再次删除它的新锁。
    return await createLock(lockPath);
  } finally {
    await releaseLock(guardPath, guard);
  }
}

export async function acquireBrowserProfile(profilePath: string): Promise<() => Promise<void>> {
  const lockPath = join(profilePath, PROFILE_LOCK_NAME);
  try {
    await mkdir(profilePath, { recursive: true, mode: 0o700 });
    let acquired: ProfileLock;
    try {
      acquired = await createLock(lockPath);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      acquired = await recoverLock(lockPath);
    }
    return async () => releaseLock(lockPath, acquired);
  } catch (cause) {
    if (cause instanceof BacklinkBrowserError) throw cause;
    if (["EEXIST", "ENOENT"].includes((cause as NodeJS.ErrnoException).code ?? ""))
      throw inUse(cause);
    throw new BacklinkBrowserError(
      "BROWSER_PROFILE_ERROR",
      "Unable to acquire the workspace browser profile",
      { cause },
    );
  }
}
