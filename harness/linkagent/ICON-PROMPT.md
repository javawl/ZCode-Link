# LinkAgent 图标生成记录

- 生成方式：内置 imagegen（未使用 CLI/API fallback）。
- 原始 PNG：`packages/ui/src/assets/brand/linkagent-icon.png`，1254 × 1254，RGBA，保留透明背景。
- 应用资源：`packages/desktop/build/icon.png`、`icon.icns`、`icon.ico`、`icons/`；包含安装器图标。
- 派生脚本：macOS 上执行 `node packages/desktop/scripts/generate-linkagent-icons.mjs`，使用 sips 缩放并编码 ICNS/ICO。
- 图形生成后只进行尺寸与容器格式转换，未改绘图形。

## 最终生成提示词

```text
Use case: logo-brand
Asset type: production desktop application icon, one square PNG master for macOS, Windows and Linux.
Primary request: Create a completely new, distinctive icon for an application named LinkAgent, an AI assistant for managing and publishing website links.
Subject: a single bold, elegant interlocking-link emblem with subtle forward motion; recognizable in a small desktop dock, with a simple memorable silhouette. The linked forms may subtly suggest the initials L and A without written typography.
Style/medium: polished contemporary native desktop app icon, precise smooth geometry, restrained sculptural depth and a refined material finish, visually crisp rather than busy.
Composition: one centered icon tile with rounded square corners, generous safe margins, front view. High contrast between symbol and tile, harmonious refined colors. Genuinely transparent canvas outside the rounded tile; preserve alpha. Square 1024 by 1024 pixels.
Constraints: exactly one finished icon, no presentation board, no mockup, no desktop screenshot, no words, no small text, no watermark, no existing company logos, no robot face, no decorative particles, no extra objects. Clear at 32px.
```
