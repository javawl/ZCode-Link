import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useBacklinksService } from "@/hooks/useBacklinksService.js";
import { BacklinksSettingsForm } from "./backlinks/BacklinksSettingsForm.js";

/** 批次已经迁入侧栏，设置页只负责连接配置，避免两套批次列表同时轮询。 */
export function BacklinksSection(props: {
  workspacePath: string | null;
  workspaceIdentity?: string;
  isDesktop: boolean;
  onPublished?: () => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (key: string) => intl.formatMessage({ id: `backlinks.${key}` });
  const backlinks = useBacklinksService({ ...props, pollBatches: false });
  return (
    <div className="space-y-4" data-testid="backlinks-section">
      <h3 className="text-ui-base font-medium">{t("settings")}</h3>
      <p className="text-ui-sm text-foreground-subtle">{t("settingsDescription")}</p>
      {backlinks.settingsError ? (
        <p role="alert" className="whitespace-pre-wrap break-words text-ui-sm text-destructive">
          {backlinks.settingsError}
        </p>
      ) : null}
      {backlinks.settings ? (
        <BacklinksSettingsForm
          snapshot={backlinks.settings}
          saving={backlinks.saving}
          onSave={backlinks.saveSettings}
        />
      ) : (
        <p role="status" className="text-ui-sm">
          {t(backlinks.connecting ? "connecting" : "loading")}
        </p>
      )}
    </div>
  );
}
