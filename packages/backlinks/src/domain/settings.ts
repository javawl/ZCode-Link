import { z } from "zod";

/** Empty values intentionally disable a persisted field instead of inheriting environment values. */
export const httpBaseUrlSchema = z
  .string()
  .trim()
  .refine((value) => {
    if (value === "") return true;
    try {
      const url = new URL(value);
      return (
        ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    } catch {
      return false;
    }
  }, "请输入不含凭据、查询或片段的 HTTP(S) 服务地址")
  .transform((value) => value.replace(/\/+$/, ""));

export const mailboxDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .refine(
    (value) =>
      value === "" ||
      /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
        value,
      ),
    "请输入有效邮箱域名",
  );
const provider = z.strictObject({
  baseUrl: httpBaseUrlSchema.optional(),
  token: z.string().optional(),
});
const launchArguments = z
  .array(
    z
      .string()
      .max(4096)
      .refine(
        (value) => !/^--(?:user-data-dir|profile-directory)(?:=|\s|$)/i.test(value.trim()),
        "不能通过参数覆盖专用浏览器 profile",
      ),
  )
  .max(100);
const windowPosition = z
  .string()
  .regex(/^-?\d+,-?\d+$/)
  .refine(
    (value) => value.split(",").every((part) => Number.isSafeInteger(Number(part))),
    "窗口位置必须为两个安全整数",
  );
const browser = z.strictObject({
  headless: z.boolean().optional(),
  channel: z.string().trim().max(100).optional(),
  executablePath: z.string().trim().optional(),
  launchArgs: launchArguments.optional(),
  ignoreDefaultArgs: launchArguments.optional(),
  windowPosition: windowPosition.optional(),
});
export const settingsFileSchema = z.strictObject({
  version: z.literal(1),
  supermanager: provider.optional(),
  cloudMail: provider.optional(),
  mailboxDomain: mailboxDomainSchema.optional(),
  browser: browser.optional(),
});
const patchProvider = provider
  .extend({ clearToken: z.boolean().optional() })
  .refine(
    (value) => !(value.clearToken && value.token?.trim()),
    "清除令牌与设置新令牌不能同时选择",
  );
export const backlinksSettingsPatchSchema = z.strictObject({
  supermanager: patchProvider.optional(),
  cloudMail: patchProvider.optional(),
  mailboxDomain: mailboxDomainSchema.optional(),
  browser: browser.optional(),
});
export type BacklinksSettingsPatch = z.input<typeof backlinksSettingsPatchSchema>;
export type BacklinksSettingsFile = z.infer<typeof settingsFileSchema>;

export interface BacklinksSettingsSnapshot {
  readonly supermanager: { readonly baseUrl: string; readonly tokenConfigured: boolean };
  readonly cloudMail: { readonly baseUrl: string; readonly tokenConfigured: boolean };
  readonly mailboxDomain: string;
  readonly browser: {
    readonly headless: boolean;
    readonly channel: string;
    readonly executablePath: string;
    readonly launchArgs?: readonly string[];
    readonly ignoreDefaultArgs?: readonly string[];
    readonly windowPosition?: string;
  };
}

/** Node-only effective configuration; never expose this value through RPC or tool results. */
export interface EffectiveBacklinksConfig {
  readonly supermanager: { readonly baseUrl: string; readonly token: string };
  readonly cloudMail: { readonly baseUrl: string; readonly token: string };
  readonly mailboxDomain: string;
  readonly browser: BacklinksSettingsSnapshot["browser"];
}
