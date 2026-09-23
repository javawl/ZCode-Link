import type { ModelSelectionView } from "@zcode/provider";
import type { ModelSelection } from "@zcode/shared";

const preserveSelection = async (selection: ModelSelection): Promise<ModelSelection | null> =>
  selection;

/** LinkAgent 始终沿用用户选择，不查询商品权益或用套餐推荐修改模型。 */
export function useStartPlanRecommendation(
  view: ModelSelectionView | null | undefined,
  surface?: "subagent",
) {
  void view;
  void surface;
  return preserveSelection;
}
