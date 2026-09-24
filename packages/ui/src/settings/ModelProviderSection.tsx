import { useCallback, useEffect, useMemo, useState } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useModelProviders } from "@/hooks/useModelProviders.js";
import { getProviderFormLabel } from "@/lib/providerSettingsFormTypes.js";
import { sortModelProvidersForDisplay } from "@/lib/modelProviderOrdering.js";
import { isLinkAgentApiProvider, isLinkAgentApiTemplate } from "@/lib/linkagentModelSettings.js";
import { Button } from "@/components/ui/button.js";
import {
  addPendingSettingsSectionListener,
  consumePendingSettingsModelProviderTarget,
  type SettingsModelProviderTarget,
} from "@/lib/settingsNavigation.js";
import { ModelProviderSectionLayout } from "./model-provider-section/SectionLayout.js";
import { ProviderTemplatePicker } from "./model-provider-section/ProviderTemplatePicker.js";
import { InlineEditableProviderCard } from "./model-provider-section/InlineEditableProviderCard.js";
import { confirmAndDeleteModelProvider } from "./model-provider-section/modelProviderActions.js";
import { createCustomProviderNodeKey } from "./model-provider-section/utils.js";
import type { ModelProviderNavGroup } from "./model-provider-section/constants.js";

export {
  fuzzyMatch,
  handleEndpointSuggestionPopoverOpenAutoFocus,
  resolveEndpointSuggestionOpenRequest,
} from "./model-provider-section/utils.js";

/** LinkAgent 的模型设置只编辑 Personal API 配置，不挂载套餐、权益或购买 UI。 */
export function ModelProviderSection({
  workspacePath = "",
  connectivityWorkspacePath,
  connectivityWorkspaceRequired = false,
  pendingModelProviderTarget,
  onConsumePendingModelProviderTarget,
}: {
  workspacePath?: string;
  connectivityWorkspacePath?: string;
  connectivityWorkspaceRequired?: boolean;
  pendingModelProviderTarget?: SettingsModelProviderTarget;
  onConsumePendingModelProviderTarget?: () => void;
} = {}) {
  const { intl } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const models = useModelProviders({
    workspacePath,
    connectivityWorkspacePath,
    connectivityWorkspaceRequired,
    connectivityUnavailableMessage: intl.formatMessage({
      id: "settings.modelProvider.testModel.localWorkspaceUnavailable",
    }),
  });
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(
    () => consumePendingSettingsModelProviderTarget()?.providerId ?? null,
  );
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const providers = useMemo(
    () =>
      sortModelProvidersForDisplay(
        models.modelProviders.filter(isLinkAgentApiProvider),
        models.displayOrder,
      ),
    [models.modelProviders, models.displayOrder],
  );
  // 已删除或历史套餐导航目标不会创建第二份配置，也不能重新打开购买卡片。
  const selected =
    providers.find((provider) => provider.providerId === selectedProviderId) ??
    providers[0] ??
    null;
  const navigationGroups = useMemo<ModelProviderNavGroup[]>(
    () => [
      {
        id: "custom",
        title: intl.formatMessage({ id: "settings.modelProvider.customTitle" }),
        items: providers.map((provider) => ({
          key: createCustomProviderNodeKey(provider.providerId),
          type: "custom",
          label: getProviderFormLabel(provider),
          provider,
          statusActive: provider.executable,
        })),
      },
    ],
    [providers, intl],
  );

  useEffect(() => {
    if (!pendingModelProviderTarget) return;
    setSelectedProviderId(pendingModelProviderTarget.providerId);
    setTemplatePickerOpen(false);
    onConsumePendingModelProviderTarget?.();
  }, [pendingModelProviderTarget, onConsumePendingModelProviderTarget]);
  useEffect(
    () =>
      addPendingSettingsSectionListener((section, detail) => {
        if (section !== "modelProvider") return;
        if (detail?.modelProviderId) setSelectedProviderId(detail.modelProviderId);
        setTemplatePickerOpen(false);
      }),
    [],
  );

  const createProvider = useCallback(
    async (input: Parameters<typeof models.createPersonalProvider>[0]) => {
      setCreating(true);
      try {
        const result = await models.createPersonalProvider(input);
        setSelectedProviderId(result.providerId);
        setTemplatePickerOpen(false);
      } finally {
        setCreating(false);
      }
    },
    [models.createPersonalProvider],
  );

  return (
    <ModelProviderSectionLayout
      description={intl.formatMessage({ id: "settings.modelProviderDescription" })}
      refreshLabel={intl.formatMessage({ id: "settings.modelProvider.refresh" })}
      loadingLabel={intl.formatMessage({ id: "common.loading" })}
      presetLoading={false}
      customLoading={models.loading || models.refreshing}
      onRefresh={() => void models.refresh()}
      addProviderLabel={intl.formatMessage({ id: "settings.modelProvider.addProviderAction" })}
      onAddProvider={() => setTemplatePickerOpen(true)}
      navigationGroups={navigationGroups}
      selectedNodeKey={selected ? createCustomProviderNodeKey(selected.providerId) : null}
      onSelectNavItem={(item) => {
        if (item.type !== "custom") return;
        setSelectedProviderId(item.provider.providerId);
        setTemplatePickerOpen(false);
      }}
      onReorderProviderIds={(providerIds) => models.saveDisplayOrder({ providerIds })}
      reorderableProviderIds={models.reorderableProviderIds}
    >
      {models.loadError ? (
        <div role="alert" className="space-y-3 text-ui-base text-destructive">
          <p>{models.loadError.message}</p>
          <Button onClick={models.reload}>{intl.formatMessage({ id: "common.retry" })}</Button>
        </div>
      ) : models.loading ? (
        <p className="text-ui-base">{intl.formatMessage({ id: "common.loading" })}</p>
      ) : templatePickerOpen || !selected ? (
        <ProviderTemplatePicker
          templates={models.providerTemplates.filter(isLinkAgentApiTemplate)}
          creating={creating}
          onBack={() => setTemplatePickerOpen(false)}
          onCreateFromTemplate={(templateId) => createProvider({ templateId })}
          onCreateCustom={(providerName) => createProvider({ providerName })}
        />
      ) : (
        <InlineEditableProviderCard
          key={selected.providerId}
          provider={selected}
          settingsRevision={models.providerSettingsView?.revision}
          onSave={async (provider) => {
            await models.saveProvider(provider);
          }}
          onAddPersonalModel={models.addPersonalModel}
          onSavePersonalModelDraft={models.savePersonalModelDraft}
          onSetPersonalModelEnabled={models.setPersonalModelEnabled}
          onDeletePersonalModel={models.deletePersonalModel}
          onDelete={() =>
            confirmAndDeleteModelProvider({
              provider: selected,
              intl,
              confirmDialog,
              deleteProvider: models.deleteProvider,
            })
          }
          onReorderModelIds={(ids) => models.reorderProviderModels(selected.providerId, ids)}
          defaultModelId={
            models.defaultModelSelection?.providerId === selected.providerId
              ? models.defaultModelSelection.modelId
              : undefined
          }
          onSetDefaultModel={async (modelId) => {
            await models.setDefaultModel(selected.providerId, modelId);
          }}
          onTestModel={models.testModelConnectivity}
          readOnlyEndpoints={false}
          nameEditable
        />
      )}
    </ModelProviderSectionLayout>
  );
}
