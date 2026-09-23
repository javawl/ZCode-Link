import { AppUsagePanel } from "@/settings/usage-stats/AppUsagePanel.js";
import type { CodingPlanUsageSource } from "@/settings/usage-stats/CodingPlanUsagePanel.js";

export type UsageStatsSectionTab = "app" | "codingPlan" | `codingPlan:${string}`;

// 历史套餐 tab 意图也只进入本地任务统计，不再挂载账号账单或套餐额度面板。
export function UsageStatsSection(
  props: Partial<{
    activeTab: UsageStatsSectionTab;
    providerSourcesLoading: boolean;
    workspaceIdentity?: string;
    workspacePath?: string;
    selectedCodingPlanSource?: CodingPlanUsageSource | null;
  }> = {},
) {
  void props;
  return <AppUsagePanel />;
}
