# LinkAgent 4.0.1 交付记录

本次发布内容：外链发布浏览器默认显示方式从后台静默改为可见窗口（`fix: default the backlinks publishing browser to a visible window`，`e7f80f1`）。发布任务在同一窗口的标签页中执行、空闲标签回收复用，不再停靠屏幕外，也避免发布过程打开多余窗口；后台模式保留为显式可选项（选择后写入 `displayMode:"background"`，缺省可见不写字段）。规格同步更新见 [BROWSER-BACKGROUND-SPEC](./BROWSER-BACKGROUND-SPEC.zh-CN.md)。

三个平台安装包均来自 `8f0dd519da5baf0a59cd7d447fc5a758591a4cf1`（版本提交），包内构建标识为 `8f0dd519`，标签 `v4.0.1` 指向同一提交。

## 交付目录与附件

交付目录：`packages/desktop/dist/linkagent-4.0.1-internal`。GitHub Release `v4.0.1`（预发布）包含 14 个附件，与 [v4.0.0 交付记录](./RELEASE-v4.0.0.zh-CN.md) 相同的集合：

| 平台           | 首次安装                        | 后续更新载荷 |
| -------------- | ------------------------------- | ------------ |
| Mac Apple 芯片 | `LinkAgent-4.0.1-mac-arm64.dmg` | 同架构 ZIP   |
| Mac Intel      | `LinkAgent-4.0.1-mac-x64.dmg`   | 同架构 ZIP   |
| Windows x64    | `LinkAgent-4.0.1-win-x64.exe`   | NSIS EXE     |

Mac 更新复用 4.0.0 的内部安装程序与 Ed25519 验签链路（同一发布私钥 `~/.local/share/linkagent-release/update-signing-private.pem`，未重新生成）；Windows 沿用 NSIS。未做 Apple Developer ID 签名/公证或 Authenticode 签名，系统提示与 4.0.0 一致。已安装 4.0.0 的 Mac 客户端可在应用内直接升级到本版。

## 验证结果

- 三平台构建成功，`latest-mac.yml` / `latest.yml` 版本均为 4.0.1；包内 `build-meta.json` 为 `appVersion 4.0.1`、`buildCommitId 8f0dd519`，与发布标签一致。
- 两份 Mac ZIP 主二进制 Mach-O 架构核验：arm64 包为 arm64、x64 包为 x86_64。
- 汇总脚本按 builder 清单核对每个产物与 blockmap 的 SHA-512/大小后复制，并签名、回验 `linkagent-update.json`（schema 1、仓库 `javawl/ZCode-Link`、appId `dev.linkagent.app`、两架构 ZIP 载荷）；另用客户端协议模块独立验签 arm64/x64 均通过。
- `SHA256SUMS` 覆盖三个安装器与两个 Mac ZIP，本地 `shasum -c` 全部 OK。
- 更新协议与汇总单测 13 项通过（`internalMacUpdate.test.mjs`、`assembleLinkAgentRelease.test.mjs`）。
- 发布后核验：Release 为 prerelease、非草稿、14 附件全部 `uploaded`；`latest.yml`、`latest-mac.yml`、`linkagent-update.json`、`SHA256SUMS` 公开下载后 SHA-256 与本地一致；14 个附件远端大小与本地逐一相同；安装器下载链接跟随跳转返回 200；`v4.0.0`（14 附件）、`v3.15.0`（15）、`v3.14.0`(4) 历史发布未变化；远端 `main` 与 `v4.0.1` 标签均指向 `8f0dd51`。
- 本轮发布前的完整测试记录（外链浏览器改动相关 26+43+1 项测试、typecheck、lint、架构检查）见任务会话；其中 1 项需要真实 Chrome 焦点环境的插件集成测试按其环境门槛跳过。

## 本地旧包清理

发布与远端核验通过后，已按用户要求删除旧版本本地产物，仅保留 4.0.1：

- 删除 `packages/desktop/dist/linkagent-4.0.0-internal`（877M）
- 删除 `packages/desktop/dist/release-builds/4.0.0-internal`

远端历史 Release 不随本地清理变化；发布私钥仍在仓库外原位置并需持续备份。
