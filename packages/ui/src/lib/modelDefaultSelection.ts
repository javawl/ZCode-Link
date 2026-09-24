import type { ModelSelection } from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/services";

/** A settings click is an explicit new choice, so it receives the model's highest supported tier. */
export function resolveConfiguredDefaultModelSelection(
  view: ModelSelectionView,
  providerId: string,
  modelId: string,
): ModelSelection | null {
  const model = view.providers
    .find((provider) => provider.providerId === providerId)
    ?.models.find((candidate) => candidate.modelId === modelId);
  const reasoningLevel = model?.config.optionSpecs.reasoningLevel.values.at(-1);
  if (!model || !reasoningLevel) return null;
  return { providerId, modelId, options: { reasoningLevel } };
}

export function isPreferredModel(
  view: ModelSelectionView | null,
  providerId: string,
  modelId: string,
): boolean {
  return (
    view?.preferredSelection?.providerId === providerId &&
    view.preferredSelection.modelId === modelId
  );
}
