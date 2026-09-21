import type { McpOAuthConfig, McpServerConfig } from "@zcode/contracts";
import { isRecord } from "./helpers.js";

type ResolveOAuthValue = (value: string, allowSensitive: boolean) => string;

export function resolveMcpCommonOptions(
  server: Record<string, unknown>,
): Pick<McpServerConfig, "enabled" | "isolation" | "timeoutMs"> {
  const isolation = server.isolation;
  // 原 resolver 丢弃 isolation，workspace 插件因而被当作 session 级重复启动，
  // 多个进程争抢同一个持久浏览器 profile。保留显式范围，非法值不静默降级。
  if (isolation !== undefined && isolation !== "session" && isolation !== "workspace") {
    throw new Error('MCP server isolation must be "session" or "workspace"');
  }
  return {
    enabled: typeof server.enabled === "boolean" ? server.enabled : undefined,
    ...(isolation !== undefined ? { isolation } : {}),
    timeoutMs: typeof server.timeoutMs === "number" ? server.timeoutMs : undefined,
  };
}

export function resolveMcpOAuthConfig(
  value: unknown,
  resolveValue: ResolveOAuthValue,
): McpOAuthConfig | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type === "client_credentials") {
    return {
      type: "client_credentials",
      clientId: resolveValue(
        requireString(value.clientId, "MCP OAuth client_credentials requires clientId"),
        false,
      ),
      clientSecret: resolveValue(
        requireString(value.clientSecret, "MCP OAuth client_credentials requires clientSecret"),
        true,
      ),
      ...(typeof value.clientName === "string"
        ? { clientName: resolveValue(value.clientName, false) }
        : {}),
      ...(typeof value.scope === "string" ? { scope: resolveValue(value.scope, false) } : {}),
    };
  }
  if (value.type === "authorization_code") {
    return {
      type: "authorization_code",
      ...(typeof value.clientId === "string"
        ? { clientId: resolveValue(value.clientId, false) }
        : {}),
      ...(typeof value.clientSecret === "string"
        ? { clientSecret: resolveValue(value.clientSecret, true) }
        : {}),
      ...(typeof value.clientName === "string"
        ? { clientName: resolveValue(value.clientName, false) }
        : {}),
      ...(typeof value.redirectPath === "string"
        ? { redirectPath: resolveValue(value.redirectPath, false) }
        : {}),
      ...(typeof value.scope === "string" ? { scope: resolveValue(value.scope, false) } : {}),
    };
  }
  throw new Error(`Unsupported MCP OAuth type: ${String(value.type)}`);
}

function requireString(value: unknown, message: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error(message);
}
