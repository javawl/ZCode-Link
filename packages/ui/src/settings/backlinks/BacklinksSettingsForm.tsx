import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import type { BacklinksSettingsPatch, BacklinksSettingsSnapshot } from "@zcode/services";
import { Input } from "@/components/ui/input.js";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

type BrowserDisplayMode = BacklinksSettingsSnapshot["browser"]["displayMode"];

/** 后台为推荐默认值，排在首位；无窗口模式无法人工验证，放在最后。 */
const BROWSER_DISPLAY_MODES: readonly BrowserDisplayMode[] = ["background", "visible", "headless"];

const BROWSER_DISPLAY_MODE_LABEL_KEYS: Record<BrowserDisplayMode, string> = {
  background: "displayModeBackground",
  visible: "displayModeVisible",
  headless: "displayModeHeadless",
};

function ProviderFields({
  name,
  baseUrl,
  onBaseUrl,
  token,
  onToken,
  configured,
  clear,
  onClear,
  disabled,
  tokenHelp,
  children,
}: {
  name: string;
  baseUrl: string;
  onBaseUrl(value: string): void;
  token: string;
  onToken(value: string): void;
  configured: boolean;
  clear: boolean;
  onClear(value: boolean): void;
  disabled: boolean;
  tokenHelp?: string;
  children?: ReactNode;
}) {
  const { intl } = useZCodeIntl();
  const id = useId();
  const t = (key: string) => intl.formatMessage({ id: `backlinks.${key}` });
  return (
    <fieldset disabled={disabled} className="space-y-3 rounded-xl border border-border p-4">
      <legend className="px-1 text-ui-base font-medium">{name}</legend>
      <label className="block space-y-1 text-ui-sm">
        <span>{t("baseUrl")}</span>
        <Input
          type="url"
          value={baseUrl}
          onChange={(event) => onBaseUrl(event.target.value)}
          placeholder="https://api.example.com"
          autoComplete="off"
        />
      </label>
      <label className="block space-y-1 text-ui-sm">
        <span>{t("token")}</span>
        <Input
          type="password"
          value={token}
          onChange={(event) => onToken(event.target.value)}
          disabled={clear}
          autoComplete="new-password"
          placeholder={t(configured ? "tokenConfigured" : "tokenMissing")}
        />
      </label>
      {tokenHelp ? <p className="text-ui-sm text-foreground-subtle">{tokenHelp}</p> : null}
      <div className="flex items-center gap-2 text-ui-sm">
        <Checkbox
          id={id}
          checked={clear}
          onCheckedChange={(value) => onClear(value === true)}
          disabled={!configured || disabled}
        />
        <label htmlFor={id}>{t("clearToken")}</label>
      </div>
      {children}
    </fieldset>
  );
}

