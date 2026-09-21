import { mkdir, open, readFile, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { BacklinksError } from "../domain/errors.js";

interface Owner {
  pid: number;
  hostname: string;
  token: string;
}
function code(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}
async function readOwner(path: string): Promise<Owner | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (code(error) === "ENOENT") return undefined;
    throw error;
  }
  try {
    const value: unknown = JSON.parse(text);
    if (
      value &&
      typeof value === "object" &&
      "pid" in value &&
      Number.isSafeInteger(value.pid) &&
      Number(value.pid) > 0 &&
      "hostname" in value &&
      typeof value.hostname === "string" &&
      "token" in value &&
      typeof value.token === "string"
    )
      return value as Owner;
  } catch {
    /* 未写完或未知格式的锁没有可验证所有者，不能回收。 */
  }
  return undefined;
}
function dead(owner: Owner): boolean {
  if (owner.hostname !== hostname()) return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return code(error) === "ESRCH";
  }
}
async function createOwner(path: string): Promise<Owner> {
  const owner = { pid: process.pid, hostname: hostname(), token: randomUUID() };
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(owner));
  } catch (error) {
    await rm(path, { force: true });
    throw error;
  } finally {
    await handle.close();
  }
  return owner;
}
async function recover(path: string): Promise<Owner | undefined> {
  const stale = await readOwner(path);
  if (!stale || !dead(stale)) return undefined;
  const guard = `${path}.recovery`;
  try {
    await mkdir(guard, { mode: 0o700 });
  } catch (error) {
    if (code(error) === "EEXIST") return undefined;
    throw error;
  }
  try {
    const current = await readOwner(path);
    if (!current || current.token !== stale.token || !dead(current)) return undefined;
    // 恢复守卫防止两个进程同时移除死锁后，误删对方刚刚获得的新锁。
    await rm(path);
    try {
      return await createOwner(path);
    } catch (error) {
      if (code(error) === "EEXIST") return undefined;
      throw error;
    }
  } finally {
    await rm(guard, { recursive: true, force: true });
  }
}

/** Cross-process exclusive writer lock; unknown or foreign-host owners are never stolen. */
export async function acquireConfigLock(path: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + 5000;
  while (true) {
    let owner: Owner | undefined;
    try {
      owner = await createOwner(path);
    } catch (error) {
      if (code(error) !== "EEXIST") throw error;
      owner = await recover(path);
    }
    if (owner) {
      const token = owner.token;
      return async () => {
        if ((await readOwner(path))?.token === token) await rm(path, { force: true });
      };
    }
    if (Date.now() >= deadline)
      throw new BacklinksError(
        "另一个 ZCode 进程正在更新外链设置，或锁所有者无法核验，请稍后重试。",
        "BACKLINKS_CONFLICT",
        1,
      );
    await delay(20);
  }
}
