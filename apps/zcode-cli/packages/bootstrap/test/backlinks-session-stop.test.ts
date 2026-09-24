import assert from "node:assert/strict";
import test from "node:test";
import { completeSessionScopedStop } from "../src/zcode-protocol-v4/commands/handlers/session-stop-cleanup.js";

test("session-scoped stop cancels background work before releasing MCP resources", async () => {
  const order: string[] = [];
  const app = {
    sessionId: "session-1",
    runtime: {
      getProjection: async () => ({
        backgroundTasks: [
          { taskId: "agent-1", status: "running" },
          { taskId: "agent-done", status: "completed" },
        ],
      }),
    },
    readTarget: async () => null,
    setQueueAutoDrain: async () => {
      order.push("queue-held");
    },
    cancelBackgroundTask: async (taskId: string) => {
      order.push(`background-stop:${taskId}`);
      return { cancelled: true, taskId, status: "cancelled" };
    },
    releaseMcpSessionResources: async (serverName: string) => {
      order.push(`cleanup:${serverName}`);
    },
  };
  const record = {
    app,
    persistence: "immediate",
    traceContext: {},
    workspace: { workspacePath: "/project" },
  };

  await completeSessionScopedStop(
    record as never,
    {
      scope: "session",
      cleanupMcpServers: ["plugin:backlinks:backlinks"],
    },
  );

  assert.deepEqual(order, [
    "queue-held",
    "background-stop:agent-1",
    "cleanup:plugin:backlinks:backlinks",
  ]);
});
