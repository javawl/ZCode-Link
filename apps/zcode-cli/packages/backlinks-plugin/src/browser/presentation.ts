// 显示模式的唯一实现：后台模式下以后台标签创建页面，把窗口停靠到屏幕角落之外，并在 macOS 把前台还给原应用。
// 依据见 harness/linkagent/BROWSER-BACKGROUND-SPEC.zh-CN.md 的实测表：最小化窗口在锁屏或应用隐藏后会停止渲染，
// 因此只用“停靠”（normal 状态、最小尺寸、请求极远坐标，由 Chrome 夹取到显示器边缘仅剩一条细边）。
import { execFile } from "node:child_process";
import type { BrowserContext, CDPSession, Page } from "playwright-core";
import type { BacklinkBrowserDisplayMode } from "./contract.js";

const TARGET_ADOPT_TIMEOUT_MS = 10_000;
const FOCUS_WATCH_MS = 1_500;
const FOCUS_POLL_MS = 150;
/** Chrome 会把越界坐标夹取到最近显示器的左下角，只保留约 40×100 像素。 */
export const PARKED_BOUNDS = { left: -32_000, top: 32_000, width: 500, height: 375 } as const;
/** 人工处理时的显示位置；Chrome 同样会夹取到可见区域。 */
export const REVEALED_BOUNDS = { left: 80, top: 80, width: 1_280, height: 900 } as const;

export interface FocusControl {
  /** 返回本进程直接启动、使用该 profile 的浏览器主进程 PID。 */
  findBrowserPid(profilePath: string): Promise<number | undefined>;
  /** 前台应用正是该 PID 时把前台还给原应用，返回是否执行了归还。 */
  yieldIfFront(pid: number): Promise<boolean>;
  /** 应用处于隐藏状态时取消隐藏（不激活）；隐藏的应用无法截图，自动化会卡住。 */
  ensureUnhidden?(pid: number): Promise<void>;
}

export interface BrowserPresenter {
  afterLaunch(context: BrowserContext): Promise<void>;
  /** 每次为新页名取页前调用（包括复用空闲池）。 */
  beforeAcquire(): Promise<void>;
  /** 空闲池页面是否仍可复用：位于用户可见（显示中）或非自有窗口中的页面不能交给后台自动化。 */
  isReusable(page: Page): Promise<boolean>;
  createPage(context: BrowserContext): Promise<Page>;
  /** userDriven：打开链上有正在显示给用户的页面，弹窗由用户操作产生，保持原样。 */
  onPopup(page: Page, options: { userDriven: boolean }): Promise<void>;
  reveal(page: Page): Promise<void>;
  /** 已没有显示中的页面时调用：把本插件拥有的窗口重新停靠。 */
  conceal(context: BrowserContext): Promise<void>;
}

export interface BrowserPresenterOptions {
  mode: BacklinkBrowserDisplayMode;
  /** 通过 CDP 连接用户已有浏览器：只创建后台标签，绝不移动、隐藏或抢回前台。 */
  attached: boolean;
  profilePath?: string;
  /** null 表示禁用前台归还；缺省时 macOS 使用系统实现。 */
  focus?: FocusControl | null;
  /** 用户正在处理已显示的页面时不归还前台（用户可能正在该 Chrome 中操作）。 */
  isRevealing(): boolean;
  /** 非本插件创建的页面（用户标签、noopener 新标签）；含有这类页面的窗口归用户所有，不停靠、不复用。 */
  isForeign?(page: Page): boolean;
  warn?(message: string): void;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 3_000, windowsHide: true }, (error, stdout) =>
      error ? reject(error) : resolve(String(stdout)),
    );
  });
}

