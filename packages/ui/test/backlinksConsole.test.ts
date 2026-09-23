import assert from "node:assert/strict";
import test from "node:test";
import type { BacklinkBatchSummary } from "@zcode/services";
import {
  createBacklinksConsoleStore,
  filterBacklinkBatches,
} from "../src/store/backlinksConsoleStore.js";
import { createBacklinksPublisher } from "../src/lib/backlinksPublish.js";

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
  });
  assert.deepEqual(calls[1]?.value, {
    taskId: "new-task",
    traceId: "task-trace",
    remoteSessionId: "remote-session",
    clientMode: "web-remote-replayable",
    content: "/backlink-publish 389 99\n请按以上批次号顺序依次发布，仅处理这些批次。",
  });
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
