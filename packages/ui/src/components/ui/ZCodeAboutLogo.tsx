import { cn } from "@/components/lib/utils.js";
import linkAgentIcon from "@/assets/brand/linkagent-icon.png";

// 保留公开组件名以兼容现有调用方，品牌资源统一使用 LinkAgent 母版。
export function ZCodeAboutLogo({ className }: { className?: string }) {
  return (
    <img
      src={linkAgentIcon}
      alt="LinkAgent"
      width={100}
      height={100}
      className={cn("shrink-0 object-contain", className)}
      draggable={false}
    />
  );
}

export function ZCodeWordmarkLogo({ className }: { className?: string }) {
  return (
    <span className={cn("shrink-0 font-semibold tracking-tight text-ui-xl", className)}>
      LinkAgent
    </span>
  );
}
