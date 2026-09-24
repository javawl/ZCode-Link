import assert from "node:assert/strict";
import test from "node:test";
import type { BacklinkBatchSummary } from "@zcode/services";
import {
  createBacklinksConsoleStore,
  filterBacklinkBatches,
} from "../src/store/backlinksConsoleStore.js";
import {
  createBacklinksPublisher,
  createBacklinksPublishRunRegistry,
  createBacklinksStopper,
} from "../src/lib/backlinksPublish.js";
import { resolveConfiguredDefaultModelSelection } from "../src/lib/modelDefaultSelection.js";

const batch = (id: number, websiteHost = `${id}.example`): BacklinkBatchSummary => ({
  id,
  name: `Batch ${id}`,
  websiteId: id,
  websiteName: `Site ${id}`,
  websiteHost,
  plannedAt: "2026-09-21",
  executing: false,
  counts: { pending: 1, executed: 1, skipped: 0, failed: 0, total: 2 },
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("executing batches stay above newer idle batches and return to numeric order when finished", async () => {
  let batches = [
    batch(389),
    { ...batch(99), executing: true },
    batch(100),
    { ...batch(1), executing: true },
  ];
  const store = createBacklinksConsoleStore(
    {
      listBatches: async () => batches,
      getBatch: async () => {
        throw new Error("not requested");
      },
    },
    async () => {},
  );
  await store.getState().refresh();
  assert.deepEqual(
    store.getState().batches.map((b) => b.id),
    [99, 1, 389, 100],
  );
  assert.deepEqual(
    batches.map((b) => b.id),
    [389, 99, 100, 1],
    "sorting must not mutate the backend array",
  );
  store.getState().select([99], true);
  assert.deepEqual(
    filterBacklinkBatches(store.getState().batches, "9").map((b) => b.id),
    [99, 389],
  );
  batches = batches.map((b) => ({ ...b, executing: b.id === 100 }));
  await store.getState().refresh();
  assert.deepEqual(
    store.getState().batches.map((b) => b.id),
    [100, 389, 99, 1],
  );
  assert.deepEqual(store.getState().selectedIds, [99]);
});

test("console numeric sorting, filtered selection and refresh preserve hidden selections", async () => {
  let batches = [batch(99), batch(389, "tools.example"), batch(100)];
  const store = createBacklinksConsoleStore(
    {
      listBatches: async () => batches,
      getBatch: async () => {
        throw new Error("detail not requested");
      },
    },
    async () => {},
  );
  await store.getState().refresh();
  assert.deepEqual(
    store.getState().batches.map((entry) => entry.id),
    [389, 100, 99],
  );
  store.getState().select([99], true);
  const filtered = filterBacklinkBatches(store.getState().batches, "tools");
  store.getState().select(
    filtered.map((entry) => entry.id),
    true,
  );
  assert.deepEqual(store.getState().selectedIds, [389, 99]);
  store.getState().select(
    filtered.map((entry) => entry.id),
    false,
  );
  assert.deepEqual(store.getState().selectedIds, [99]);
  assert.equal(filterBacklinkBatches(batches, "SITE 100")[0]?.id, 100);
  batches = [batch(100)];
  await store.getState().refresh();
  assert.deepEqual(store.getState().selectedIds, []);
});

test("publish submits once, in numeric descending order, then clears accepted selection", async () => {
  const sent: number[][] = [];
  const delivery = deferred<void>();
  const store = createBacklinksConsoleStore(
    {
      listBatches: async () => [batch(99), batch(389)],
      getBatch: async () => {
        throw new Error("not requested");
      },
    },
    async (ids) => {
      sent.push([...ids]);
      await delivery.promise;
    },
  );
  await store.getState().refresh();
  store.getState().select([99, 389, 99], true);
  const first = store.getState().publishSelected();
  await store.getState().publishSelected();
  store.getState().select([99], false);
  assert.deepEqual(sent, [[389, 99]]);
  assert.deepEqual(store.getState().selectedIds, [389, 99]);
  delivery.resolve();
  await first;
  assert.deepEqual(store.getState().selectedIds, []);
  assert.equal(store.getState().publishing, false);
});

test("failed publishing and failed refresh retain selection and expose an error", async () => {
  let failRead = false;
  const store = createBacklinksConsoleStore(
    {
      listBatches: async () => {
        if (failRead) throw new Error("offline");
        return [batch(389)];
      },
      getBatch: async () => {
        throw new Error("not requested");
      },
    },
    async () => {
      throw new Error("input rejected");
    },
  );
  await store.getState().refresh();
  store.getState().select([389], true);
  await store.getState().publishSelected();
  assert.deepEqual(store.getState().selectedIds, [389]);
  assert.equal(store.getState().error, "input rejected");
  failRead = true;
  await store.getState().refresh();
  assert.deepEqual(store.getState().selectedIds, [389]);
  assert.equal(store.getState().batches[0]?.id, 389);
  assert.equal(store.getState().error, "offline");
});

test("executing batch stop is single-flight and reports cleanup failures without changing backend truth", async () => {
  const stopping = deferred<readonly number[]>();
  let stopCalls = 0;
  const store = createBacklinksConsoleStore(
    {
      listBatches: async () => [{ ...batch(389), executing: true }],
      getBatch: async () => {
        throw new Error("not requested");
      },
    },
    async () => {},
    async () => {
      stopCalls += 1;
      return stopping.promise;
    },
  );
  await store.getState().refresh();
  const first = store.getState().stop(389);
  await store.getState().stop(389);
  assert.equal(stopCalls, 1);
  assert.deepEqual(store.getState().stoppingIds, [389]);
  stopping.reject(new Error("lease cleanup failed"));
  await first;
  assert.deepEqual(store.getState().stoppingIds, []);
  assert.equal(store.getState().batches[0]?.executing, true);
  assert.equal(store.getState().error, "lease cleanup failed");
});

test("late detail result cannot reopen a panel that the user already collapsed", async () => {
  const read = deferred<never>();
  let calls = 0;
  const store = createBacklinksConsoleStore(
    {
      listBatches: async () => [batch(389)],
      getBatch: async () => {
        calls += 1;
        return read.promise;
      },
    },
    async () => {},
  );
  await store.getState().refresh();
  const opening = store.getState().toggleDetail(389);
  await store.getState().toggleDetail(389);
  read.resolve({ batch: batch(389), website: {}, anchors: [], items: [] } as never);
  await opening;
  assert.equal(calls, 1);
  assert.equal(store.getState().expandedIds.includes(389), false);
});

test("publisher creates a new task, uses its trace and routes input to the same remote workspace", async () => {
  const calls: Array<{ method: string; value: unknown }> = [];
  const publisher = createBacklinksPublisher({
    workspacePath: "/remote/project",
    workspaceIdentity: "remote:test",
    remoteSessionId: "remote-session",
    clientMode: "web-remote-replayable",
    modelSelection: {
      providerId: "newapi",
      modelId: "deepseek-v4.1-flash",
      options: { reasoningLevel: "high" },
    },
    taskService: {
      createTask: async (params) => {
        calls.push({ method: "create", value: params });
        return { taskId: "new-task", traceId: "task-trace" } as never;
      },
      sendPrompt: async (params) => {
        calls.push({ method: "send", value: params });
      },
    },
    onAccepted: (id) => {
      calls.push({ method: "open", value: id });
    },
  });
  await publisher([99, 389, 99]);
  assert.deepEqual(
    calls.map((entry) => entry.method),
    ["create", "send", "open"],
  );
  assert.deepEqual(calls[0]?.value, {
    workspacePath: "/remote/project",
    workspaceIdentity: "remote:test",
    deferPersistenceUntilFirstPrompt: true,
    modelSelection: {
      providerId: "newapi",
      modelId: "deepseek-v4.1-flash",
      options: { reasoningLevel: "high" },
    },
  });
  assert.deepEqual(calls[1]?.value, {
    taskId: "new-task",
    traceId: "task-trace",
    remoteSessionId: "remote-session",
    clientMode: "web-remote-replayable",
    content:
      "/backlink-publish 389 99\n请按以上批次号顺序依次发布，仅处理这些批次。\n读取批次详情后，必须先调用一次 AskUserQuestion，同时询问“执行范围”和“执行模式”；两项回答齐全且有效前，不得认领条目或开始发布。",
  });
});

test("publish run registry survives remount and batch stop cancels the whole session scope", async () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
  createBacklinksPublishRunRegistry("remote:test", storage).bind("task-1", [389, 99]);
  const remounted = createBacklinksPublishRunRegistry("remote:test", storage);
  const calls: unknown[] = [];
  const stop = createBacklinksStopper({
    workspacePath: "/remote/project",
    workspaceIdentity: "remote:test",
    registry: remounted,
    taskService: {
      stopGeneration: async (input) => {
        calls.push(input);
      },
    },
  });

  assert.deepEqual(await stop(99), [389, 99]);
  assert.deepEqual(calls, [
    {
      taskId: "task-1",
      workspacePath: "/remote/project",
      workspaceIdentity: "remote:test",
      scope: "session",
      cleanupMcpServers: ["plugin:backlinks:backlinks"],
    },
  ]);
  await assert.rejects(stop(389), /对应的发布会话/u);
});

test("default model selection completes the chosen model with its highest reasoning level", () => {
  const view = {
    revision: 1,
    preferredSelection: {
      providerId: "newapi",
      modelId: "gemini-3.8-flash-high",
      options: { reasoningLevel: "high" },
    },
    providers: [
      {
        providerId: "newapi",
        providerName: "newapi",
        config: {},
        models: [
          {
            modelId: "gemini-3.8-flash-high",
            config: { optionSpecs: { reasoningLevel: { values: ["low", "high"] } } },
          },
          {
            modelId: "deepseek-v4.1-flash",
            config: { optionSpecs: { reasoningLevel: { values: ["off", "medium"] } } },
          },
        ],
      },
    ],
  } as never;
  assert.deepEqual(resolveConfiguredDefaultModelSelection(view, "newapi", "deepseek-v4.1-flash"), {
    providerId: "newapi",
    modelId: "deepseek-v4.1-flash",
    options: { reasoningLevel: "medium" },
  });
  assert.equal(resolveConfiguredDefaultModelSelection(view, "newapi", "missing"), null);
});

test("single-batch publishing also requires the two scope questions before claiming", async () => {
  const calls: string[] = [];
  const publisher = createBacklinksPublisher({
    workspacePath: "/project",
    clientMode: "desktop-continuous",
    taskService: {
      createTask: async () => ({ taskId: "new-task", traceId: "task-trace" }) as never,
      sendPrompt: async ({ content }) => {
        calls.push(content);
      },
    },
    onAccepted: () => {},
  });

  await publisher([615]);

  assert.equal(calls.length, 1);
  assert.match(calls[0]!, /^\/backlink-publish 615$/m);
  assert.match(calls[0]!, /同时询问“执行范围”和“执行模式”/u);
  assert.match(calls[0]!, /两项回答齐全且有效前，不得认领条目或开始发布/u);
});

test("publisher does not navigate or silently resend after admission fails", async () => {
  let sends = 0;
  let opened = false;
  const publish = createBacklinksPublisher({
    workspacePath: "/project",
    clientMode: "desktop-continuous",
    taskService: {
      createTask: async () => ({ taskId: "new-task", traceId: "task-trace" }) as never,
      sendPrompt: async () => {
        sends += 1;
        throw new Error("admission failed");
      },
    },
    onAccepted: () => {
      opened = true;
    },
  });
  await assert.rejects(publish([9]), /admission failed/);
  assert.equal(sends, 1);
  assert.equal(opened, false);
});

test("plugin readiness completes before task creation and a failed enable starts no task", async () => {
  const order: string[] = [];
  let fail = true;
  const publish = createBacklinksPublisher({
    workspacePath: "/project",
    clientMode: "desktop-continuous",
    prepare: async () => {
      order.push("enable");
      if (fail) throw new Error("plugin missing");
    },
    taskService: {
      createTask: async () => {
        order.push("create");
        return { taskId: "new-task", traceId: "trace" } as never;
      },
      sendPrompt: async () => {
        order.push("send");
      },
    },
    onAccepted: () => {
      order.push("open");
    },
  });
  await assert.rejects(publish([9]), /plugin missing/);
  assert.deepEqual(order, ["enable"]);
  fail = false;
  await publish([9]);
  assert.deepEqual(order, ["enable", "enable", "create", "send", "open"]);
});
