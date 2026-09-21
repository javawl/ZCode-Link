import { cp, mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const packageRoot = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const nodeRequireBanner = `import { createRequire as __zcodeCreateRequire } from "node:module";
const require = __zcodeCreateRequire(import.meta.url);`;

export async function buildBacklinksPlugin({ root = packageRoot } = {}) {
  const playwrightRoot = dirname(require.resolve("playwright-core/package.json"));
  const runtimeRoot = join(root, "runtime", "playwright-core");
  await mkdir(runtimeRoot, { recursive: true });
  // Playwright 在运行时读取协议、注入脚本和 browsers.json，不能只打包一个 JS 入口。
  await cp(playwrightRoot, runtimeRoot, { recursive: true, dereference: true });
  const shared = {
    bundle: true,
    banner: { js: nodeRequireBanner },
    format: "esm",
    platform: "node",
    target: "node24",
    legalComments: "eof",
  };
  const serverPath = join(root, "dist", "mcp", "server.js");
  await mkdir(dirname(serverPath), { recursive: true });
  await build({
    ...shared,
    entryPoints: [join(packageRoot, "src", "server.ts")],
    outfile: serverPath,
    plugins: [
      {
        name: "backlinks-playwright-runtime",
        setup(builder) {
          builder.onResolve({ filter: /^playwright-core$/ }, () => ({
            path: "../../runtime/playwright-core/index.mjs",
            external: true,
          }));
        },
      },
    ],
  });
  await build({
    ...shared,
    entryPoints: [join(packageRoot, "src", "configure.ts")],
    outfile: join(root, "dist", "configure.js"),
  });
  const runtimePackage = JSON.parse(await readFile(join(runtimeRoot, "package.json"), "utf8"));
  return { serverPath, playwrightVersion: runtimePackage.version };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await buildBacklinksPlugin();
  console.log(
    `Built backlinks MCP with playwright-core ${result.playwrightVersion}: ${result.serverPath}`,
  );
}
