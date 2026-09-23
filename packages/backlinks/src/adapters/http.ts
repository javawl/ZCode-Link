import { BacklinksError } from "../domain/errors.js";
import type { BacklinksErrorCode } from "../domain/errors.js";

export interface HttpProviderConfig {
  readonly baseUrl: string;
  readonly token: string;
  readonly requestTimeoutMs: number;
}
export function httpErrorCode(status: number): BacklinksErrorCode {
  if (status === 400 || status === 422) return "BACKLINKS_INVALID_REQUEST";
  if (status === 401 || status === 403) return "BACKLINKS_UNAUTHORIZED";
  if (status === 404) return "BACKLINKS_NOT_FOUND";
  if (status === 409 || status === 429) return "BACKLINKS_CONFLICT";
  return "BACKLINKS_API_ERROR";
}
function retryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const time = Date.parse(value);
  return Number.isFinite(time) ? Math.max(0, Math.ceil((time - Date.now()) / 1000)) : null;
}

/** One bounded request including the response body. Mutations are never retried here. */
export async function requestJson(
  config: HttpProviderConfig,
  fetcher: typeof fetch,
  provider: "supermanager" | "cloud-mail",
  path: string,
  method: "GET" | "POST",
  payload?: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  if (signal?.aborted) throw new BacklinksError("外链请求已取消。", "BACKLINKS_ABORTED");
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), config.requestTimeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  try {
    const response = await fetcher(`${config.baseUrl.replace(/\/+$/, "")}${path}`, {
      method,
      headers: {
        authorization: provider === "supermanager" ? `Bearer ${config.token}` : config.token,
        ...(payload === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      signal: combined,
      redirect: "error",
    });
    if (!response.ok) {
      // 401/403 表示服务拒绝当前凭据，不能误报为列表不存在，也不能回显响应正文中的秘密。
      const authenticationHint =
        response.status === 401 || response.status === 403
          ? provider === "supermanager"
            ? " Agent Token 被拒绝，请在「连接与浏览器」中更新 Supermanager Agent Token（不是模型 API Key）。"
            : " 访问令牌被拒绝，请在「连接与浏览器」中更新 Cloud Mail 令牌。"
          : "";
      throw new BacklinksError(
        `${provider} ${path} 返回 HTTP ${response.status}。${authenticationHint}`,
        httpErrorCode(response.status),
        retryAfter(response.headers.get("retry-after")),
      );
    }
    const text = await response.text();
    if (!text.trim()) return {};
    try {
      const body: unknown = JSON.parse(text);
      if (body && typeof body === "object" && "ok" in body && body.ok === false)
        throw new BacklinksError(`${provider} 拒绝了请求。`, "BACKLINKS_API_ERROR");
      return body;
    } catch (error) {
      if (error instanceof BacklinksError) throw error;
      throw new BacklinksError(`${provider} 返回无效 JSON。`, "BACKLINKS_API_ERROR");
    }
  } catch (error) {
    if (signal?.aborted) throw new BacklinksError("外链请求已取消。", "BACKLINKS_ABORTED");
    if (timeout.signal.aborted)
      throw new BacklinksError(`${provider} 请求超时。`, "BACKLINKS_TIMEOUT");
    if (error instanceof BacklinksError) throw error;
    throw new BacklinksError(`${provider} 网络请求失败。`, "BACKLINKS_TRANSPORT");
  } finally {
    clearTimeout(timer);
  }
}

export function parseResponse<T>(
  schema: {
    safeParse(
      value: unknown,
    ):
      | { success: true; data: T }
      | { success: false; error?: { issues?: readonly { path?: readonly PropertyKey[] }[] } };
  },
  value: unknown,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    // 只给出有限 schema 路径，不拼接 Zod message 或响应值，避免模型/日志获得后台敏感内容。
    const fields = [
      ...new Set(
        (parsed.error?.issues ?? []).map((issue) =>
          (
            issue.path
              ?.map((part) =>
                typeof part === "number"
                  ? String(part)
                  : typeof part === "string" && /^[A-Za-z_][\w-]{0,63}$/.test(part)
                    ? part
                    : "?",
              )
              .join(".") || "<root>"
          ).slice(0, 160),
        ),
      ),
    ].slice(0, 5);
    throw new BacklinksError(
      `外链后台响应字段与 API 契约不一致${fields.length ? `（字段：${fields.join("、")}）` : ""}。`,
      "BACKLINKS_API_ERROR",
    );
  }
  return parsed.data;
}
