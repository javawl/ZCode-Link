import { createContext, useContext, type ReactNode } from "react";
import type { CodingPlanUpgradeDialogTarget } from "@/settings/codingPlanUpgradeLoginRecovery.js";
import type { CodingPlanEntryInventory } from "@/hooks/useCodingPlanEntryPlanList.js";

interface CodingPlanUpgradeDialogContextValue {
  inventory: CodingPlanEntryInventory;
  openCodingPlanUpgrade: (
    target: CodingPlanUpgradeDialogTarget,
    observation?: { signal: AbortSignal; onResult: (opened: boolean) => void },
  ) => boolean;
}

// 保留旧调用契约以兼容会话/自动化入口，但不查询商品、不挂载支付 WebView、不重放购买意图。
const disabledCommerce: CodingPlanUpgradeDialogContextValue = {
  inventory: { entryPlanList: "", status: "ready", retry: () => {} },
  openCodingPlanUpgrade: (_target, observation) => {
    if (!observation?.signal.aborted) observation?.onResult(false);
    return false;
  },
};
const CodingPlanUpgradeDialogContext = createContext(disabledCommerce);

export function CodingPlanUpgradeDialogProvider({ children }: { children: ReactNode }) {
  return (
    <CodingPlanUpgradeDialogContext.Provider value={disabledCommerce}>
      {children}
    </CodingPlanUpgradeDialogContext.Provider>
  );
}
export function useCodingPlanUpgradeDialog() {
  return useContext(CodingPlanUpgradeDialogContext);
}
export function useOptionalCodingPlanUpgradeDialog() {
  return useContext(CodingPlanUpgradeDialogContext);
}
