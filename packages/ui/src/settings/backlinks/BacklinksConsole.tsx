import { useId, useState } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  filterBacklinkBatches,
  type BacklinksConsoleState,
} from "@/store/backlinksConsoleStore.js";
import { BacklinksBatchDetails, backlinkStatusClass } from "./BacklinksBatchDetails.js";

export function BacklinksConsole({
  store,
  canPublish,
}: {
  store: StoreApi<BacklinksConsoleState>;
  canPublish: boolean;
}) {
  const state = useStore(store);
  const { intl } = useZCodeIntl();
  const t = (key: string) => intl.formatMessage({ id: `backlinks.${key}` });
  const [query, setQuery] = useState("");
  const selectAllId = useId();
  const batches = filterBacklinkBatches(state.batches, query);
  const selectedVisible = batches.filter((batch) => state.selectedIds.includes(batch.id)).length;
  const allChecked = batches.length > 0 && selectedVisible === batches.length;
  return (
    <section aria-label={t("title")} className="space-y-3" data-testid="backlinks-console">
      <div className="flex flex-wrap gap-2">
        <Input
          className="min-w-0 flex-1"
          aria-label={t("search")}
          placeholder={t("search")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button
          variant="outline"
          disabled={state.loading}
          onClick={() => {
            void state.refresh();
          }}
        >
          <RefreshCw className="size-4" />
          {t("refresh")}
        </Button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-ui-sm">
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
          <label htmlFor={selectAllId}>{t("selectVisible")}</label>
        </div>
        <Button
          disabled={!canPublish || !state.selectedIds.length || state.publishing}
          onClick={() => {
            void state.publishSelected();
          }}
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
      {canPublish ? <p className="text-ui-sm text-foreground-subtle">{t("publishHelp")}</p> : null}
      {state.error ? (
        <p
          role="alert"
          className="whitespace-pre-wrap break-words rounded-xl border border-destructive p-3 text-ui-sm text-destructive"
        >
          {state.error}
        </p>
      ) : null}
      {state.loading && !state.batches.length ? (
        <p role="status" className="text-ui-sm text-foreground-subtle">
          {t("loading")}
        </p>
      ) : null}
      {!state.loading && !batches.length ? (
        <p className="py-6 text-ui-sm text-foreground-subtle">{t("empty")}</p>
      ) : null}
      <div className="space-y-3">
        {batches.map((batch) => {
          const expanded = state.expandedIds.includes(batch.id);
          const detail = state.details[batch.id];
          return (
            <article key={batch.id} className="rounded-xl border border-border bg-surface">
              <div className="flex flex-wrap items-center gap-3 p-3">
                <Checkbox
                  aria-label={`${t("select")} #${batch.id} ${batch.websiteHost}`}
                  checked={state.selectedIds.includes(batch.id)}
                  disabled={state.publishing}
                  onCheckedChange={(value) => state.select([batch.id], value === true)}
                />
                <button
                  type="button"
                  className="min-w-0 flex-1 space-y-1 text-left text-ui-base"
                  aria-expanded={expanded}
                  onClick={() => {
                    void state.toggleDetail(batch.id);
                  }}
                >
                  <span className="block break-all font-medium">
                    {expanded ? "−" : "+"} #{batch.id} {batch.websiteHost}
                  </span>
                  <span className="block text-ui-sm text-foreground-subtle">
                    {batch.websiteName} · {batch.name}
                  </span>
                  <span className="flex flex-wrap gap-3 text-ui-xs">
                    {(["pending", "executed", "failed", "skipped", "total"] as const).map(
                      (status) => (
                        <span key={status} className={backlinkStatusClass(status)}>
                          {t(status)} {batch.counts[status]}
                        </span>
                      ),
                    )}
                    {batch.executing ? (
                      <span className="text-warning">{t("executing")}</span>
                    ) : null}
                  </span>
                </button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!canPublish || state.publishing}
                  onClick={() => {
                    void state.publish([batch.id]);
                  }}
                >
                  {t("publish")}
                </Button>
              </div>
              {expanded && state.loadingDetailIds.includes(batch.id) ? (
                <p role="status" className="px-3 pb-3 text-ui-sm text-foreground-subtle">
                  {t("loading")}
                </p>
              ) : null}
              {expanded && detail ? <BacklinksBatchDetails detail={detail} /> : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}
