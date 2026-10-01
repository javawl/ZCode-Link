import type { Page } from "playwright-core";
import { DEFAULT_SNAPSHOT_MAX_CHARS, type BacklinkBrowserResult } from "./contract.js";
import { browserLocator, parseBrowserSelector } from "./selectors.js";

/** 读取页面或元素的 ARIA / 文本快照，按 maxChars 截断并标记。 */
export async function capturePage(
  page: Page,
  reference: string,
  timeoutMs: number,
  maxChars = DEFAULT_SNAPSHOT_MAX_CHARS,
  format: "text" | "aria" = "aria",
  selector = "body",
): Promise<BacklinkBrowserResult> {
  const locator = browserLocator(page, parseBrowserSelector(selector));
  const raw =
    format === "aria"
      ? await locator.ariaSnapshot({ timeout: timeoutMs })
      : await locator.innerText({ timeout: timeoutMs });
  return {
    kind: "page",
    page: reference,
    url: page.url(),
    title: await page.title(),
    text: raw.slice(0, maxChars),
    truncated: raw.length > maxChars,
  };
}