/** macOS：lsappinfo 读取前台进程；NSRunningApplication hide→unhide 让出前台且不暂停 normal 窗口的渲染。 */
export const macFocusControl: FocusControl = {
  async findBrowserPid(profilePath) {
    const children = (await run("pgrep", ["-P", String(process.pid)]).catch(() => ""))
      .split(/\s+/u)
      .map(Number)
      .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
    for (const pid of children) {
      const command = await run("ps", ["-o", "command=", "-p", String(pid)]).catch(() => "");
      if (command.includes(`--user-data-dir=${profilePath}`)) return pid;
    }
    return undefined;
  },
  async yieldIfFront(pid) {
    const asn = (await run("lsappinfo", ["front"])).trim();
    if (!asn) return false;
    const info = await run("lsappinfo", ["info", "-only", "pid", asn]);
    if (Number(/(\d+)\s*$/u.exec(info.trim())?.[1]) !== pid) return false;
    // 只 hide 会让页面截图挂起；必须随后 unhide，应用不再成为前台。
    await run("osascript", [
      "-l",
      "JavaScript",
      "-e",
      `ObjC.import('AppKit'); var app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid}); if (app) { app.hide; delay(0.2); app.unhide; } 'ok'`,
    ]);
    return true;
  },
  async ensureUnhidden(pid) {
    await run("osascript", [
      "-l",
      "JavaScript",
      "-e",
      `ObjC.import('AppKit'); var app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid}); if (app && app.hidden) app.unhide; 'ok'`,
    ]);
  },
};

async function withPageSession<T>(page: Page, action: (session: CDPSession) => Promise<T>) {
  const session = await page.context().newCDPSession(page);
  try {
    return await action(session);
  } finally {
    await session.detach().catch(() => undefined);
  }
}

/** 先恢复 normal（最小化/最大化/全屏状态下不能设置坐标），再设置位置与尺寸。 */
async function placeWindow(
  session: CDPSession,
  windowId: number,
  bounds: { left: number; top: number; width: number; height: number },
): Promise<void> {
  await session.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
  await session.send("Browser.setWindowBounds", { windowId, bounds });
}

async function placePageWindow(page: Page, bounds: typeof PARKED_BOUNDS | typeof REVEALED_BOUNDS) {
  await withPageSession(page, async (session) => {
    const { windowId } = await session.send("Browser.getWindowForTarget");
    await placeWindow(session, windowId, { ...bounds });
  });
}

async function windowIdOf(page: Page): Promise<number | undefined> {
  if (page.isClosed()) return undefined;
  return await withPageSession(page, async (session) => {
    const { windowId } = await session.send("Browser.getWindowForTarget");
    return windowId;
  }).catch(() => undefined);
}

async function targetIdOf(page: Page): Promise<string | undefined> {
  return await withPageSession(page, async (session) => {
    const { targetInfo } = await session.send("Target.getTargetInfo");
    return targetInfo.targetId;
  }).catch(() => undefined);
}

class DirectPresenter implements BrowserPresenter {
  async afterLaunch(): Promise<void> {}
  async beforeAcquire(): Promise<void> {}
  async isReusable(): Promise<boolean> {
    return true;
  }
  async createPage(context: BrowserContext): Promise<Page> {
    return await context.newPage();
  }
  async onPopup(): Promise<void> {}
  async reveal(page: Page): Promise<void> {
    await page.bringToFront();
  }
  async conceal(): Promise<void> {}
}

/**
 * 只移动本插件拥有的窗口：启动窗口、为自动化新建的窗口和自动化弹窗窗口。
 * 用户在插件 Chrome 中自行打开的窗口、以及正在显示给用户的窗口，既不停靠也不放入自动化标签。
 */
class BackgroundPresenter implements BrowserPresenter {
  readonly #options: BrowserPresenterOptions;
  readonly #focus?: FocusControl;
  readonly #ownedWindows = new Set<number>();
  readonly #revealedWindows = new Set<number>();
  /** 曾含有用户页面、已转为用户所有的窗口。 */
  readonly #userWindows = new Set<number>();
  #browserSession?: Promise<CDPSession | undefined>;
  #browserPid?: Promise<number | undefined>;

  constructor(options: BrowserPresenterOptions) {
    this.#options = options;
    this.#focus =
      options.focus === null
        ? undefined
        : (options.focus ?? (process.platform === "darwin" ? macFocusControl : undefined));
  }

