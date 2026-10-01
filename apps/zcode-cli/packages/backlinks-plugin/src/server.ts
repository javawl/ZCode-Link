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
  const generated = z.toJSONSchema(schema, { unrepresentable: "any" }) as Record<string, unknown>;
  const branches = Array.isArray(generated.anyOf)
    ? generated.anyOf
    : Array.isArray(generated.oneOf)
      ? generated.oneOf
      : undefined;
  if (!branches) {
    return { type: "object", ...generated } as Tool["inputSchema"];
  }

  const commandBranches = branches.filter(isRecord);
  const actions = commandBranches.map((branch) => {
    const action = isRecord(branch.properties) ? branch.properties.action : undefined;
    return isRecord(action) && typeof action.const === "string" ? action.const : undefined;
  });
  // 原因：部分模型工具调用端会把顶层 anyOf/oneOf 且没有 properties 的 schema
  // 降级为空对象，导致 MCP 收到 {}。将已知 action union 投影为普通对象；handler 仍用
  // 原 Zod schema 校验分支和必填字段，避免兼容层代替服务端做授权或输入判定。
  if (
    commandBranches.length === 0 ||
    commandBranches.length !== branches.length ||
    actions.some((action) => action === undefined)
  ) {
    return { type: "object", ...generated } as Tool["inputSchema"];
  }

  const properties: Record<string, unknown> = {};
  for (const branch of commandBranches) {
    if (!isRecord(branch.properties)) continue;
    for (const [name, propertySchema] of Object.entries(branch.properties)) {
      if (name === "action" || !isRecord(propertySchema)) continue;
      properties[name] =
        name in properties
          ? mergePropertySchemas(properties[name] as Record<string, unknown>, propertySchema)
          : propertySchema;
    }
  }

  const actionRequirements = new Map<string, string[]>();
  for (let index = 0; index < commandBranches.length; index += 1) {
    const branch = commandBranches[index];
    const action = actions[index];
    if (!action || !branch) continue;
    const required = (Array.isArray(branch.required) ? branch.required : []).filter(
      (value: unknown): value is string => typeof value === "string" && value !== "action",
    );
    const current = actionRequirements.get(action) ?? [];
    const discriminator = isRecord(branch.properties)
      ? Object.entries(branch.properties).find(
          ([name, property]) =>
            name !== "action" &&
            required.includes(name) &&
            singleSchemaEnumValue(property) !== undefined,
        )
      : undefined;
    const condition = discriminator
      ? `${discriminator[0]}=${String(singleSchemaEnumValue(discriminator[1]))}`
      : undefined;
    const fields = required.filter((name) => name !== discriminator?.[0]);
    const requirement = condition
      ? `${condition} requires ${fields.length > 0 ? fields.join(", ") : "no additional fields"}`
      : fields.length > 0
        ? fields.join(", ")
        : "no additional fields";
    if (!current.includes(requirement)) current.push(requirement);
    actionRequirements.set(action, current);
  }

  const actionDescription = [...actionRequirements]
    .map(([action, requirements]) =>
      `${action}: ${requirements.length === 1 ? requirements[0] : `one of (${requirements.join("; ")})`}`,
    )
    .join("; ");
  const flattened: Record<string, unknown> = {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [...new Set(actions.filter((action): action is string => action !== undefined))],
        description: `Choose one operation. Required fields per action: ${actionDescription}.`,
      },
      ...properties,
    },
    required: ["action"],
    additionalProperties: false,
  };
  if (typeof generated.$schema === "string") flattened.$schema = generated.$schema;
  return flattened as Tool["inputSchema"];
}

function mergePropertySchemas(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): Record<string, unknown> {
  if (JSON.stringify(left) === JSON.stringify(right)) return left;

  const leftType = left.type;
  const rightType = right.type;
  if (leftType === rightType && typeof leftType === "string") {
    const leftEnum = schemaEnumValues(left);
    const rightEnum = schemaEnumValues(right);
    if (leftEnum && rightEnum) {
      return { type: leftType, enum: [...new Set([...leftEnum, ...rightEnum])] };
    }
    if (leftType === "array") {
      const leftItems = isRecord(left.items) ? left.items : undefined;
      const rightItems = isRecord(right.items) ? right.items : undefined;
      return {
        type: "array",
        ...(leftItems && rightItems
          ? { items: mergePropertySchemas(leftItems, rightItems) }
          : {}),
      };
    }
    if (leftType === "object") {
      const leftProperties = isRecord(left.properties) ? left.properties : {};
      const rightProperties = isRecord(right.properties) ? right.properties : {};
      const mergedProperties: Record<string, unknown> = {};
      for (const name of new Set([...Object.keys(leftProperties), ...Object.keys(rightProperties)])) {
        const leftProperty = leftProperties[name];
        const rightProperty = rightProperties[name];
        if (isRecord(leftProperty) && isRecord(rightProperty)) {
          mergedProperties[name] = mergePropertySchemas(leftProperty, rightProperty);
        } else {
          mergedProperties[name] = leftProperty ?? rightProperty;
        }
      }
      return { type: "object", properties: mergedProperties };
    }
    return { type: leftType };
  }
  if ([leftType, rightType].every((value) => value === "integer" || value === "number")) {
    return { type: "number" };
  }
  // A field may have different constraints or meanings in different actions. Keep the
  // common object shape and leave action-specific validation to the source Zod branch.
  return {};
}

function schemaEnumValues(schema: Record<string, unknown>): unknown[] | undefined {
  if (Array.isArray(schema.enum)) return schema.enum;
  if ("const" in schema) return [schema.const];
  return undefined;
}

function singleSchemaEnumValue(schema: unknown): unknown | undefined {
  if (!isRecord(schema)) return undefined;
  const values = schemaEnumValues(schema);
  return values?.length === 1 ? values[0] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
      "Dedicated persistent browser for the backlink-publish and google-session skills. Supports named pages, ARIA/text snapshots, role/label/placeholder/text/CSS/iframe selectors, coordinate click, form filling, file uploads inside the workspace and screenshots. Name the page on every page action; observe tabs before choosing OAuth popups. Same-page actions serialize; independent pages can run concurrently. Requires trusted ZCode session/trace context. The Chrome profile is isolated by workspace and retained across runs. By default (displayMode background) pages open as background tabs in a window parked off-screen and only bringToFront activates a window; browser launch and site popups can briefly take focus (handed back within about 1-2 s on macOS, not handed back on Windows/Linux). Finish all page verification before item_result: after a successful result the item's pages are recycled automatically and its page names stop working, while failed+manual_required keeps them held. During publishing use hold (never bringToFront) for pages that need a human; bringToFront reveals a page only after the user agreed at batch end or for a user-initiated Google sign-in. Do not call close at batch end. Never automatically retry a submission with an uncertain outcome. Effects: browser/network and workspace files; supports cancellation.",
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
