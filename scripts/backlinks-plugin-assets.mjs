// Desktop、远程预构建和 SEA 共用同一份外链插件资产合同。
// runtime 是插件 build 复制的 Playwright JS 发行包，不包含浏览器或 node_modules。
export const backlinksPluginRequiredRuntimePaths = [
  "commands/backlink-publish.md",
  "docs/browser.md",
  "dist/configure.js",
  "dist/mcp/server.js",
  "runtime/playwright-core/package.json",
  "runtime/playwright-core/index.mjs",
  "skills/backlink-publish/SKILL.md",
  "skills/google-session/SKILL.md",
];

export const backlinksPluginPackage = {
  packageName: "@zcode/backlinks-plugin",
  relativePath: "apps/zcode-cli/packages/backlinks-plugin",
  requiresRuntime: true,
  requiredRuntimePaths: backlinksPluginRequiredRuntimePaths,
  requiredSeedPaths: backlinksPluginRequiredRuntimePaths,
  runtimeBuildScript: "scripts/build.mjs",
  stagedPath: "packages/backlinks-plugin",
};
