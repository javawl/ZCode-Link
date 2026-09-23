import type { IZCodeTaskService } from "@zcode/services";
import type { ModelSelection, ZCodeTaskClientMode } from "@zcode/shared";

export function buildBacklinksPublishPrompt(batchIds: readonly number[]): string {
  const ids = [...new Set(batchIds)].sort((a, b) => b - a);
  if (!ids.length || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error("Select valid backlink batches before publishing.");
  }
  return (
    `/backlink-publish ${ids.join(" ")}` +
    (ids.length > 1 ? "\n请按以上批次号顺序依次发布，仅处理这些批次。" : "")
  );
}

/** The existing task service remains the only owner of accepted Agent input. */
export function createBacklinksPublisher(options: {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  clientMode: ZCodeTaskClientMode;
  taskService: Pick<IZCodeTaskService, "createTask" | "sendPrompt">;
  modelSelection?: ModelSelection;
  prepare?(): Promise<void>;
  onAccepted(taskId: string): void;
}) {
  let pending = false;
  return async (batchIds: readonly number[]): Promise<void> => {
    if (pending) return;
    const content = buildBacklinksPublishPrompt(batchIds);
    if (!options.workspacePath.trim()) throw new Error("Select a workspace before publishing.");
    pending = true;
    try {
      await options.prepare?.();
      const task = await options.taskService.createTask({
        workspacePath: options.workspacePath,
        // 批次发布先建空会话再首发；必须交给 V4 admission 先落 session 主记录，
        // 否则 sendText 写 session_input 外键账本时会因父记录不存在而失败。
        deferPersistenceUntilFirstPrompt: true,
        ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
        ...(options.modelSelection ? { modelSelection: options.modelSelection } : {}),
      });
      await options.taskService.sendPrompt({
        taskId: task.taskId,
        traceId: task.traceId,
        content,
        clientMode: options.clientMode,
        ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
      });
      options.onAccepted(task.taskId);
    } finally {
      pending = false;
    }
  };
}
