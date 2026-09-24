import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Server, type Tool } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { backlinkWorkerCommandSchema, backlinksCommandSchema } from "@zcode/backlinks";
import { z } from "zod";
import { backlinkBrowserInputSchema } from "./browser/index.js";
import { createBacklinksToolHandlers, type BacklinksHandlerOptions } from "./handlers.js";

const SERVER_VERSION = "0.1.0";
const requestContextSchema = z.object({
  trace_id: z.string().trim().min(1).optional(),
  session_id: z.string().trim().min(1).optional(),
  workspace_identity: z.string().optional(),
  workspace_path: z.string().optional(),
});

function inputSchema(schema: z.ZodType): Tool["inputSchema"] {
  return {
    type: "object",
    ...z.toJSONSchema(schema, { unrepresentable: "any" }),
  } as Tool["inputSchema"];
}

export const BACKLINKS_MCP_TOOLS: Tool[] = [
  {
    name: "backlinks",
    description:
      "Execute backlink batches: batch_list, batch_get, batch_claim, lease_heartbeat, lease_release, item_result, badge_add, source_tags, mailbox_create, mail_wait. Load backlink-publish before publishing. Claim only authorized unpublished items; preserve leases; heartbeat every 30 seconds. Never resubmit an uncertain website submission. A live result requires a verified public clickable backlink. Use skipped.skipReason for existing links and failed.manual_required for uncertain submissions. Tokens are configured outside model input. Effects: network reads and writes; calls support cancellation and a 300-second maximum. Large results return a complete local artifact path.",
    inputSchema: inputSchema(backlinksCommandSchema),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "backlinks_worker",
    description:
      "Restricted backlink item worker for the backlinks:backlink-publisher subagent. It can heartbeat an existing lease, report one assigned item result, create or poll verification mailboxes, add an approved reciprocal badge, and append source tags. It cannot list, inspect, claim, or release batches. Use only the lease and item IDs supplied by the parent publishing task. Never retry an uncertain website submission.",
    inputSchema: inputSchema(backlinkWorkerCommandSchema),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "backlinks_browser",
    description:
      "Dedicated persistent browser for the backlink-publish and google-session skills. Supports named pages, ARIA/text snapshots, role/label/placeholder/text/CSS/iframe selectors, coordinate click, form filling, file uploads inside the workspace, screenshots and manual login handoff. Name the page on every page action; observe tabs before choosing OAuth popups. Same-page actions serialize; independent pages can run concurrently. Requires trusted ZCode session/trace context. The Chrome profile is isolated by workspace and retained across runs. Never automatically retry a submission with an uncertain outcome. Effects: browser/network and workspace files; supports cancellation.",
    inputSchema: inputSchema(backlinkBrowserInputSchema),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "backlinks_status",
    description:
      "Read the current backlink provider URLs, token configured flags, mailbox domain and browser settings. Never returns tokens. Use before selecting a batch or creating a verification mailbox; configure missing settings in ZCode Settings > Backlinks or the stdin configuration script.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "backlinks_cleanup",
    description:
      "Release every backlink lease owned by the current ZCode session after its publishing tasks have stopped. The target session is host-injected and cannot be supplied in arguments.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
];

export function createBacklinksMcpRuntime(options: BacklinksHandlerOptions = {}) {
  const handlers = createBacklinksToolHandlers(options);
  const server = new Server(
    { name: "backlinks", version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "Use backlink-publish for authorized batch publication and google-session for human-assisted Google login. Backlink tools and browser pages are shared only within the same workspace.",
    },
  );
  server.setRequestHandler("tools/list", async () => ({ tools: BACKLINKS_MCP_TOOLS }));
  server.setRequestHandler("tools/call", async (request, extra) => {
    const parsedContext = requestContextSchema.safeParse(
      extra.mcpReq._meta?.["com.zcode/request-context"],
    );
    const result = await handlers.call(request.params.name, request.params.arguments ?? {}, {
      signal: extra.mcpReq.signal,
      requestContext: parsedContext.success ? parsedContext.data : undefined,
    });
    return { ...result };
  });
  return { server, close: () => handlers.close() };
}

export async function main(): Promise<void> {
  process.title = "zcode-backlinks-mcp";
  // 官方宿主会在 main 返回后收紧环境；在入口中捕获配置，后续请求不重新读取宿主环境。
  const env = { ...process.env };
  const runtimes = new Set<ReturnType<typeof createBacklinksMcpRuntime>>();
  const handle = serveStdio(
    () => {
      const runtime = createBacklinksMcpRuntime({ env });
      runtimes.add(runtime);
      return runtime.server;
    },
    { legacy: "reject" },
  );
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    void Promise.allSettled([...runtimes].map((runtime) => runtime.close()))
      .then(() => handle.close())
      .finally(() => {
        process.exitCode = 0;
      });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.stdin.once("end", shutdown);
  process.stdin.once("close", shutdown);
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE" || error.code === "ERR_STREAM_DESTROYED") shutdown();
    else throw error;
  });
}

async function isDirectEntrypoint(): Promise<boolean> {
  if (!process.argv[1]) return false;
  const paths = await Promise.allSettled([
    realpath(fileURLToPath(import.meta.url)),
    realpath(process.argv[1]),
  ]);
  return (
    paths[0]?.status === "fulfilled" &&
    paths[1]?.status === "fulfilled" &&
    paths[0].value === paths[1].value
  );
}

if (await isDirectEntrypoint()) await main();
