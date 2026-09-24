import type { IZCodeTaskService } from "@zcode/services";
import type { ModelSelection, ZCodeTaskClientMode } from "@zcode/shared";

export const BACKLINKS_MCP_SERVER_NAME = "plugin:backlinks:backlinks";
const BACKLINKS_RUNS_KEY_PREFIX = "linkagent-backlinks-runs-v1";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface BacklinksPublishRunBinding {
  readonly taskId: string;
  readonly batchIds: readonly number[];
  readonly createdAt: number;
}

export interface BacklinksPublishRunRegistry {
  bind(taskId: string, batchIds: readonly number[]): void;
  resolve(batchId: number): BacklinksPublishRunBinding | null;
  removeTask(taskId: string): void;
}

export function buildBacklinksPublishPrompt(batchIds: readonly number[]): string {
  const ids = [...new Set(batchIds)].sort((a, b) => b - a);
  if (!ids.length || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error("Select valid backlink batches before publishing.");
  }
  // 迁移时技能曾把范围与模式弱化成默认值，导致侧栏发布绕过参考 harness 的双问答。
  // 首条输入也声明门槛，确保单批和批量入口在任何认领动作前都等待用户选择。
  return (
    `/backlink-publish ${ids.join(" ")}` +
    (ids.length > 1 ? "\n请按以上批次号顺序依次发布，仅处理这些批次。" : "") +
    "\n读取批次详情后，必须先调用一次 AskUserQuestion，同时询问“执行范围”和“执行模式”；两项回答齐全且有效前，不得认领条目或开始发布。"
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
  onAccepted(taskId: string, batchIds: readonly number[]): void;
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
      options.onAccepted(
        task.taskId,
        [...new Set(batchIds)].sort((a, b) => b - a),
      );
    } finally {
      pending = false;
    }
  };
}

export function createBacklinksPublishRunRegistry(
  scope: string,
  storage: StorageLike | null = browserStorage(),
): BacklinksPublishRunRegistry {
  const key = `${BACKLINKS_RUNS_KEY_PREFIX}:${scope.trim()}`;
  const read = (): BacklinksPublishRunBinding[] => {
    if (!storage) return [];
    try {
      const value: unknown = JSON.parse(storage.getItem(key) ?? "[]");
      if (!Array.isArray(value)) return [];
      return value.flatMap((candidate) => {
        if (!candidate || typeof candidate !== "object") return [];
        const record = candidate as Record<string, unknown>;
        const batchIds = Array.isArray(record.batchIds)
          ? record.batchIds.filter((id): id is number => Number.isSafeInteger(id) && Number(id) > 0)
          : [];
        return typeof record.taskId === "string" && record.taskId.trim() && batchIds.length
          ? [
              {
                taskId: record.taskId,
                batchIds: [...new Set(batchIds)].sort((a, b) => b - a),
                createdAt:
                  typeof record.createdAt === "number" && Number.isFinite(record.createdAt)
                    ? record.createdAt
                    : 0,
              },
            ]
          : [];
      });
    } catch {
      return [];
    }
  };
  const write = (runs: readonly BacklinksPublishRunBinding[]): void => {
    if (!storage) return;
    if (!runs.length) {
      storage.removeItem(key);
      return;
    }
    storage.setItem(key, JSON.stringify(runs.slice(-100)));
  };
  return {
    bind(taskId, batchIds) {
      const normalizedIds = [...new Set(batchIds)].filter(
        (id) => Number.isSafeInteger(id) && id > 0,
      );
      if (!taskId.trim() || !normalizedIds.length) return;
      const occupied = new Set(normalizedIds);
      const next = read().filter(
        (run) => run.taskId !== taskId && !run.batchIds.some((id) => occupied.has(id)),
      );
      write([
        ...next,
        { taskId, batchIds: normalizedIds.sort((a, b) => b - a), createdAt: Date.now() },
      ]);
    },
    resolve(batchId) {
      return read().find((run) => run.batchIds.includes(batchId)) ?? null;
    },
    removeTask(taskId) {
      write(read().filter((run) => run.taskId !== taskId));
    },
  };
}

export function createBacklinksStopper(options: {
  workspacePath: string;
  workspaceIdentity?: string;
  registry: BacklinksPublishRunRegistry;
  taskService: Pick<IZCodeTaskService, "stopGeneration">;
}) {
  return async (batchId: number): Promise<readonly number[]> => {
    const binding = options.registry.resolve(batchId);
    if (!binding) {
      throw new Error("找不到该批次对应的发布会话，无法安全停止；请等待当前租约到期。");
    }
    await options.taskService.stopGeneration({
      taskId: binding.taskId,
      workspacePath: options.workspacePath,
      ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
      scope: "session",
      cleanupMcpServers: [BACKLINKS_MCP_SERVER_NAME],
    });
    options.registry.removeTask(binding.taskId);
    return binding.batchIds;
  };
}

function browserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
