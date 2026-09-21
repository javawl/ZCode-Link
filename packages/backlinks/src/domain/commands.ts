import { z } from "zod";
import { itemResultSchema, requiredText } from "./schemas.js";
import { mailboxDomainSchema } from "./settings.js";

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const result = z.union(
  itemResultSchema.options.map((schema) =>
    schema.extend({ action: z.literal("item_result"), itemId: id }),
  ),
);
export const backlinksCommandSchema = z.union([
  z.object({ action: z.literal("batch_list") }),
  z.object({ action: z.literal("batch_get"), batchId: id }),
  z.object({
    action: z.literal("batch_claim"),
    batchId: id,
    itemIds: z.array(id).min(1).optional(),
  }),
  z.object({ action: z.literal("lease_heartbeat"), leaseId: id }),
  z.object({ action: z.literal("lease_release"), leaseId: id }),
  result,
  z.object({
    action: z.literal("badge_add"),
    websiteId: id,
    name: requiredText,
    html: requiredText,
    isActive: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("source_tags"),
    sourceId: id,
    tags: z.array(requiredText.max(100)).min(1).max(10),
  }),
  z.object({
    action: z.literal("mailbox_create"),
    localPart: z
      .string()
      .regex(/^[a-z0-9][a-z0-9._-]*$/i)
      .max(64),
    domain: mailboxDomainSchema.optional(),
  }),
  z.object({
    action: z.literal("mail_wait"),
    mailEmail: z.email(),
    subjectContains: z.string().optional(),
    fromContains: z.string().optional(),
    waitTimeoutMs: z.number().int().positive().max(300000).optional(),
  }),
]);
export type BacklinksCommand = z.infer<typeof backlinksCommandSchema>;
export interface BacklinksCommandResult {
  readonly action: BacklinksCommand["action"];
  readonly summary: string;
  readonly data: unknown;
}
