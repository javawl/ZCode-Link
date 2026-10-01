import type { BrowserType } from "playwright-core";
import type {
  BacklinkBrowserCommand,
  BacklinkBrowserDisplayMode,
  BacklinkBrowserExecutionContext,
  BacklinkBrowserResult,
} from "./contract.js";
import type { BacklinkBrowserLaunchOptions } from "./launch-options.js";
import type { FocusControl } from "./presentation.js";

export interface BacklinkBrowserOptions extends BacklinkBrowserLaunchOptions {
  profilePath: string;
  workspacePath: string;
  /** 缺省时由旧 headless 推导：headless → "headless"，否则 "background"。 */
  displayMode?: BacklinkBrowserDisplayMode;
  headless?: boolean;
  channel?: string;
  executablePath?: string;
  userDataDir?: string;
  cdpEndpoint?: string;
  timeoutMs?: number;
  /** null 禁用前台归还（测试用）；缺省时 macOS 使用系统实现。 */
  focusControl?: FocusControl | null;
  now?: () => number;
  sweepIntervalMs?: number;
  /**
   * 提供时，整个浏览器空闲关闭即结束本运行时，宿主应在下次调用时按最新设置重建（传入关闭完成的 Promise，
   * 新运行时需等待其释放 profile 锁）；未提供时保持同一配置按需重新启动。
   */
  onIdleClose?: (closed: Promise<void>) => void;
  loadChromium?: () => Promise<
    Pick<BrowserType, "launchPersistentContext"> & Partial<Pick<BrowserType, "connectOverCDP">>
  >;
}

export type BacklinkItemPageOutcome = "recycle" | "hold";

export interface BacklinkBrowserRuntime {
  execute(
    command: BacklinkBrowserCommand,
    context: BacklinkBrowserExecutionContext,
  ): Promise<BacklinkBrowserResult>;
  /** 条目结果成功回写后调用：结束的条目回收页面，manual_required 的条目保留页面。 */
  releaseItemPages(itemId: number, outcome: BacklinkItemPageOutcome): Promise<void>;
  /** 没有页面（含保留页与外来标签）、没有排队动作也不在启动中，可安全关闭后按新设置重建。 */
  isIdle(): boolean;
  close(): Promise<void>;
}
