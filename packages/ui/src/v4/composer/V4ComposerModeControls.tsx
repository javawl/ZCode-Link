import { memo } from "react";
import {
  LINK_AGENT_PRODUCT_PROFILE,
  TID_CHAT_MODE_SELECT_TRIGGER,
  ZCODE_AGENT_PROVIDER,
  getZCodeAgentAvailableModes,
} from "@zcode/shared";
import { getModeOptionDisplayLabel, resolveModeOptionIcon } from "@/chat-input-toolbar/display.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { V4ComposerToolbarProps } from "@/v4/composer/V4ComposerToolbar.js";

/** LinkAgent 权限是产品级只读状态，不提供计划/权限切换菜单。 */
function V4ComposerModeSwitchImpl({
  provider,
}: Pick<
  V4ComposerToolbarProps,
  | "workspacePath"
  | "workspaceIdentity"
  | "provider"
  | "draftConfig"
  | "disabled"
  | "activeConfigPicker"
  | "onConfigPickerOpenChange"
  | "onSwitchMode"
>) {
  const { intl } = useZCodeIntl();
  const displayProvider = provider ?? ZCODE_AGENT_PROVIDER;
  const fixedMode = LINK_AGENT_PRODUCT_PROFILE.agentPermission.mode;
  const selected = getZCodeAgentAvailableModes().find((mode) => mode.id === fixedMode);
  if (!selected) return null;
  const Icon = resolveModeOptionIcon(selected.id);
  const label = getModeOptionDisplayLabel(intl, displayProvider, {
    value: selected.id,
    name: selected.name,
  });

  return (
    <div
      role="status"
      aria-label={label}
      title={label}
      data-testid={TID_CHAT_MODE_SELECT_TRIGGER}
      data-permission-mode={fixedMode}
      data-permission-mutable={String(LINK_AGENT_PRODUCT_PROFILE.agentPermission.mutable)}
      data-composer-collapse-priority="0"
      className="group/mode flex size-7 items-center justify-center gap-1 rounded-lg px-0 text-ui-base text-warning @xl/composer:w-auto @xl/composer:px-2 data-[composer-compact=true]:w-7 data-[composer-compact=true]:px-0"
    >
      <Icon className="size-4" />
      <span className="hidden @xl/composer:inline group-data-[composer-compact=true]/mode:hidden">
        {label}
      </span>
    </div>
  );
}

export const V4ComposerModeSwitch = memo(V4ComposerModeSwitchImpl);
