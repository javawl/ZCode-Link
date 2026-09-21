import type { OfficialPluginDefinition } from "./official-plugin-definitions.js";

export const OFFICIAL_BACKLINKS_PLUGIN_DEFINITION: OfficialPluginDefinition = {
  // 发布浏览器和第三方账号连接须由用户显式启用；安装 seed 不等于授权外链发布。
  defaultEnabled: false,
  name: "backlinks",
  version: "0.1.0",
  listing: {
    author: { name: "javawl", url: "https://github.com/javawl" },
    category: "productivity",
    displayName: "Backlink Publishing",
    displayName_i18n: { "zh-CN": "外链发布" },
    description_i18n: {
      "zh-CN": "管理外链批次、租约与发布结果，使用专用浏览器和验证邮箱执行发布。",
    },
    homepage: "https://github.com/javawl/ZCode-Link",
  },
  rootCandidates: [
    "packages/backlinks-plugin",
    "../backlinks-plugin",
    "../../backlinks-plugin",
    "../../../backlinks-plugin",
  ],
  requiredSeedPaths: [
    "commands/backlink-publish.md",
    "docs/browser.md",
    "dist/configure.js",
    "dist/mcp/server.js",
    "runtime/playwright-core/package.json",
    "runtime/playwright-core/index.mjs",
    "skills/backlink-publish/SKILL.md",
    "skills/google-session/SKILL.md",
  ],
  // Playwright 依赖已在 build 阶段复制到可分发目录，避免运行时依赖工作区 node_modules。
  runtimeTopLevelPaths: ["runtime"],
};
