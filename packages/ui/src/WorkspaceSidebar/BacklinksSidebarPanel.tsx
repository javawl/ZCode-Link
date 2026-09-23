import { useBacklinksService } from "@/hooks/useBacklinksService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { BacklinksConsole } from "@/settings/backlinks/BacklinksConsole.js";

/** 只在批次 tab 激活时挂载；仍使用当前 workspace Host 的唯一查询/发布链路。 */
export function BacklinksSidebarPanel(props: {
  workspacePath: string | null;
  workspaceIdentity?: string;
  isDesktop: boolean;
  onOpenSettings(): void;
}) {
  const backlinks = useBacklinksService(props);
  const { intl } = useZCodeIntl();
  return (
    <div className="min-w-0 px-2 pb-2" data-testid="backlinks-sidebar-panel">
      {backlinks.store ? (
        <BacklinksConsole
          store={backlinks.store}
          canPublish={Boolean(props.workspacePath)}
          compact
          onOpenSettings={props.onOpenSettings}
        />
      ) : (
        <p role="status" className="p-2 text-ui-sm text-foreground-subtle">
          {intl.formatMessage({
            id: backlinks.connecting ? "backlinks.connecting" : "backlinks.unavailable",
          })}
        </p>
      )}
    </div>
  );
}
