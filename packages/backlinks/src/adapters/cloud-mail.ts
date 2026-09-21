import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { MailboxProvider } from "../domain/ports.js";
import type { MailboxAddress, MailPollOptions, VerificationMail } from "../domain/schemas.js";
import { BacklinksError } from "../domain/errors.js";
import { mailboxDomainSchema } from "../domain/settings.js";
import { requestJson, httpErrorCode, parseResponse } from "./http.js";
import type { HttpProviderConfig } from "./http.js";

const mailRowsSchema = z.array(
  z.object({
    subject: z.string().default(""),
    sendEmail: z.string().default(""),
    text: z.string().optional(),
    content: z.string().optional(),
    code: z.string().nullable().optional(),
    createTime: z.string().default(""),
  }),
);
type MailRow = z.infer<typeof mailRowsSchema>[number];
function project(row: MailRow): VerificationMail {
  const text = row.text || row.content || "";
  return {
    subject: row.subject,
    from: row.sendEmail,
    text,
    code: row.code || null,
    link: text.match(/https?:\/\/[^\s<>"')]+/u)?.[0] ?? null,
    receivedAt: row.createTime,
  };
}
function unpack(body: unknown): unknown {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== "object")
    throw new BacklinksError("Cloud Mail 响应格式无效。", "BACKLINKS_API_ERROR");
  if ("code" in body) {
    const code = Number(body.code);
    if (code !== 0 && !(code >= 200 && code < 300))
      throw new BacklinksError("Cloud Mail 拒绝了请求。", httpErrorCode(code));
  }
  return "data" in body ? body.data : body;
}

/** Mailbox API adapter; verification messages remain authoritative on the backend. */
export class CloudMailMailbox implements MailboxProvider {
  readonly id = "cloud-mail";
  constructor(
    private readonly config: HttpProviderConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  available(): boolean {
    return this.config.baseUrl.length > 0 && this.config.token.length > 0;
  }
  async createMailbox(
    options: { readonly localPart: string; readonly domain: string },
    signal?: AbortSignal,
  ): Promise<MailboxAddress> {
    const domain = mailboxDomainSchema.safeParse(options.domain);
    if (!domain.success || !domain.data || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(options.localPart))
      throw new BacklinksError("邮箱 localPart 或 domain 无效。", "BACKLINKS_INVALID_REQUEST");
    const email = `${options.localPart}@${domain.data}`;
    unpack(
      await requestJson(
        this.config,
        this.fetcher,
        "cloud-mail",
        "/public/addUser",
        "POST",
        { list: [{ email }] },
        signal,
      ),
    );
    return { email };
  }

  async pollMail(
    address: MailboxAddress,
    options: MailPollOptions,
    signal?: AbortSignal,
  ): Promise<VerificationMail | null> {
    if (
      !z.email().safeParse(address.email).success ||
      !Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs <= 0 ||
      options.timeoutMs > 300000 ||
      !Number.isSafeInteger(options.intervalMs) ||
      options.intervalMs <= 0
    )
      throw new BacklinksError("邮箱地址或轮询时间无效。", "BACKLINKS_INVALID_REQUEST");
    if (signal?.aborted) throw new BacklinksError("邮箱等待已取消。", "BACKLINKS_ABORTED");
    const total = new AbortController();
    const timer = setTimeout(() => total.abort(), options.timeoutMs);
    const deadline = Date.now() + options.timeoutMs;
    const combined = signal ? AbortSignal.any([signal, total.signal]) : total.signal;
    try {
      while (true) {
        const payload = unpack(
          await requestJson(
            this.config,
            this.fetcher,
            "cloud-mail",
            "/public/emailList",
            "POST",
            { toEmail: address.email, size: 20, num: 1, type: 0, isDel: 0 },
            combined,
          ),
        );
        const values = Array.isArray(payload)
          ? payload
          : payload && typeof payload === "object" && "list" in payload
            ? payload.list
            : undefined;
        const rows = parseResponse(mailRowsSchema, values);
        const match = rows.find(
          (row) =>
            (options.subjectContains === undefined ||
              row.subject.toLowerCase().includes(options.subjectContains.toLowerCase())) &&
            (options.fromContains === undefined ||
              row.sendEmail.toLowerCase().includes(options.fromContains.toLowerCase())),
        );
        if (match) return project(match);
        const remaining = deadline - Date.now();
        if (remaining <= options.intervalMs) return null;
        await delay(options.intervalMs, undefined, { signal: combined });
      }
    } catch (error) {
      if (signal?.aborted) throw new BacklinksError("邮箱等待已取消。", "BACKLINKS_ABORTED");
      if (total.signal.aborted) return null;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