export function BacklinksSettingsForm({
  snapshot,
  saving,
  onSave,
}: {
  snapshot: BacklinksSettingsSnapshot;
  saving: boolean;
  onSave(patch: BacklinksSettingsPatch): Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const t = (key: string) => intl.formatMessage({ id: `backlinks.${key}` });
  const [supermanagerUrl, setSupermanagerUrl] = useState(snapshot.supermanager.baseUrl);
  const [cloudMailUrl, setCloudMailUrl] = useState(snapshot.cloudMail.baseUrl);
  const [supermanagerToken, setSupermanagerToken] = useState("");
  const [cloudMailToken, setCloudMailToken] = useState("");
  const [clearSupermanager, setClearSupermanager] = useState(false);
  const [clearCloudMail, setClearCloudMail] = useState(false);
  const [mailboxDomain, setMailboxDomain] = useState(snapshot.mailboxDomain);
  const [browser, setBrowser] = useState(snapshot.browser);
  const [saved, setSaved] = useState(false);
  const displayModeId = useId();

  useEffect(() => {
    setSupermanagerUrl(snapshot.supermanager.baseUrl);
    setCloudMailUrl(snapshot.cloudMail.baseUrl);
    setMailboxDomain(snapshot.mailboxDomain);
    setBrowser(snapshot.browser);
    setSupermanagerToken("");
    setCloudMailToken("");
    setClearSupermanager(false);
    setClearCloudMail(false);
  }, [snapshot]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setSaved(false);
    try {
      await onSave({
        supermanager: {
          baseUrl: supermanagerUrl,
          ...(clearSupermanager
            ? { clearToken: true }
            : supermanagerToken.trim()
              ? { token: supermanagerToken }
              : {}),
        },
        cloudMail: {
          baseUrl: cloudMailUrl,
          ...(clearCloudMail
            ? { clearToken: true }
            : cloudMailToken.trim()
              ? { token: cloudMailToken }
              : {}),
        },
        mailboxDomain,
        browser: {
          displayMode: browser.displayMode,
          // 规格要求设置界面同时写入派生的旧字段，旧读取方仍依赖 headless。
          headless: browser.displayMode === "headless",
          channel: browser.channel,
          executablePath: browser.executablePath,
          userDataDir: browser.userDataDir ?? "",
          cdpEndpoint: browser.cdpEndpoint ?? "",
        },
      });
      setSaved(true);
    } catch {
      // The host error is rendered by useBacklinksService; leave the user's unsaved fields intact.
    }
  };

  return (
    <form
      onSubmit={(event) => {
        void submit(event);
      }}
      onChange={() => setSaved(false)}
      className="space-y-4"
    >
      <p className="text-ui-sm text-foreground-subtle">{t("configurationHelp")}</p>
      <div className="grid gap-4 xl:grid-cols-2">
        <ProviderFields
          name={t("supermanager")}
          tokenHelp={t("agentTokenHelp")}
          baseUrl={supermanagerUrl}
          onBaseUrl={setSupermanagerUrl}
          token={supermanagerToken}
          onToken={setSupermanagerToken}
          configured={snapshot.supermanager.tokenConfigured}
          clear={clearSupermanager}
          onClear={setClearSupermanager}
          disabled={saving}
        />
        <ProviderFields
          name={t("cloudMail")}
          baseUrl={cloudMailUrl}
          onBaseUrl={setCloudMailUrl}
          token={cloudMailToken}
          onToken={setCloudMailToken}
          configured={snapshot.cloudMail.tokenConfigured}
          clear={clearCloudMail}
          onClear={setClearCloudMail}
          disabled={saving}
        >
          <label className="block space-y-1 text-ui-sm">
            <span>{t("mailboxDomain")}</span>
            <Input
              value={mailboxDomain}
              onChange={(event) => setMailboxDomain(event.target.value)}
              disabled={saving}
              placeholder={t("mailboxDomainAuto")}
              autoComplete="off"
            />
          </label>
          <p className="text-ui-sm text-foreground-subtle">{t("mailboxDomainHelp")}</p>
        </ProviderFields>
      </div>
      <fieldset disabled={saving} className="space-y-3 rounded-xl border border-border p-4">
        <legend className="px-1 text-ui-base font-medium">{t("browser")}</legend>
        <label className="block space-y-1 text-ui-sm">
          <span>{t("userDataDir")}</span>
          <Input
            value={browser.userDataDir ?? ""}
            autoComplete="off"
            onChange={(event) =>
              setBrowser({ ...browser, userDataDir: event.target.value, cdpEndpoint: "" })
            }
          />
        </label>
        <label className="block space-y-1 text-ui-sm">
          <span>{t("cdpEndpoint")}</span>
          <Input
            value={browser.cdpEndpoint ?? ""}
            placeholder="http://127.0.0.1:9222"
            autoComplete="off"
            onChange={(event) =>
              setBrowser({ ...browser, cdpEndpoint: event.target.value, userDataDir: "" })
            }
          />
        </label>
        <p className="text-ui-sm text-foreground-subtle">{t("browserReuseHelp")}</p>
        <div className="grid gap-3 xl:grid-cols-2">
          <label className="block space-y-1 text-ui-sm">
            <span>{t("channel")}</span>
            <Input
              value={browser.channel}
              onChange={(event) => setBrowser({ ...browser, channel: event.target.value })}
              placeholder="chromium / chrome / msedge"
            />
          </label>
          <label className="block space-y-1 text-ui-sm">
            <span>{t("executable")}</span>
            <Input
              value={browser.executablePath}
              onChange={(event) => setBrowser({ ...browser, executablePath: event.target.value })}
            />
          </label>
        </div>
        <div className="space-y-1 text-ui-sm">
          <label htmlFor={displayModeId} className="block">
            {t("displayMode")}
          </label>
          <Select
            value={browser.displayMode}
            onValueChange={(value) => {
              setBrowser({ ...browser, displayMode: value as BrowserDisplayMode });
              // 显式清除“已保存”提示，不依赖 Radix 隐藏原生 select 冒泡到表单的 change 事件。
              setSaved(false);
            }}
            disabled={saving}
          >
            <SelectTrigger id={displayModeId} className="w-full justify-between">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="start">
              {BROWSER_DISPLAY_MODES.map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {t(BROWSER_DISPLAY_MODE_LABEL_KEYS[mode])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <p className="text-ui-sm text-foreground-subtle">{t("displayModeHelp")}</p>
      </fieldset>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={saving}>
          {t(saving ? "saving" : "save")}
        </Button>
        {saved ? (
          <p role="status" className="text-ui-sm text-success">
            {t("saved")}
          </p>
        ) : null}
      </div>
    </form>
  );
}
