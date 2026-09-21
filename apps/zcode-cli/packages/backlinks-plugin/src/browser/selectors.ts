// Adapted from link-harness 2.0.0 semantic selectors (MIT, Copyright 2026 DeepSeek).
// ZCode changes: balanced iframe parsing and no implicit active-page fallback.
import type { FrameLocator, Locator, Page } from "playwright-core";
import { BacklinkBrowserError } from "./contract.js";

type Address =
  | { mode: "xy"; x: number; y: number; frames: string[] }
  | { mode: "role"; value: string; name?: string; frames: string[] }
  | { mode: "css" | "label" | "placeholder" | "text"; value: string; frames: string[] };

const fail = (): never => {
  throw new BacklinkBrowserError(
    "BROWSER_INVALID_SELECTOR",
    "Use a snapshot-proven role:, label:, placeholder:, text:, CSS or frame(selector)>> selector; xy:x,y supports click only",
  );
};

function frameEnd(value: string): number {
  let depth = 1;
  let quote = "";
  let escaped = false;
  for (let index = "frame(".length; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (depth === 0) return index;
  }
  return fail();
}

export function parseBrowserSelector(raw: string): Address {
  let rest = raw.trim();
  const frames: string[] = [];
  while (rest.startsWith("frame(")) {
    const end = frameEnd(rest);
    const value = rest.slice("frame(".length, end).trim();
    if (!value || rest.slice(end + 1, end + 3) !== ">>") return fail();
    frames.push(value);
    rest = rest.slice(end + 3).trim();
  }
  if (!rest) return fail();
  const prefix = /^(role|label|placeholder|text|xy):(.*)$/su.exec(rest);
  if (!prefix) return { mode: "css", frames, value: rest };
  const mode = prefix[1];
  const body = prefix[2];
  if (!body) return fail();
  if (mode === "xy") {
    const match = /^(\d+),(\d+)$/u.exec(body);
    if (!match || frames.length) return fail();
    const x = Number(match[1]);
    const y = Number(match[2]);
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) return fail();
    return { mode, frames, x, y };
  }
  if (mode === "role") {
    const split = body.indexOf("|");
    if (split < 0) return { mode, frames, value: body };
    if (!split || split === body.length - 1) return fail();
    return { mode, frames, value: body.slice(0, split), name: body.slice(split + 1) };
  }
  return { mode: mode as "label" | "placeholder" | "text", frames, value: body };
}

export function browserLocator(page: Page, address: Address): Locator {
  if (address.mode === "xy") return fail();
  let root: Page | FrameLocator = page;
  for (const frame of address.frames) root = root.frameLocator(frame);
  switch (address.mode) {
    case "css":
      return root.locator(address.value);
    case "label":
      return root.getByLabel(address.value);
    case "placeholder":
      return root.getByPlaceholder(address.value);
    case "text":
      return root.getByText(address.value);
    case "role":
      return root.getByRole(
        address.value as Parameters<Page["getByRole"]>[0],
        address.name === undefined ? {} : { name: address.name, exact: true },
      );
  }
}
