import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MAX_RESULT_CHARACTERS = 60_000;
const PREVIEW_CHARACTERS = 12_000;

export interface BacklinksMcpResult {
  content: Array<
    { type: "text"; text: string } | { type: "image"; mimeType: string; data: string }
  >;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** Large results have a complete, private local artifact and an explicit bounded preview. */
export async function toBacklinksMcpResult(
  value: Record<string, unknown>,
  artifactDirectory: string,
): Promise<BacklinksMcpResult> {
  const text = JSON.stringify(value, null, 2);
  if (text.length <= MAX_RESULT_CHARACTERS) {
    return { content: [{ type: "text", text }], structuredContent: value };
  }
  await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
  const artifactPath = join(artifactDirectory, `${randomUUID()}.json`);
  await writeFile(artifactPath, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
  const structuredContent = {
    summary: typeof value.summary === "string" ? value.summary : "Large backlink result",
    artifactPath,
    truncated: true,
    totalCharacters: text.length,
    preview: text.slice(0, PREVIEW_CHARACTERS),
  };
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
  };
}

export function toBacklinksMcpError(error: unknown): BacklinksMcpResult {
  const value = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const code = typeof value.code === "string" ? value.code : "BACKLINKS_ERROR";
  const message = error instanceof Error ? error.message : "Backlink operation failed.";
  const details = {
    code,
    message,
    ...(typeof value.retryAfterSeconds === "number"
      ? { retryAfterSeconds: value.retryAfterSeconds }
      : {}),
    ...(value.sideEffect === "uncertain" ? { sideEffect: "uncertain" } : {}),
  };
  return {
    content: [{ type: "text", text: JSON.stringify(details) }],
    structuredContent: details,
    isError: true,
  };
}
