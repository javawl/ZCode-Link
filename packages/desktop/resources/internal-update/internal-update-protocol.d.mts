import type { KeyObject } from "node:crypto";
export const UPDATE_PUBLIC_KEY: string;
export const UPDATE_MANIFEST_NAME: string;
export const UPDATE_REPOSITORY: string;
export const UPDATE_APP_ID: string;
export interface SignedUpdate {
  payload: string;
  signature: string;
}
export interface MacUpdateFile {
  arch: "arm64" | "x64";
  name: string;
  sha512: string;
  size: number;
}
export function createSignedUpdate(
  input: { version: string; files: MacUpdateFile[] },
  key: string | KeyObject,
): SignedUpdate;
export function verifySignedUpdate(
  envelope: unknown,
  target: { version: string; arch: string },
  publicKey?: string | KeyObject,
): MacUpdateFile;
export function validateArchiveEntry(name: string, symlinkTarget?: string): void;
export function verifyArchiveFile(
  path: string,
  expected: Pick<MacUpdateFile, "size" | "sha512">,
): Promise<void>;
export function downloadVerifiedArchive(options: {
  url: string;
  destination: string;
  expected: MacUpdateFile;
  signal?: AbortSignal;
  fetcher?: (url: string, options: { signal?: AbortSignal }) => Promise<Response>;
  onProgress?: (progress: {
    total: number;
    transferred: number;
    delta: number;
    percent: number;
    bytesPerSecond: number;
  }) => void;
}): Promise<void>;
