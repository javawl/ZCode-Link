import { backlinksCommandSchema } from "../domain/commands.js";
import type { BacklinksCommandResult } from "../domain/commands.js";
import { BacklinksError } from "../domain/errors.js";
import type { BacklinksRuntime } from "../domain/ports.js";
import { itemResultSchema } from "../domain/schemas.js";

/** Dispatch the source-compatible model tool vocabulary through the one runtime owner. */
export async function executeBacklinksCommand(
  runtime: BacklinksRuntime,
  input: unknown,
  signal?: AbortSignal,
  context?: { ownerKey?: string },
): Promise<BacklinksCommandResult> {
  const parsed = backlinksCommandSchema.safeParse(input);
  if (!parsed.success)
    throw new BacklinksError(
      `外链工具参数无效：${parsed.error.issues.map((issue) => issue.path.join(".") || "action/fields").join(", ")}`,
      "BACKLINKS_INVALID_REQUEST",
    );
  if (signal?.aborted) throw new BacklinksError("外链操作已取消。", "BACKLINKS_ABORTED");
  const command = parsed.data;
  const action = command.action;
  switch (command.action) {
    case "batch_list": {
      const batches = await runtime.listBatches(signal);
      return { action, summary: `${batches.length} 个批次`, data: { batches } };
    }
    case "batch_get": {
      const data = await runtime.getBatch(command.batchId, signal);
      return { action, summary: `${data.batch.name}：${data.items.length} 个条目`, data };
    }
    case "batch_claim": {
      const data = context?.ownerKey
        ? await runtime.claimForOwner(command.batchId, command.itemIds, context.ownerKey, signal)
        : await runtime.claim(command.batchId, command.itemIds, signal);
      return { action, summary: `租约 ${data.leaseId} 已认领 ${data.items.length} 个条目`, data };
    }
    case "lease_heartbeat": {
      const data = await runtime.heartbeat(command.leaseId, signal);
      return { action, summary: `租约 ${data.leaseId} 已续期`, data };
    }
    case "lease_release": {
      await runtime.release(command.leaseId, signal);
      return {
        action,
        summary: `租约 ${command.leaseId} 已释放`,
        data: { leaseId: command.leaseId },
      };
    }
    case "item_result": {
      const data = await runtime.reportItemResult(
        command.itemId,
        itemResultSchema.parse(command),
        signal,
      );
      return { action, summary: `条目 ${command.itemId}：${data.itemStatus}`, data };
    }
    case "badge_add": {
      const data = await runtime.addBadge(
        command.websiteId,
        {
          name: command.name,
          html: command.html,
          ...(command.isActive === undefined ? {} : { isActive: command.isActive }),
        },
        signal,
      );
      return {
        action,
        summary: `徽章 ${data.backlinkId} 已保存；${data.callbackTriggered ? "后台已触发刷新，仍须核验公开页面" : "后台未触发刷新，请使用已配置的刷新机制并核验公开页面"}`,
        data,
      };
    }
    case "source_tags": {
      const tags = [...new Set(command.tags)];
      const data = await runtime.tagSource(command.sourceId, tags, signal);
      return { action, summary: `来源 ${command.sourceId} 已添加标签：${tags.join("、")}`, data };
    }
    case "mailbox_create": {
      // 迁移后域名可留空，按后台声明解析，避免模型为补配置遍历无关文件。
      const domain =
        command.domain ||
        (await runtime.getSettings()).mailboxDomain ||
        (await runtime.getMailboxStatus(signal)).defaultDomain;
      if (!domain)
        throw new BacklinksError(
          "Cloud Mail 未提供可用域名，请检查邮箱服务配置，或在连接与浏览器中填写验证邮箱域名。",
          "BACKLINKS_INVALID_REQUEST",
        );
      const data = await runtime.createMailbox({ localPart: command.localPart, domain }, signal);
      return { action, summary: data.email, data };
    }
    case "mail_wait": {
      const data = await runtime.pollMail(
        { email: command.mailEmail },
        {
          timeoutMs: command.waitTimeoutMs ?? 120000,
          intervalMs: 5000,
          ...(command.subjectContains === undefined
            ? {}
            : { subjectContains: command.subjectContains }),
          ...(command.fromContains === undefined ? {} : { fromContains: command.fromContains }),
        },
        signal,
      );
      return {
        action,
        summary: data?.subject || (data ? "已收到验证邮件" : "等待超时，未收到匹配邮件"),
        data: data ?? { timedOut: true },
      };
    }
  }
}
