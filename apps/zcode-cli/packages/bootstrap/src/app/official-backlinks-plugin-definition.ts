import type { OfficialPluginDefinition } from "./official-plugin-definitions.js";

export const OFFICIAL_BACKLINKS_PLUGIN_DEFINITION: OfficialPluginDefinition = {
  // LinkAgent 的运行面只保留本插件；启动即加载能力，但第三方写操作仍需发布入口和双问答。
  defaultEnabled: true,
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
    "agents/backlink-publisher.md",
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
