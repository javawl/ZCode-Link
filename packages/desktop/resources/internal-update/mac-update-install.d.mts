import type { SignedUpdate } from "./internal-update-protocol.mjs";
export interface MacInstallPlan {
  schemaVersion: number;
  appPath: string;
  archivePath: string;
  signedUpdate: SignedUpdate;
  version: string;
  arch: string;
  currentVersion: string;
  jobPath: string;
  stagedApp: string;
  parentPid: number;
  token: string;
  startupTimeoutMs: number;
  exitTimeoutMs: number;
  launchEnvironment: Record<string, string | undefined>;
  resultPath: string;
}
export function macAppPath(execPath: string): string;
export function validateMacApp(path: string, version: string, arch: string): Promise<void>;
export function prepareMacInstall(options: {
  appPath: string;
  archivePath: string;
  signedUpdate: SignedUpdate;
  version: string;
  arch: string;
  currentVersion: string;
  userDataPath: string;
  parentPid: number;
  launchEnvironment?: Record<string, string | undefined>;
  helperSourceDir: string;
}): Promise<MacInstallPlan>;
export function acknowledgeMacStartup(options: {
  argv: string[];
  execPath: string;
  version: string;
}): Promise<void>;
