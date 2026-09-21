import { BacklinkBrowserError } from "./contract.js";

export interface BacklinkBrowserLaunchOptions {
  launchArgs?: readonly string[];
  ignoreDefaultArgs?: readonly string[];
  windowPosition?: string;
}

const MAX_LAUNCH_ARGUMENTS = 64;
const MAX_LAUNCH_ARGUMENT_LENGTH = 4_096;
const PROFILE_OVERRIDE = /^--(?:user-data-dir|profile-directory)(?:$|[=\s])/iu;

export function validateBrowserLaunchOptions(options: BacklinkBrowserLaunchOptions): void {
  for (const values of [options.launchArgs, options.ignoreDefaultArgs]) {
    if (values === undefined) continue;
    if (
      !Array.isArray(values) ||
      values.length > MAX_LAUNCH_ARGUMENTS ||
      values.some(
        (value) =>
          typeof value !== "string" ||
          !value.trim() ||
          value.length > MAX_LAUNCH_ARGUMENT_LENGTH ||
          PROFILE_OVERRIDE.test(value.trim()),
      )
    ) {
      throw new BacklinkBrowserError(
        "BROWSER_INVALID_INPUT",
        "Browser launch arguments must be bounded strings and cannot override user-data-dir or profile-directory",
      );
    }
  }
  if (
    options.windowPosition !== undefined &&
    (!/^-?\d+,-?\d+$/u.test(options.windowPosition) ||
      options.windowPosition.split(",").some((value) => !Number.isSafeInteger(Number(value))))
  ) {
    throw new BacklinkBrowserError(
      "BROWSER_INVALID_INPUT",
      "Browser windowPosition must be two safe integer coordinates, for example -32000,-32000",
    );
  }
}

export function chromiumLaunchArguments(options: BacklinkBrowserLaunchOptions): string[] {
  return [
    ...(options.launchArgs ?? []),
    ...(options.windowPosition ? [`--window-position=${options.windowPosition}`] : []),
  ];
}
