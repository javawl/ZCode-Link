import { useState } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useBacklinksService } from "@/hooks/useBacklinksService.js";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import { BacklinksConsole } from "./backlinks/BacklinksConsole.js";
import { BacklinksSettingsForm } from "./backlinks/BacklinksSettingsForm.js";

export function BacklinksSection({
  workspacePath,
  workspaceIdentity,
  isDesktop,
  onPublished,
}: {
  workspacePath: string | null;
  workspaceIdentity?: string;
  isDesktop: boolean;
  onPublished?: () => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (key: string) => intl.formatMessage({ id: `backlinks.${key}` });
  const [tab, setTab] = useState("batches");
  const backlinks = useBacklinksService({
    workspacePath,
    workspaceIdentity,
    isDesktop,
    onPublished,
  });
  return (
    <div className="space-y-4" data-testid="backlinks-section">
      <p className="text-ui-sm text-foreground-subtle">{t("description")}</p>
      {backlinks.connecting ? (
        <p role="status" className="text-ui-sm">
          {t("connecting")}
        </p>
      ) : null}
      {!backlinks.connecting && !backlinks.store ? (
        <p role="alert" className="text-ui-sm">
          {t("unavailable")}
        </p>
      ) : null}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="batches">{t("batches")}</TabsTrigger>
          <TabsTrigger value="settings">{t("settings")}</TabsTrigger>
        </TabsList>
      </Tabs>
      {backlinks.settingsError ? (
        <p role="alert" className="whitespace-pre-wrap break-words text-ui-sm text-destructive">
          {backlinks.settingsError}
        </p>
      ) : null}
      {tab === "batches" && backlinks.store ? (
        <BacklinksConsole store={backlinks.store} canPublish={Boolean(workspacePath)} />
      ) : null}
      {tab === "settings" && backlinks.settings ? (
        <BacklinksSettingsForm
          snapshot={backlinks.settings}
          saving={backlinks.saving}
          onSave={backlinks.saveSettings}
        />
      ) : null}
      {tab === "settings" && !backlinks.settings && !backlinks.settingsError && backlinks.store ? (
        <p role="status" className="text-ui-sm">
          {t("loading")}
        </p>
      ) : null}
    </div>
  );
}
