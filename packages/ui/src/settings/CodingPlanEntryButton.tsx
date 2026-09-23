import type { ComponentProps } from "react";
import type { Button } from "@/components/ui/button.js";

// 商业化入口已退役；独立组件或存量调用方也不能重新显示购买按钮。
export function useCodingPlanEntryGate(): {
  status: "loading" | "error" | "ready";
  label?: string;
  retry?: () => void;
} {
  return { status: "ready" as const, label: undefined, retry: undefined };
}
export function CodingPlanEntryButton(
  props: ComponentProps<typeof Button> & { bypassGate?: boolean },
) {
  void props;
  return null;
}
