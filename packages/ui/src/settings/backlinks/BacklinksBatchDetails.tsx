import type { BacklinkBatchDetail } from "@zcode/services";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

function publicUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function DetailLink({ value, children }: { value: string | null | undefined; children: string }) {
  const href = publicUrl(value);
  return href ? (
    <a
      className="break-all text-icon-blue hover:underline"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </a>
  ) : (
    <span className="break-all">{children}</span>
  );
}

export function backlinkStatusClass(status: string): string {
  if (status === "executed" || status === "live" || status === "submitted") return "text-success";
  if (status === "failed") return "text-destructive";
  if (status === "pending") return "text-warning";
  return "text-foreground-subtle";
}

export function BacklinksBatchDetails({
  detail,
  compact = false,
}: {
  detail: BacklinkBatchDetail;
  compact?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const t = (key: string) => intl.formatMessage({ id: `backlinks.${key}` });
  // 窄侧栏沿用源 harness 的域名/状态行，避免资料与结果三列表格挤压站点名称。
  if (compact) {
    return (
      <ul
        className="min-w-0 border-t border-border px-2 py-1 text-ui-sm"
        aria-label={t("source")}
        data-testid="backlinks-compact-details"
      >
        {detail.items.map((item) => {
          const host = item.sourceHost || item.sourceName;
          const statusClass =
            item.status === "executed"
              ? "text-success"
              : item.status === "failed"
                ? "text-destructive"
                : "text-foreground-subtle";
          return (
            <li
              key={item.id}
              className="flex min-w-0 items-center justify-between gap-2 leading-4"
              data-testid="backlinks-detail-row"
            >
              <span
                className="min-w-0 truncate text-foreground-subtle"
                title={host}
                data-testid="backlinks-detail-host"
              >
                {host}
              </span>
              <span
                className={`shrink-0 whitespace-nowrap text-right ${statusClass}`}
                title={item.failureReason || item.status}
                data-testid="backlinks-detail-status"
              >
                {item.status}
              </span>
            </li>
          );
        })}
      </ul>
    );
  }
  return (
    <div className="space-y-3 border-t border-border p-3 text-ui-sm">
      <div className="space-y-1">
        <DetailLink value={detail.website.siteUrl}>
          {detail.website.name || detail.website.siteHost}
        </DetailLink>
        {detail.website.shortDescription ? (
          <p className="text-foreground-subtle">{detail.website.shortDescription}</p>
        ) : null}
        {detail.anchors.length ? (
          <p>
            <span className="text-foreground-subtle">{t("anchors")}: </span>
            {detail.anchors.map((anchor, index) => (
              <span key={anchor.id}>
                {index ? " · " : ""}
                <DetailLink value={anchor.targetUrl}>{anchor.anchorText}</DetailLink>
              </span>
            ))}
          </p>
        ) : null}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-ui-sm">
          <thead className="text-foreground-subtle">
            <tr>
              <th className="py-2 pr-3 font-medium">{t("source")}</th>
              <th className="py-2 pr-3 font-medium">{t("status")}</th>
              <th className="py-2 font-medium">{t("result")}</th>
            </tr>
          </thead>
          <tbody>
            {detail.items.map((item) => (
              <tr key={item.id} className="border-t border-border align-top">
                <td className="py-2 pr-3">
                  <DetailLink value={item.submitUrl || item.sourceUrl}>
                    {item.sourceHost || item.sourceName}
                  </DetailLink>
                  <p className="text-foreground-subtlest">
                    {[item.category, ...item.tags].filter(Boolean).join(" · ")}
                  </p>
                </td>
                <td className={`py-2 pr-3 ${backlinkStatusClass(item.status)}`}>
                  {item.status}
                  {item.publishStatus ? <p>{item.publishStatus}</p> : null}
                </td>
                <td className="py-2">
                  <DetailLink value={item.publishedUrl}>
                    {item.publishedUrl || item.failureReason || "—"}
                  </DetailLink>
                  {item.failureMode ? (
                    <p className="text-foreground-subtle">{item.failureMode}</p>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
