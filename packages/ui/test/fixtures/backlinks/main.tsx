import { useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  BacklinkBatchDetail,
  BacklinkBatchSummary,
  BacklinksSettingsPatch,
  BacklinksSettingsSnapshot,
} from "@zcode/services";
import { ZCodeIntlProvider } from "../../../src/i18n/IntlProvider.js";
import { BacklinksConsole } from "../../../src/settings/backlinks/BacklinksConsole.js";
import { BacklinksSettingsForm } from "../../../src/settings/backlinks/BacklinksSettingsForm.js";
import { createBacklinksConsoleStore } from "../../../src/store/backlinksConsoleStore.js";
import { createBacklinksPublisher } from "../../../src/lib/backlinksPublish.js";
import "../../../src/styles.css";

const batch = (id: number): BacklinkBatchSummary => ({
  id,
  name: `Batch ${id}`,
  websiteId: id,
  websiteName: `Site ${id}`,
  websiteHost: `${id}.example`,
  plannedAt: "2026-09-21",
  executing: false,
  counts: { pending: 1, executed: 1, failed: 1, skipped: 1, total: 4 },
});

const state = {
  executingIds: [] as number[],
  failPublish: false,
  holdPublish: false,
  holding: false,
  requests: [] as string[],
  messages: [] as string[],
  opened: [] as string[],
  settingsPatches: [] as BacklinksSettingsPatch[],
  release: () => {},
};
Object.assign(window, { backlinksTest: state });

const publish = createBacklinksPublisher({
  workspacePath: "/test/workspace",
  clientMode: "web-remote-replayable",
  prepare: async () => {
    state.requests.push("enable");
  },
  taskService: {
    createTask: async () => {
      state.requests.push("create");
      return { taskId: "test-task", traceId: "test-trace" } as never;
    },
    sendPrompt: async ({ content }) => {
      state.requests.push("send");
      if (state.failPublish) throw new Error("Test admission failed");
      if (state.holdPublish)
        await new Promise<void>((resolve) => {
          state.holding = true;
          state.release = resolve;
        });
      state.messages.push(content);
    },
  },
  onAccepted: (taskId) => {
    state.opened.push(taskId);
  },
});
const store = createBacklinksConsoleStore(
  {
    listBatches: async () =>
      [batch(99), batch(389), batch(100)].map((batch) => ({
        ...batch,
        executing: state.executingIds.includes(batch.id),
      })),
    getBatch: async (id) =>
      ({
        batch: batch(id),
        website: {
          id,
          name: `Site ${id}`,
          siteUrl: `https://${id}.example`,
          siteHost: `${id}.example`,
        },
        anchors: [],
        items: ["executed", "failed", "skipped"].map((status, itemId) => ({
          id: itemId + 1,
          sourceId: itemId + 1,
          sourceName: status,
          sourceHost: `${status}.example`,
          sourceUrl: `https://${status}.example`,
          status,
          submitUrl: null,
          sourceNotes: null,
          category: "directory",
          tags: [],
          paymentType: "free",
          linkType: "dofollow",
          failureMode: null,
          failureReason: null,
          publishedUrl: null,
          publishStatus: null,
          plannedAt: "2026-09-21",
        })),
      }) as BacklinkBatchDetail,
  },
  publish,
);
void store.getState().refresh();

function App() {
  const [tab, setTab] = useState("console");
  const [snapshot, setSnapshot] = useState<BacklinksSettingsSnapshot>({
    supermanager: { baseUrl: "https://batch.example", tokenConfigured: true },
    cloudMail: { baseUrl: "https://mail.example/api", tokenConfigured: true },
    mailboxDomain: "mail.example",
    browser: { headless: false, channel: "chromium", executablePath: "" },
  });
  return (
    <ZCodeIntlProvider initialLocale="zh-CN">
      <main className="h-dvh overflow-auto bg-background p-4 text-foreground">
        <div className="mx-auto max-w-5xl space-y-4">
          <h1 className="text-ui-lg font-medium">外链发布</h1>
          <nav className="flex gap-4 text-ui-base">
            <button onClick={() => setTab("console")}>发布批次</button>
            <button onClick={() => setTab("settings")}>连接与浏览器</button>
          </nav>
          {tab === "console" ? (
            <BacklinksConsole store={store} canPublish />
          ) : (
            <BacklinksSettingsForm
              snapshot={snapshot}
              saving={false}
              onSave={async (patch) => {
                state.settingsPatches.push(patch);
                setSnapshot({
                  ...snapshot,
                  supermanager: {
                    baseUrl: patch.supermanager?.baseUrl ?? snapshot.supermanager.baseUrl,
                    tokenConfigured: !patch.supermanager?.clearToken,
                  },
                  cloudMail: {
                    baseUrl: patch.cloudMail?.baseUrl ?? snapshot.cloudMail.baseUrl,
                    tokenConfigured: !patch.cloudMail?.clearToken,
                  },
                  mailboxDomain: patch.mailboxDomain ?? snapshot.mailboxDomain,
                  browser: { ...snapshot.browser, ...patch.browser },
                });
              }}
            />
          )}
        </div>
      </main>
    </ZCodeIntlProvider>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
