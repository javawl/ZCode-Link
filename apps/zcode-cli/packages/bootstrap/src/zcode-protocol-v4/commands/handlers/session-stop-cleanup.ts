import type { CommandPayloadMap } from "@zcode/shared/zcode-protocol-v4";
import type { V4SessionRecordView } from "../types.js";

export async function completeSessionScopedStop(
  record: V4SessionRecordView,
  payload: CommandPayloadMap["stop"],
): Promise<void> {
  if (payload.scope !== "session") return;

  // 批次 Stop 不能只打断父回合：已经后台化的 Agent / Bash / DWF 与父 signal 脱钩。
  // 先关 queue gate，再逐项等待取消完成，最后才允许资源 owner 释放租约。
  await record.app.setQueueAutoDrain(false);
  const projection = await record.app.runtime.getProjection();
  const running = projection.backgroundTasks.filter((task) => task.status === "running");
  const outcomes = await Promise.allSettled(
    running.map((task) => record.app.cancelBackgroundTask?.(task.taskId)),
  );
  const failed = outcomes.find(
    (outcome) =>
      outcome.status === "rejected" ||
      (outcome.status === "fulfilled" && outcome.value?.cancelled !== true),
  );
  if (failed) {
    throw new Error("Session background work could not be stopped completely");
  }
  for (const serverName of payload.cleanupMcpServers ?? []) {
    if (!record.app.releaseMcpSessionResources) {
      throw new Error("Session MCP cleanup is not supported");
    }
    await record.app.releaseMcpSessionResources(serverName);
  }
}
