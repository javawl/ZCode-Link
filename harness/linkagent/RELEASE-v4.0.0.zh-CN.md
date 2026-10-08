# LinkAgent 4.0.0 内部更新版本交付记录

本次三个平台安装包均来自 `fca7ae12597408f157a87c811af5bb89bf811fc8`，包内构建标识为 `fca7ae12`。构建后新增的测试诊断和本文不改变客户端运行代码。

## 安装文件与更新链路

交付目录：`packages/desktop/dist/linkagent-4.0.0-internal`。

| 平台           | 首次安装                        | 后续更新载荷 |
| -------------- | ------------------------------- | ------------ |
| Mac Apple 芯片 | `LinkAgent-4.0.0-mac-arm64.dmg` | 同架构 ZIP   |
| Mac Intel      | `LinkAgent-4.0.0-mac-x64.dmg`   | 同架构 ZIP   |
| Windows x64    | `LinkAgent-4.0.0-win-x64.exe`   | NSIS EXE     |

Mac 从本版起复用现有检查、下载、取消和重启更新界面，由独立安装程序替换应用；签名或校验不符拒绝安装，新版主窗口未成功加载则恢复并启动旧版。用户数据目录不参与应用替换。Windows 沿用现有 NSIS 更新实现。

Mac ZIP 用项目自己的 Ed25519 密钥验签。本版没有 Apple Developer ID 签名或公证，首次安装仍需按 macOS 提示允许打开；安装目录须由当前用户可写，不应在 DMG 安装盘内执行更新。Windows 安装器未使用 Authenticode 签名。

3.14.0 用户必须手动安装一次本版；未签名的 3.15.0 Mac 用户也应手动安装本版。之后发布更高版本（例如 `4.0.1`），才能从本版升级；替换同名 `4.0.0` 附件不会触发版本升级。

## 验证结果

- 三个平台构建、运行时依赖完整性和产物体积审计通过；包内版本、构建提交、应用架构与 GitHub 更新源核对通过。
- 17 项单元/发布汇总/身份测试通过；真实 Electron 下载、缓存复验、错误签名拒绝和取消测试通过。
- Apple 芯片完整打包客户端测试通过：`4.0.0 → 本地测试用 4.0.1`，以及新版启动失败后恢复并启动 `4.0.0`。测试用 4.0.1 未上传 GitHub。
- Intel 包在 Apple 芯片 Mac 上通过 Rosetta 验证同样两种安装流程。成功升级用例首次在主窗口加载阶段超时、尚未进入更新；复跑通过。未在 Intel 实机测试。
- 上述完整安装测试验证用户数据目录中的哨兵文件保留；没有对真实用户任务、账号或发布数据库做迁移测试。
- 两份 DMG 映像校验通过；两份 Mac ZIP 的 Ed25519 签名、SHA-512 和大小核验通过；三个安装器和两个 ZIP 的 SHA-256 记录在 `SHA256SUMS`。
- `pnpm typecheck` 通过；`pnpm lint` 为 0 错误、66 个既有警告；架构检查 0 违规。新增 Mac updater 的严格单文件类型检查通过。
- 全仓 `pnpm fmt:check` 未通过，剩余问题仅在未修改的 `MAIL-BROWSER-DELIVERY.zh-CN.md` 与 `PUBLISH-FLOW.zh-CN.md`；本次修改文件格式检查通过。
- 额外执行的 Desktop Main 全量类型检查仍有既有错误，涉及共享源 rootDir、原有 mjs 声明及其他 Main 类型；不能把根目录 typecheck 通过解释为这项全量检查通过。
- Windows 包已生成并验证 x64 架构和更新配置；Windows 实机安装、重启更新尚未验证。

## 后续版本发布

必须备份并持续复用构建机仓库外的发布私钥：`/Users/wl/.local/share/linkagent-release/update-signing-private.pem`。该文件权限为 `0600`；不能提交、上传或重新生成替代密钥，否则已安装的 4.0.0 将拒绝后续 Mac 更新。

构建更高版本后运行交付文档中的汇总命令，使用 `LINKAGENT_UPDATE_SIGNING_KEY_FILE` 指向同一私钥。GitHub Release 必须同时包含 14 个附件：3 个安装器、2 个 Mac ZIP、5 个 blockmap、`latest.yml`、`latest-mac.yml`、`linkagent-update.json`、`SHA256SUMS`。不要上传单个安装器后直接公开不完整版本。

稳定版默认只发现正式 Release。测试预发布需要客户端开启「接受提前收到预览版更新」。本版构建与汇总命令不自动上传；发布授权和远端核验为独立步骤。

## 本地旧包清理

新包验证后已按用户要求删除以下四个旧产物目录：

- `packages/desktop/dist/linkagent-3.15.0-test`
- `packages/desktop/dist/release-builds/3.15.0`
- `packages/desktop/dist/linkagent-4.0.0-test`
- `packages/desktop/dist/release-builds/4.0.0`

保留新交付目录和 `release-builds/4.0.0-internal`，以及源码、用户配置和仓库外私钥。远端历史 Release 不随本地文件清理变化。

## GitHub 发布目标核验

只读核验时工作目录与 Git 根均为 `/Users/wl/Documents/aicoding/ZCode-Link`；remote 为 `https://github.com/javawl/ZCode-Link.git`，分支为 `main`。GitHub 账号 `javawl`（ID `4203742`），公开仓库 `javawl/ZCode-Link`（ID `1379501818`），账号有推送权限。

待发布标签/Release 为 `v4.0.0`，标签应精确指向安装包源码提交 `fca7ae12597408f157a87c811af5bb89bf811fc8`。本地还有验证文档与测试诊断提交；没有新的运行时代码。核验时远端 main 为 `04fbf4be7a4b6e2af695be806b9cc282312526fa`，远端尚无 v4.0.0 标签或 Release。

目标由 `packages/desktop/scripts/desktop-product-identity.mjs`、`packages/desktop/electron-builder.config.js`、在线更新规格及本交付记录明确指定；服务商为 GitHub，目标为该仓库的 main、版本标签和公开 Releases，更新域名为 `github.com`。这是桌面安装包发布，站点 canonical 与 SEO 部署检查不适用。

现存回退下载为 GitHub `v3.15.0`、`v3.14.0`；安装失败时另有本地事务中的当前版备份回滚。发布后修复使用更高版本号，不覆盖旧版本清单或自动降级。用户未提交的 `.zcode/` 配置不进入提交、安装包或 Release。
