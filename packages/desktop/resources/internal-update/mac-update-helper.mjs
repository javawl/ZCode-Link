import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runMacInstall, waitForParentExit } from "./mac-update-install.mjs";

// 此入口不被 Main bundle 导入，避免打包重定位 import.meta 后误执行安装程序。
const plan = JSON.parse(await readFile(process.argv[2], "utf8"));
const controller = new AbortController();
process.once("SIGTERM", () => controller.abort(new Error("Install cancelled by parent")));
try {
  const result = await runMacInstall(plan, {
    waitForParentExit: (transaction) => waitForParentExit(transaction, controller.signal),
    onReady: () =>
      writeFile(
        join(plan.jobPath, "helper-ready.json"),
        JSON.stringify({ token: plan.token, pid: process.pid }),
        { mode: 0o600, flag: "wx" },
      ),
  });
  if (result.status === "installed") await rm(plan.jobPath, { recursive: true, force: true });
} catch (error) {
  await writeFile(join(plan.jobPath, "helper-error.txt"), String(error.stack ?? error), {
    mode: 0o600,
  });
  process.exitCode = 1;
}