  async afterLaunch(context: BrowserContext): Promise<void> {
    if (this.#options.attached) return;
    for (const page of context.pages()) {
      const windowId = await windowIdOf(page);
      if (windowId !== undefined) this.#ownedWindows.add(windowId);
    }
    await this.#parkOwned(context);
    await this.#yieldFocus();
  }

  async beforeAcquire(): Promise<void> {
    if (this.#options.attached || !this.#focus?.ensureUnhidden) return;
    const pid = await this.#pid();
    if (pid) await this.#focus.ensureUnhidden(pid).catch(() => undefined);
  }

  async isReusable(page: Page): Promise<boolean> {
    if (this.#options.attached) return true;
    await this.#disownUserWindows(page.context(), page);
    const windowId = await windowIdOf(page);
    return (
      windowId !== undefined &&
      this.#ownedWindows.has(windowId) &&
      !this.#revealedWindows.has(windowId)
    );
  }

  async createPage(context: BrowserContext): Promise<Page> {
    // Chrome 把后台标签放进最近活动的窗口。已知存在用户窗口或显示中的窗口时，
    // 直接新建自有窗口，避免先在用户的标签栏里闪出一个再移走的标签。
    await this.#disownUserWindows(context);
    const separateFirst = this.#userWindows.size > 0 || this.#revealedWindows.size > 0;
    const created = await this.#createBackgroundTarget(context, separateFirst).catch(
      (cause: unknown) => {
        this.#warn("background tab creation failed; falling back to a normal page", cause);
        return undefined;
      },
    );
    let page = created ?? (await context.newPage());
    if (this.#options.attached) return page;
    let windowId = await windowIdOf(page);
    // 直接以 newWindow 创建的窗口属于本插件。
    if (created && separateFirst && windowId !== undefined) this.#ownedWindows.add(windowId);
    await this.#disownUserWindows(context, page);
    const parkable = (id: number | undefined) =>
      id !== undefined && this.#ownedWindows.has(id) && !this.#revealedWindows.has(id);
    // Chrome 把后台标签放进最近活动的窗口；若那是用户自己的窗口或正在显示的人工页面窗口，
    // 改为新建一个自有窗口，绝不移动或打扰用户正在看的窗口。
    if (!parkable(windowId)) {
      const separate = await this.#createBackgroundTarget(context, true).catch((cause: unknown) => {
        this.#warn("creating a separate publishing window failed", cause);
        return undefined;
      });
      if (separate) {
        await page.close({ runBeforeUnload: false }).catch(() => undefined);
        page = separate;
        await this.#disownUserWindows(context, page);
        windowId = await windowIdOf(page);
        if (windowId !== undefined) this.#ownedWindows.add(windowId);
      }
    }
    if (parkable(windowId))
      // 后台标签不会抢前台，但 Chrome 会把所在窗口恢复为默认尺寸；立即重新停靠。
      await placePageWindow(page, PARKED_BOUNDS).catch((cause: unknown) =>
        this.#warn("parking the publishing window failed", cause),
      );
    // 只有回退到普通新页面时才可能抢占前台。
    if (!created) void this.#yieldFocus();
    return page;
  }

  async onPopup(page: Page, options: { userDriven: boolean }): Promise<void> {
    if (this.#options.attached || options.userDriven) return;
    const windowId = await windowIdOf(page);
    if (windowId !== undefined && this.#revealedWindows.has(windowId)) return;
    if (windowId !== undefined) this.#ownedWindows.add(windowId);
    await placePageWindow(page, PARKED_BOUNDS).catch((cause: unknown) =>
      this.#warn("parking a site popup failed", cause),
    );
    await this.#yieldFocus();
  }

  async reveal(page: Page): Promise<void> {
    if (!this.#options.attached) {
      const windowId = await windowIdOf(page);
      if (windowId !== undefined) this.#revealedWindows.add(windowId);
      await placePageWindow(page, REVEALED_BOUNDS).catch((cause: unknown) =>
        this.#warn("showing the publishing window failed", cause),
      );
    }
    await page.bringToFront();
  }

  async conceal(context: BrowserContext): Promise<void> {
    if (this.#options.attached) return;
    this.#revealedWindows.clear();
    await this.#parkOwned(context);
  }

  async #createBackgroundTarget(context: BrowserContext, newWindow: boolean) {
    this.#browserSession ??= (async () =>
      (await context.browser()?.newBrowserCDPSession()) ?? undefined)();
    const session = await this.#browserSession;
    if (!session) return undefined;
    const known = new Set(context.pages());
    const { targetId } = await session.send("Target.createTarget", {
      url: "about:blank",
      background: true,
      ...(newWindow ? { newWindow: true } : {}),
    });
    const deadline = Date.now() + TARGET_ADOPT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      for (const page of context.pages())
        if (!known.has(page) && !page.isClosed() && (await targetIdOf(page)) === targetId)
          return page;
      await sleep(25);
    }
    await session.send("Target.closeTarget", { targetId }).catch(() => undefined);
    throw new Error("The background tab was not adopted in time");
  }

  /** 窗口中出现用户自己的页面后，该窗口转为用户所有：之后既不停靠也不放入自动化页面。 */
  async #disownUserWindows(context: BrowserContext, exclude?: Page): Promise<void> {
    const isForeign = this.#options.isForeign;
    if (!isForeign) return;
    for (const page of context.pages()) {
      if (page === exclude || page.isClosed() || !isForeign(page)) continue;
      const windowId = await windowIdOf(page);
      if (windowId === undefined) continue;
      this.#ownedWindows.delete(windowId);
      this.#userWindows.add(windowId);
    }
  }

