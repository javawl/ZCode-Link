import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { BacklinkBrowserError } from "./contract.js";

export async function resolveBrowserUploads(
  workspacePath: string,
  files: readonly string[],
): Promise<string[]> {
  const root = await realpath(workspacePath);
  return await Promise.all(
    files.map(async (file) => {
      let actual: string;
      try {
        actual = await realpath(resolve(root, file));
      } catch (cause) {
        throw new BacklinkBrowserError(
          "BROWSER_UPLOAD_INVALID_FILE",
          "Upload files must exist in the current workspace",
          { cause },
        );
      }
      const fromRoot = relative(root, actual);
      if (isAbsolute(fromRoot) || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
        throw new BacklinkBrowserError(
          "BROWSER_UPLOAD_OUTSIDE_WORKSPACE",
          "Upload rejected: the real file is outside the current workspace",
        );
      }
      if (!(await stat(actual)).isFile()) {
        throw new BacklinkBrowserError(
          "BROWSER_UPLOAD_INVALID_FILE",
          "Upload targets must be regular files",
        );
      }
      return actual;
    }),
  );
}
