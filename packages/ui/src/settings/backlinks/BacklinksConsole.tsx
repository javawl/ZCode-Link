import { useId, useState } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { RefreshCw, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  filterBacklinkBatches,
  type BacklinksConsoleState,
} from "@/store/backlinksConsoleStore.js";
import { BacklinksBatchDetails, backlinkStatusClass } from "./BacklinksBatchDetails.js";
import "./backlinksRunningCard.css";

export function BacklinksConsole({
  store,
  canPublish,
  compact = false,
  onOpenSettings,
}: {
  store: StoreApi<BacklinksConsoleState>;
  canPublish: boolean;
  compact?: boolean;
  onOpenSettings?: () => void;
}) {
  const state = useStore(store);
  const { intl } = useZCodeIntl();
  const t = (key: string) => intl.formatMessage({ id: `backlinks.${key}` });
  const [query, setQuery] = useState("");
  const selectAllId = useId();
  const batches = filterBacklinkBatches(state.batches, query);
  const selectedVisible = batches.filter((batch) => state.selectedIds.includes(batch.id)).length;
  const allChecked = batches.length > 0 && selectedVisible === batches.length;
  const statuses = compact
    ? (["pending", "executed", "failed"] as const)
    : (["pending", "executed", "failed", "skipped", "total"] as const);
  return (
    <section
      aria-label={t("batches")}
      className={cn("min-w-0", compact ? "space-y-2" : "space-y-3")}
      data-testid="backlinks-console"
    >
      <div className="flex min-w-0 gap-1.5">
        <Input
          className={cn("min-w-0 flex-1", compact && "h-8 text-ui-sm")}
          aria-label={t("search")}
          placeholder={t("search")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button
          variant="outline"
          size={compact ? "icon-sm" : "default"}
          aria-label={t("refresh")}
          title={t("refresh")}
          disabled={state.loading}
          onClick={() => void state.refresh()}
        >
          <RefreshCw className="size-3.5" />
          {compact ? null : t("refresh")}
        </Button>
      </div>
      {onOpenSettings ? (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 max-w-full justify-start gap-1 px-1 text-ui-sm"
          onClick={onOpenSettings}
        >
          <Settings2 className="size-3.5 shrink-0" />
          {t("settings")}
        </Button>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-1.5">
        <div className="flex items-center gap-1.5 text-ui-sm">
          <Checkbox
            id={selectAllId}
            checked={allChecked ? true : selectedVisible > 0 ? "indeterminate" : false}
            disabled={!batches.length || state.publishing}
            onCheckedChange={(value) =>
              state.select(
                batches.map((batch) => batch.id),
                value === true,
              )
            }
          />
          <label htmlFor={selectAllId}>{t(compact ? "selectVisibleShort" : "selectVisible")}</label>
        </div>
        <Button
          size="sm"
          className={cn(compact && "h-7 px-2 text-ui-sm")}
          disabled={!canPublish || !state.selectedIds.length || state.publishing}
          onClick={() => void state.publishSelected()}
        >
          {state.publishing
            ? t("publishing")
            : intl.formatMessage(
                { id: "backlinks.publishSelected" },
                { count: state.selectedIds.length },
              )}
        </Button>
      </div>
      {!canPublish ? <p className="text-ui-sm text-foreground-subtle">{t("noWorkspace")}</p> : null}
      {canPublish && !compact ? (
        <p className="text-ui-sm text-foreground-subtle">{t("publishHelp")}</p>
      ) : null}
      {state.error ? (
        <p
          role="alert"
          className="whitespace-pre-wrap break-words rounded-lg border border-destructive p-2 text-ui-sm text-destructive"
        >
          {state.error}
        </p>
      ) : null}
      {state.loading && !state.batches.length ? (
        <p role="status" className="text-ui-sm text-foreground-subtle">
          {t("loading")}
        </p>
      ) : null}
      {!state.loading && !state.error && !batches.length ? (
        <p className="py-4 text-ui-sm text-foreground-subtle">{t("empty")}</p>
      ) : null}
      <div className={compact ? "space-y-1.5" : "space-y-3"}>
        {batches.map((batch) => {
          const expanded = state.expandedIds.includes(batch.id);
          const detail = state.details[batch.id];
          const stopping = state.stoppingIds.includes(batch.id);
          const actions = (
            <div className={compact ? "flex items-center justify-end gap-2 px-2 pb-2" : "contents"}>
              {batch.executing ? (
                <span className="text-ui-xs text-warning">{t("executing")}</span>
              ) : null}
              <Button
                variant={batch.executing ? "destructive" : compact ? "default" : "outline"}
                size="sm"
                className={cn(compact && "h-6 px-2 text-ui-xs")}
                disabled={!canPublish || state.publishing || stopping}
                onClick={() =>
                  void (batch.executing ? state.stop(batch.id) : state.publish([batch.id]))
                }
              >
                {stopping
                  ? t("stopping")
                  : batch.executing
                    ? t(compact ? "stopShort" : "stop")
                    : t(compact ? "publishShort" : "publish")}
              </Button>
            </div>
          );
          return (
            <article
              key={batch.id}
              data-testid={`backlinks-batch-${batch.id}`}
              className={cn(
                "min-w-0 rounded-lg border bg-surface",
                state.selectedIds.includes(batch.id) ? "border-brand bg-accent" : "border-border",
                batch.executing && "backlinks-running-card",
              )}
            >
              <div
                className={cn("flex flex-wrap items-center", compact ? "gap-1.5 p-2" : "gap-3 p-3")}
              >
                <Checkbox
                  aria-label={`${t("select")} #${batch.id} ${batch.websiteHost}`}
                  checked={state.selectedIds.includes(batch.id)}
                  disabled={state.publishing}
                  onCheckedChange={(value) => state.select([batch.id], value === true)}
                />
                <button
                  type="button"
                  title={`#${batch.id} ${batch.websiteHost} · ${batch.name}`}
                  className={cn(
                    "min-w-0 flex-1 text-left",
                    compact
                      ? "flex items-center justify-between gap-1 text-ui-sm"
                      : "space-y-1 text-ui-base",
                  )}
                  aria-expanded={expanded}
                  onClick={() => void state.toggleDetail(batch.id)}
                >
                  <span
                    className={cn("font-medium", compact ? "min-w-0 truncate" : "block break-all")}
                  >
                    #{batch.id} {batch.websiteHost}
                  </span>
                  {!compact ? (
                    <span className="block text-ui-sm text-foreground-subtle">
                      {batch.websiteName} · {batch.name}
                    </span>
                  ) : null}
                  <span
                    className={cn(
                      "flex text-ui-xs",
                      compact ? "shrink-0 gap-1" : "flex-wrap gap-3",
                    )}
                  >
                    {statuses.map((status) => (
                      <span
                        key={status}
                        title={`${t(status)} ${batch.counts[status]}`}
                        className={cn(
                          backlinkStatusClass(status),
                          compact && "whitespace-nowrap rounded-full px-1.5 py-0.5",
                          compact &&
                            (status === "executed"
                              ? "bg-success/10"
                              : status === "failed"
                                ? "bg-destructive/10"
                                : "bg-warning/10"),
                        )}
                      >
                        {t(compact ? `${status}Short` : status)} {batch.counts[status]}
                      </span>
                    ))}
                  </span>
                </button>
                {!compact ? actions : null}
              </div>
              {expanded && state.loadingDetailIds.includes(batch.id) ? (
                <p role="status" className="px-3 pb-3 text-ui-sm text-foreground-subtle">
                  {t("loading")}
                </p>
              ) : null}
              {expanded && detail ? (
                <BacklinksBatchDetails detail={detail} compact={compact} />
              ) : null}
              {compact ? actions : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}