  async #parkOwned(context: BrowserContext): Promise<void> {
    await this.#disownUserWindows(context);
    const parked = new Set<number>();
    for (const page of context.pages()) {
      if (page.isClosed()) continue;
      await withPageSession(page, async (session) => {
        const { windowId } = await session.send("Browser.getWindowForTarget");
        if (parked.has(windowId) || !this.#ownedWindows.has(windowId)) return;
        if (this.#revealedWindows.has(windowId)) return;
        parked.add(windowId);
        await placeWindow(session, windowId, { ...PARKED_BOUNDS });
      }).catch((cause: unknown) => this.#warn("parking the publishing window failed", cause));
    }
  }

  async #pid(): Promise<number | undefined> {
    const focus = this.#focus;
    const profilePath = this.#options.profilePath;
    if (!focus || !profilePath) return undefined;
    this.#browserPid ??= focus.findBrowserPid(profilePath).catch(() => undefined);
    return await this.#browserPid;
  }

  /** 浏览器可能在启动或弹窗后稍晚才成为前台，在短时间窗口内观察并归还。 */
  async #yieldFocus(): Promise<void> {
    const focus = this.#focus;
    if (!focus || this.#options.attached) return;
    const pid = await this.#pid();
    if (!pid) return;
    const deadline = Date.now() + FOCUS_WATCH_MS;
    let yielded = 0;
    let attempted = false;
    while (Date.now() < deadline && yielded < 2) {
      if (this.#options.isRevealing()) break;
      const result = await focus.yieldIfFront(pid).catch(() => undefined);
      if (result !== false) attempted = true;
      if (result) yielded += 1;
      await sleep(FOCUS_POLL_MS);
    }
    // hide 与 unhide 之间若被超时打断，应用会停在隐藏状态；此处兜底恢复。
    if (attempted) await focus.ensureUnhidden?.(pid).catch(() => undefined);
  }

  #warn(message: string, cause: unknown): void {
    const detail = cause instanceof Error ? cause.message.split("\n")[0] : "";
    this.#options.warn?.(`${message}${detail ? `: ${detail}` : ""}`);
  }
}

export function createBrowserPresenter(options: BrowserPresenterOptions): BrowserPresenter {
  // 无窗口与可见模式保持原有行为；CDP 连接在后台模式下仍以后台标签创建页面。
  return options.mode === "background" ? new BackgroundPresenter(options) : new DirectPresenter();
}
