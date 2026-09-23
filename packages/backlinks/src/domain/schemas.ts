import { z } from "zod";

const id = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const text = z.string();
// 后台未填写的网站资料会返回 null；对齐源 harness 的省略语义，保持公共输出为可选字符串。
// 仅兼容已知的空值，不把数字、数组或对象强转为内容，避免掩盖真正的契约错误。
const optionalProfileText = text.nullish().transform((value) => value ?? undefined);
const nullable = text
  .nullable()
  .optional()
  .transform((value) => value ?? null);
export const batchSummarySchema = z.object({
  id,
  name: text,
  websiteId: id,
  websiteName: text,
  websiteHost: text,
  plannedAt: text,
  counts: z.object({
    pending: z.coerce.number().int().nonnegative(),
    executed: z.coerce.number().int().nonnegative(),
    skipped: z.coerce.number().int().nonnegative(),
    failed: z.coerce.number().int().nonnegative(),
    total: z.coerce.number().int().nonnegative(),
  }),
  executing: z.boolean().default(false),
});
export const batchItemSchema = z.object({
  id,
  sourceId: id,
  sourceName: text,
  sourceUrl: text,
  sourceHost: text,
  submitUrl: nullable,
  sourceNotes: nullable,
  category: nullable,
  tags: z.array(text).default([]),
  paymentType: text,
  linkType: text,
  status: text,
  failureMode: nullable,
  failureReason: nullable,
  publishedUrl: nullable,
  publishStatus: nullable,
  plannedAt: text,
});
export const batchDetailSchema = z.object({
  batch: batchSummarySchema,
  website: z.object({
    id,
    name: text,
    siteUrl: text,
    siteHost: text,
    shortDescription: optionalProfileText,
    longDescription: optionalProfileText,
    logoUrl: optionalProfileText,
    screenshotUrl: optionalProfileText,
    keyFeatures: optionalProfileText,
    pricingType: optionalProfileText,
  }),
  anchors: z.array(z.object({ id, anchorText: text, targetUrl: text })).default([]),
  items: z.array(batchItemSchema).default([]),
});
export const leaseClaimSchema = z.object({
  leaseId: id,
  leaseExpiresAt: text,
  items: z.array(batchItemSchema),
});
export const heartbeatSchema = z.object({ leaseId: id, leaseExpiresAt: text });
export const itemOutcomeSchema = z.object({
  itemStatus: z.enum(["executed", "failed", "skipped"]),
  publishRecordId: id
    .nullable()
    .optional()
    .transform((value) => value ?? null),
});
export const badgeResultSchema = z.object({ backlinkId: id, callbackTriggered: z.boolean() });
export const tagResultSchema = z.object({
  sourceId: id,
  attached: z.array(z.object({ id, name: text, created: z.boolean() })),
});

export type BacklinkBatchSummary = z.infer<typeof batchSummarySchema>;
export type BacklinkBatchItem = z.infer<typeof batchItemSchema>;
export type BacklinkBatchDetail = z.infer<typeof batchDetailSchema>;
export type BacklinkWebsiteAnchor = BacklinkBatchDetail["anchors"][number];
export type BacklinkLeaseClaim = z.infer<typeof leaseClaimSchema>;
export type BacklinkHeartbeat = z.infer<typeof heartbeatSchema>;
export type BacklinkItemOutcome = z.infer<typeof itemOutcomeSchema>;
export type BacklinkBadgeResult = z.infer<typeof badgeResultSchema>;
export type BacklinkTagResult = z.infer<typeof tagResultSchema>;
export interface BacklinkBadgeInput {
  readonly name: string;
  readonly html: string;
  readonly isActive?: boolean;
}
export interface MailboxAddress {
  readonly email: string;
}
export interface VerificationMail {
  readonly subject: string;
  readonly from: string;
  readonly text: string;
  readonly code: string | null;
  readonly link: string | null;
  readonly receivedAt: string;
}
export interface MailPollOptions {
  readonly subjectContains?: string;
  readonly fromContains?: string;
  readonly timeoutMs: number;
  readonly intervalMs: number;
}

const requiredText = z.string().trim().min(1);
const httpUrl = requiredText.refine((value) => {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}, "Expected an HTTP(S) URL");
export const itemResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("live"),
    publicUrl: httpUrl,
    anchorText: requiredText,
    targetUrl: httpUrl,
    evidence: requiredText.optional(),
  }),
  z.object({
    status: z.literal("submitted"),
    publicUrl: httpUrl.optional(),
    anchorText: requiredText,
    targetUrl: httpUrl,
    evidence: requiredText.optional(),
  }),
  z.object({
    status: z.literal("failed"),
    failureMode: z.enum(["retryable", "manual_required"]),
    failureReason: requiredText,
    evidence: requiredText.optional(),
  }),
  z.object({ status: z.literal("skipped"), skipReason: requiredText }),
]);
export type BacklinkItemResult = z.infer<typeof itemResultSchema>;
export { id as positiveIdSchema, requiredText, httpUrl };
