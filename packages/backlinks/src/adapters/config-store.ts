import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { acquireConfigLock } from "./config-lock.js";
import { BacklinksError } from "../domain/errors.js";
import { backlinksSettingsPatchSchema, settingsFileSchema } from "../domain/settings.js";
import type {
  BacklinksSettingsFile,
  BacklinksSettingsPatch,
  BacklinksSettingsSnapshot,
  EffectiveBacklinksConfig,
} from "../domain/settings.js";

export interface BacklinksConfigOptions {
  readonly dataBaseDir?: string;
  readonly env?: Record<string, string | undefined>;
}
const writers = new Map<string, Promise<unknown>>();
function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
export function resolveBacklinksDataBaseDir(options: BacklinksConfigOptions = {}): string {
  return resolve(
    options.dataBaseDir ??
      options.env?.ZCODE_DATA_BASE_DIR ??
      process.env.ZCODE_DATA_BASE_DIR ??
      homedir(),
  );
}
export function resolveBacklinksConfigPath(options: BacklinksConfigOptions = {}): string {
  return join(resolveBacklinksDataBaseDir(options), ".zcode", "v2", "backlinks.json");
}

/** The only persisted configuration writer. Each operation re-reads to observe other hosts' writes. */
export class BacklinksConfigStore {
  readonly path: string;
  private readonly env: Record<string, string | undefined>;
  constructor(options: BacklinksConfigOptions = {}) {
    this.path = resolveBacklinksConfigPath(options);
    this.env = options.env ?? process.env;
  }

  async getSettings(): Promise<BacklinksSettingsSnapshot> {
    const effective = await this.readEffective();
    return {
      supermanager: {
        baseUrl: effective.supermanager.baseUrl,
        tokenConfigured: effective.supermanager.token.length > 0,
      },
      cloudMail: {
        baseUrl: effective.cloudMail.baseUrl,
        tokenConfigured: effective.cloudMail.token.length > 0,
      },
      mailboxDomain: effective.mailboxDomain,
      browser: effective.browser,
    };
  }

  async readEffective(): Promise<EffectiveBacklinksConfig> {
    const saved = await this.readFile();
    const merged = settingsFileSchema.safeParse({
      version: 1,
      supermanager: {
        baseUrl:
          saved.supermanager?.baseUrl ??
          this.env.ZCODE_BACKLINKS_SUPERMANAGER_BASE_URL ??
          this.env.SUPERMANAGER_BASE_URL ??
          "",
        token:
          saved.supermanager?.token ??
          this.env.ZCODE_BACKLINKS_SUPERMANAGER_TOKEN ??
          this.env.SUPERMANAGER_TOKEN ??
          "",
      },
      cloudMail: {
        baseUrl:
          saved.cloudMail?.baseUrl ??
          this.env.ZCODE_BACKLINKS_CLOUD_MAIL_BASE_URL ??
          this.env.CLOUDMAIL_BASE_URL ??
          "",
        token:
          saved.cloudMail?.token ??
          this.env.ZCODE_BACKLINKS_CLOUD_MAIL_TOKEN ??
          this.env.CLOUDMAIL_TOKEN ??
          "",
      },
      mailboxDomain: saved.mailboxDomain ?? this.env.ZCODE_BACKLINKS_MAILBOX_DOMAIN ?? "",
      browser: {
        ...saved.browser,
        headless: saved.browser?.headless ?? false,
        channel: saved.browser?.channel ?? "chrome",
        executablePath: saved.browser?.executablePath ?? "",
        launchArgs: saved.browser?.launchArgs ?? [],
        ignoreDefaultArgs: saved.browser?.ignoreDefaultArgs ?? [],
      },
    });
    if (!merged.success)
      throw new BacklinksError(
        "外链配置或环境变量格式无效，请检查服务地址、邮箱域名和浏览器设置。",
        "BACKLINKS_INVALID_REQUEST",
      );
    const value = merged.data;
    return {
      supermanager: {
        baseUrl: value.supermanager?.baseUrl ?? "",
        token: value.supermanager?.token?.trim() ?? "",
      },
      cloudMail: {
        baseUrl: value.cloudMail?.baseUrl ?? "",
        token: value.cloudMail?.token?.trim() ?? "",
      },
      mailboxDomain: value.mailboxDomain ?? "",
      browser: {
        ...value.browser,
        headless: value.browser?.headless ?? false,
        channel: value.browser?.channel ?? "chrome",
        executablePath: value.browser?.executablePath ?? "",
        launchArgs: value.browser?.launchArgs ?? [],
        ignoreDefaultArgs: value.browser?.ignoreDefaultArgs ?? [],
      },
    };
  }

  async updateSettings(input: BacklinksSettingsPatch): Promise<BacklinksSettingsSnapshot> {
    const parsed = backlinksSettingsPatchSchema.safeParse(input);
    if (!parsed.success)
      throw new BacklinksError("外链设置无效，原配置未更改。", "BACKLINKS_INVALID_REQUEST");
    const previous = writers.get(this.path) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        const unlock = await acquireConfigLock(`${this.path}.lock`);
        try {
          const current = await this.readFile();
          const patch = parsed.data;
          const merged: BacklinksSettingsFile = { ...current };
          for (const key of ["supermanager", "cloudMail"] as const) {
            const edit = patch[key];
            if (!edit) continue;
            merged[key] = {
              ...current[key],
              ...(edit.baseUrl === undefined ? {} : { baseUrl: edit.baseUrl }),
            };
            // 清除时写入空串以覆盖环境回退；普通空白草稿不能误删已保存令牌。
            if (edit.clearToken) merged[key].token = "";
            else if (edit.token?.trim()) merged[key].token = edit.token.trim();
          }
          if (patch.mailboxDomain !== undefined) merged.mailboxDomain = patch.mailboxDomain;
          if (patch.browser) merged.browser = { ...current.browser, ...patch.browser };
          await this.writeFile(settingsFileSchema.parse(merged));
        } finally {
          await unlock();
        }
        return await this.getSettings();
      });
    writers.set(this.path, next);
    try {
      return await next;
    } finally {
      if (writers.get(this.path) === next) writers.delete(this.path);
    }
  }

  private async readFile(): Promise<BacklinksSettingsFile> {
    let content: string;
    try {
      content = await readFile(this.path, "utf8");
    } catch (error) {
      if (isMissing(error)) return { version: 1 };
      throw error;
    }
    try {
      return settingsFileSchema.parse(JSON.parse(content));
    } catch {
      throw new BacklinksError(
        "外链配置文件无法解析，请修复 backlinks.json 后重试；文件未被覆盖。",
        "BACKLINKS_INVALID_REQUEST",
      );
    }
  }

  private async writeFile(value: BacklinksSettingsFile): Promise<void> {
    const temp = `${this.path}.${randomUUID()}.tmp`;
    const handle = await open(temp, "wx", 0o600);
    try {
      try {
        await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, this.path);
    } finally {
      await rm(temp, { force: true });
    }
  }
}
