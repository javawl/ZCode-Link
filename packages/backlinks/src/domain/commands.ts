import { z } from "zod";
import { itemResultSchema, requiredText } from "./schemas.js";
import { mailboxDomainSchema } from "./settings.js";

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const itemResultCommandSchema = z.union(
  itemResultSchema.options.map((schema) =>
    schema.extend({ action: z.literal("item_result"), itemId: id }),
  ),
);
const leaseHeartbeatCommandSchema = z.object({
  action: z.literal("lease_heartbeat"),
  leaseId: id,
});
const badgeAddCommandSchema = z.object({
  action: z.literal("badge_add"),
  websiteId: id,
  name: requiredText,
  html: requiredText,
  isActive: z.boolean().optional(),
});
const sourceTagsCommandSchema = z.object({
  action: z.literal("source_tags"),
  sourceId: id,
  tags: z.array(requiredText.max(100)).min(1).max(10),
});
const mailboxCreateCommandSchema = z.object({
  action: z.literal("mailbox_create"),
  localPart: z
    .string()
    .regex(/^[a-z0-9][a-z0-9._-]*$/i)
    .max(64),
  domain: mailboxDomainSchema.optional(),
});
const mailWaitCommandSchema = z.object({
  action: z.literal("mail_wait"),
  mailEmail: z.email(),
  subjectContains: z.string().optional(),
  fromContains: z.string().optional(),
  waitTimeoutMs: z.number().int().positive().max(300000).optional(),
});

/**
 * 发布子代理只能续租并处理已分配条目，不能查询、认领或释放整个批次。
 * 该独立 schema 是运行时能力边界，避免只依赖提示词约束租约所有权。
 */
export const backlinkWorkerCommandSchema = z.union([
  leaseHeartbeatCommandSchema,
  ...itemResultCommandSchema.options,
  badgeAddCommandSchema,
  sourceTagsCommandSchema,
  mailboxCreateCommandSchema,
  mailWaitCommandSchema,
]);

export const backlinksCommandSchema = z.union([
  z.object({ action: z.literal("batch_list") }),
  z.object({ action: z.literal("batch_get"), batchId: id }),
  z.object({
    action: z.literal("batch_claim"),
    batchId: id,
    itemIds: z.array(id).min(1).optional(),
  }),
  leaseHeartbeatCommandSchema,
  z.object({ action: z.literal("lease_release"), leaseId: id }),
  ...itemResultCommandSchema.options,
  badgeAddCommandSchema,
  sourceTagsCommandSchema,
  mailboxCreateCommandSchema,
  mailWaitCommandSchema,
]);
export type BacklinksCommand = z.infer<typeof backlinksCommandSchema>;
export type BacklinkWorkerCommand = z.infer<typeof backlinkWorkerCommandSchema>;
export interface BacklinksCommandResult {
  readonly action: BacklinksCommand["action"];
  readonly summary: string;
  readonly data: unknown;
}
