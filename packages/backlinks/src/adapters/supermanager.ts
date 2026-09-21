import { z } from "zod";
import type { BacklinkBatchSourceProvider } from "../domain/ports.js";
import { BacklinksError } from "../domain/errors.js";
import {
  batchSummarySchema,
  batchDetailSchema,
  leaseClaimSchema,
  heartbeatSchema,
  itemOutcomeSchema,
  badgeResultSchema,
  tagResultSchema,
  itemResultSchema,
} from "../domain/schemas.js";
import type { BacklinkItemResult, BacklinkBadgeInput } from "../domain/schemas.js";
import { requestJson, parseResponse } from "./http.js";
import type { HttpProviderConfig } from "./http.js";

function id(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new BacklinksError("ID 必须是正整数。", "BACKLINKS_INVALID_REQUEST");
  return value;
}

/** Adapter for the unchanged link-harness 2.0.0 /api/agent contract. */
export class SupermanagerBatchSource implements BacklinkBatchSourceProvider {
  readonly id = "supermanager";
  constructor(
    private readonly config: HttpProviderConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  available(): boolean {
    return this.config.baseUrl.length > 0 && this.config.token.length > 0;
  }
  async listBatches(signal?: AbortSignal) {
    const body = await this.request("/api/agent/batches", "GET", undefined, signal);
    return parseResponse(z.object({ batches: z.array(batchSummarySchema) }), body).batches;
  }
  async getBatch(batchId: number, signal?: AbortSignal) {
    return parseResponse(
      batchDetailSchema,
      await this.request(`/api/agent/batches/${id(batchId)}`, "GET", undefined, signal),
    );
  }
  async claim(batchId: number, itemIds?: readonly number[], signal?: AbortSignal) {
    if (itemIds && itemIds.length === 0)
      throw new BacklinksError("显式认领列表不能为空。", "BACKLINKS_INVALID_REQUEST");
    return parseResponse(
      leaseClaimSchema,
      await this.request(
        `/api/agent/batches/${id(batchId)}/claim`,
        "POST",
        itemIds === undefined ? {} : { itemIds: [...new Set(itemIds.map(id))] },
        signal,
      ),
    );
  }
  async heartbeat(leaseId: number, signal?: AbortSignal) {
    return parseResponse(
      heartbeatSchema,
      await this.request(`/api/agent/leases/${id(leaseId)}/heartbeat`, "POST", undefined, signal),
    );
  }
  async release(leaseId: number, signal?: AbortSignal): Promise<void> {
    await this.request(`/api/agent/leases/${id(leaseId)}/release`, "POST", undefined, signal);
  }
  async reportItemResult(itemId: number, input: BacklinkItemResult, signal?: AbortSignal) {
    const parsed = itemResultSchema.safeParse(input);
    if (!parsed.success)
      throw new BacklinksError("条目结果缺少必填字段。", "BACKLINKS_INVALID_REQUEST");
    const result = parsed.data;
    const payload =
      "evidence" in result
        ? { ...result, evidence: undefined, evidenceZh: result.evidence }
        : result;
    return parseResponse(
      itemOutcomeSchema,
      await this.request(`/api/agent/items/${id(itemId)}/result`, "POST", payload, signal),
    );
  }
  async addBadge(websiteId: number, badge: BacklinkBadgeInput, signal?: AbortSignal) {
    return parseResponse(
      badgeResultSchema,
      await this.request(
        `/api/agent/websites/${id(websiteId)}/footer-backlinks`,
        "POST",
        badge,
        signal,
      ),
    );
  }
  async tagSource(sourceId: number, names: readonly string[], signal?: AbortSignal) {
    const tags = z.array(z.string().trim().min(1).max(100)).min(1).max(10).safeParse(names);
    if (!tags.success)
      throw new BacklinksError("来源标签须为 1–10 个非空名称。", "BACKLINKS_INVALID_REQUEST");
    return parseResponse(
      tagResultSchema,
      await this.request(
        `/api/agent/sources/${id(sourceId)}/tags`,
        "POST",
        { tags: [...new Set(tags.data)] },
        signal,
      ),
    );
  }
  private request(path: string, method: "GET" | "POST", payload?: unknown, signal?: AbortSignal) {
    return requestJson(this.config, this.fetcher, "supermanager", path, method, payload, signal);
  }
}
