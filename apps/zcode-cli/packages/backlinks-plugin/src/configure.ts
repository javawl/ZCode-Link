import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createBacklinksRuntime } from "@zcode/backlinks/node";

const MAX_INPUT_BYTES = 64 * 1024;

/** Read credentials from stdin; stdout only ever contains the redacted settings snapshot. */
export async function main(): Promise<void> {
  const runtime = createBacklinksRuntime();
  if (!process.argv.includes("--stdin")) {
    process.stdout.write(`${JSON.stringify(await runtime.getSettings(), null, 2)}\n`);
    return;
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_INPUT_BYTES) throw new Error("Backlink settings input exceeds 64 KiB.");
    chunks.push(buffer);
  }
  const patch: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const snapshot = await runtime.updateSettings(
    patch as Parameters<typeof runtime.updateSettings>[0],
  );
  process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
}

const argvPath = process.argv[1];
if (argvPath) {
  const paths = await Promise.allSettled([
    realpath(fileURLToPath(import.meta.url)),
    realpath(argvPath),
  ]);
  if (
    paths[0]?.status === "fulfilled" &&
    paths[1]?.status === "fulfilled" &&
    paths[0].value === paths[1].value
  ) {
    main().catch(() => {
      // 配置可能包含 token；解析或 I/O 异常不回显原始 JSON / 参数 / 堆栈。
      process.stderr.write(
        "Backlink settings could not be read or saved. Check the JSON fields, URLs and file permissions.\n",
      );
      process.exitCode = 1;
    });
  }
}
