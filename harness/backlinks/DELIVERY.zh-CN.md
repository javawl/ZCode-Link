# ZCode-Link 外链功能迁移交付文档

交付日期：2026-09-21。

## 1. 交付结论与版本

已将 `link-harness` **指定版本 2.0.0** 中的外链发布业务、验证邮箱、专用浏览器、发布控制台、配置及全部相关技能迁入 ZCode-Link。实现使用 ZCode 原有的插件、MCP、Service/RPC、任务提交与界面体系。源项目保持原样。

| 项目            | 固定版本或位置                                                                         |
| --------------- | -------------------------------------------------------------------------------------- |
| 来源            | [javawl/link-harness 2.0.0](https://github.com/javawl/link-harness/releases/tag/2.0.0) |
| 来源 commit     | `3f2de21104493f4c00214a0c1dfc0836b63b6e14`，已通过 Git tag ref 核对其对象类型为 commit |
| 目标            | [javawl/ZCode-Link](https://github.com/javawl/ZCode-Link)                              |
| 迁移前 main     | `872ad960de7ec172591f7e1952f7849229f94521`                                             |
| 功能迁移 commit | `0962ec9926f5bc56aa8022b73e52913e5ee8ea41`                                             |
| 交付分支        | `main`；本文随交付文档提交一起保存                                                     |
| 迁移设计        | [SPEC.md](SPEC.md)                                                                     |

**验收结果：相关自动化测试共 71 项，69 项通过、0 项失败、2 项因缺少 Chromium 明确跳过。** 根项目及 CLI 类型检查通过，根项目 lint 与架构检查通过。全量 CLI lint 存在原有超长文件错误，详见第 7 节。当前环境未执行真实网站外链发布、真实账号登录或生产 API 写入。

本次交付更新的是仓库源码与构建接线。桌面安装包、CLI 二进制、CDN 资源及新的 GitHub Release 需要按仓库现有发行流程重新构建和发布；本次没有发布新安装包。

## 2. 功能迁移对照

| 源能力                     | ZCode-Link 中的交付                       | 关键行为                                                                             |
| -------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------ |
| 批次查询、详情、网站资料包 | `packages/backlinks` 与原生批次界面       | 保留来源、锚文本、提交 URL、来源说明、分类标签、支付类型、已发布 URL/状态等源字段    |
| 批次认领与租约             | 共享 runtime + `backlinks` MCP            | 保留 claim/heartbeat/release，认领前排除已发布来源与同来源重复条目                   |
| 条目结果回写               | `item_result`                             | 保留 `live`、`submitted`、`failed`、`skipped` 结果及证据，适配后台 `evidenceZh` 字段 |
| 互链徽标、来源标签         | `badge_add`、`source_tags`                | 保留原后台路由与请求字段                                                             |
| 验证邮箱创建、邮件等待     | Cloud Mail adapter                        | 保留原始令牌认证、邮件筛选、验证码/链接提取、取消及有界轮询                          |
| 发布专用浏览器             | `backlinks_browser`                       | 保留全部 11 个原页面动作，另增加 `tabs`、`status`、`close`                           |
| 持久登录与人工接管         | 工作区独立 profile、`google-session` 技能 | 默认可见 Chrome；支持 OAuth 弹窗识别、人工完成密码和二次验证                         |
| 外链控制台                 | 侧栏和设置中的“外链发布”                  | 数字降序、搜索、状态计数、按需详情、多选、全选筛选结果、30 秒刷新                    |
| 批量启动发布               | 原生任务创建与输入提交                    | 先启用当前工作区插件，再新建任务并提交精确的批次命令；失败保留选择                   |
| 配置面板                   | “连接与浏览器”                            | 服务地址、只写令牌、邮箱域名、浏览器路径/通道/无窗口开关                             |
| 发布技能与参考资料         | 插件 `skills/`                            | 源版本 12 个技能文件全部迁入：2 项技能、4 篇通用参考、6 类站点 playbook              |
| 原生斜杠命令               | `commands/backlink-publish.md`            | TUI 与 Web/Desktop 均支持 `/backlink-publish`，展开时加载真实发布技能                |
| 官方插件发行               | Desktop、CLI/SEA、远程及开发资源流程      | 验证服务器、配置入口、命令、技能、浏览器文档及完整 Playwright JS runtime             |

### 2.1 十个业务动作

| 动作              | 用途                          |
| ----------------- | ----------------------------- |
| `batch_list`      | 获取批次列表                  |
| `batch_get`       | 获取批次详情及资料包          |
| `batch_claim`     | 认领指定批次中的可执行条目    |
| `lease_heartbeat` | 保活服务端租约                |
| `lease_release`   | 释放租约                      |
| `item_result`     | 回写条目状态、公开 URL 与证据 |
| `badge_add`       | 登记互链徽标                  |
| `source_tags`     | 更新来源标签                  |
| `mailbox_create`  | 创建验证邮箱                  |
| `mail_wait`       | 等待并筛选验证邮件            |

业务工具由共享的运行时 schema 校验。Supermanager 保留 `/api/agent/*` 路由及 Bearer 认证；Cloud Mail 保留 `/public/addUser`、`/public/emailList` 和原始令牌认证。单次 HTTP 默认上限为 15 秒，不自动重试写请求；邮件等待默认 120 秒、每 5 秒轮询，最大 300 秒，支持取消。

### 2.2 浏览器与技能

原页面动作完整保留：`navigate`、`snapshot`、`click`、`fill`、`select`、`press`、`upload`、`screenshot`、`waitFor`、`bringToFront`、`closePage`。每个页面动作都需要明确的 `page`，同页操作串行，独立页面可以并行。

选择器支持角色、标签、占位文字、文本、CSS、iframe 和坐标点击；支持 ARIA/文本快照、截图、表单清空与工作区内文件上传。OAuth 弹窗通过 `tabs` 获取真实 page 和 opener，避免操作错误页面。取消已开始的变更动作时，会返回结果可能未知的信息，并保持原动作在该页面队列中的占有关系直到它结束。

完整技能目录为：

- `skills/backlink-publish/SKILL.md`：批次发布主流程。
- `skills/google-session/SKILL.md`：Google 会话与人工登录。
- `references/status-model.md`、`evidence.md`、`safety.md`、`google-session.md`：状态、证据、发布规则与登录参考。
- `references/playbooks/`：目录站、博客、论坛、文章站、游戏站、工具站，共 6 类 playbook。

上述 `references/` 均位于 `skills/backlink-publish/` 下。另有 [浏览器调用说明](../../apps/zcode-cli/packages/backlinks-plugin/docs/browser.md)。源技能文件的相对路径集合已按 12/12 核对；15 段 JSON 示例可解析，12 段实际工具调用示例通过当前 schema 校验。

## 3. 上手使用

### 3.1 更新和构建

在目标仓库目录执行，保留当前本地工作后再更新：

```bash
git switch main
git pull --ff-only origin main
pnpm install --frozen-lockfile
pnpm --filter @zcode/backlinks-plugin build
```

项目指定 **Node.js 24.14.0、pnpm 10.33.2**。首次准备整个应用请按根 [README](../../README.md) 执行 `pnpm bootstrap`；远程开发使用 `pnpm bootstrap:with-remote`。常用启动命令如下：

```bash
pnpm dev:desktop
pnpm dev:web
pnpm --filter @zcode/cli dev
```

上面三个命令分别启动桌面、Web、CLI，选择需要的入口即可。插件构建会复制完整 `playwright-core` JavaScript 发行目录，**不会下载或打包 Chrome/Chromium 浏览器二进制**。运行浏览器的宿主需要安装 Chrome，或在设置中指定兼容浏览器的可执行文件路径。

### 3.2 Desktop / Web 发布流程

1. 打开侧栏“外链发布”，或进入“设置 → 外链发布”。
2. 在“连接与浏览器”填写自己的 Supermanager 地址和令牌、Cloud Mail 地址和令牌、验证邮箱域名，保存。
3. 如需人工完成登录，保持浏览器无窗口开关关闭；默认使用宿主已安装的 Chrome。
4. 返回“发布批次”，刷新并选择需要发布的批次。
5. 点击“批量发布”。界面先为当前工作区启用 Backlinks 插件，再创建新任务、提交批次命令并打开任务。
6. 在任务中观察认领、浏览器操作、验证及回写结果；遇到登录、二次验证或未知提交结果时，按任务提示接管。

插件 ID 是 `backlinks@zcode-plugins-official`，新安装时默认关闭。点击批量发布会明确启用当前工作区插件；其他入口可通过已有插件管理界面启用。启用、创建任务或提交输入失败时，界面显示错误并保留选中批次。

例如选中批次 389 和 99，输入为：

```text
/backlink-publish 389 99
请按以上批次号顺序依次发布，仅处理这些批次。
```

批次号去重后按数字降序排列。命令只处理用户指定范围，不会把空的显式认领集合当作全部条目。

### 3.3 CLI 入口

使用已更新的 ZCode CLI，在需要运行的工作区执行：

```bash
zcode plugins list
zcode plugins enable backlinks
zcode
```

进入 TUI 后输入 `/backlink-publish 389 99`。源码开发入口可用 `pnpm --filter @zcode/cli dev`。请确认终端实际使用的是本次更新后构建的版本；从源码更新仓库不会自动替换系统中旧的全局 `zcode` 安装。

模型侧可发现三个 MCP 工具：`backlinks`、`backlinks_browser`、`backlinks_status`。最终工具名的命名空间由现有 ZCode MCP adapter 生成，技能按实际发现的名称调用。`backlinks_status` 只返回脱敏设置和是否配置令牌，不启动浏览器。

## 4. 配置与数据位置

### 4.1 唯一配置文件

持久配置位于：

```text
<dataBaseDir>/.zcode/v2/backlinks.json
```

`dataBaseDir` 由当前 Host 注入，使用已有 `ZCODE_DATA_BASE_DIR` 规则，未指定时回退用户目录。UI 原生服务与 MCP 共享同一份配置，通过配置适配器写入；没有在 UI、插件商店或 session 中另存第二份令牌。

配置按字段合并，写入使用跨进程锁与原子替换，文件权限请求为 `0600`。Windows 最终访问权限仍取决于宿主文件系统 ACL。服务地址和令牌每次操作重新读取；浏览器启动参数在正常 `close` 后下次使用时生效。

令牌只写不读：界面、RPC、配置脚本 stdout、`backlinks_status` 只显示 `tokenConfigured`。空白令牌编辑保留旧值；明确选择清除时会保存空值，并阻止旧环境变量重新提供该令牌。

### 4.2 无界面环境配置

优先使用界面配置；无界面环境可调用构建后的 stdin 配置脚本。以下是**输入补丁格式**，示例地址和令牌均为占位值，实际配置文件请保存在仓库之外：

```json
{
  "supermanager": {
    "baseUrl": "https://manager.example.com",
    "token": "REPLACE_WITH_YOUR_TOKEN"
  },
  "cloudMail": {
    "baseUrl": "https://mail-api.example.com",
    "token": "REPLACE_WITH_YOUR_TOKEN"
  },
  "mailboxDomain": "mail.example.com",
  "browser": {
    "headless": false,
    "channel": "chrome",
    "executablePath": ""
  }
}
```

macOS / Linux：

```bash
node apps/zcode-cli/packages/backlinks-plugin/dist/configure.js --stdin < /secure/path/backlinks-settings.json
```

PowerShell：

```powershell
Get-Content -Raw C:\secure\backlinks-settings.json | node apps/zcode-cli/packages/backlinks-plugin/dist/configure.js --stdin
```

只查看脱敏设置：

```bash
node apps/zcode-cli/packages/backlinks-plugin/dist/configure.js
```

stdin 最多接收 64 KiB JSON，校验失败不会覆盖旧配置。该脚本不接受把令牌放进命令行参数的配置方式。运行脚本与应用时应使用同一个数据基目录。

支持通过 JSON 配置的高级浏览器字段还包括 `launchArgs`、`ignoreDefaultArgs`、`windowPosition`。界面只编辑常用三个字段，并保留已有高级设置。默认高级参数为空，禁止通过参数覆盖专用 profile 目录；兼容这些字段不代表自动通过网站验证或 OAuth 限制。

### 4.3 环境变量兼容

优先级为：**持久化字段 → 新 ZCode 环境变量 → 源版本兼容变量**。

| 配置               | ZCode 环境变量                          | 源兼容变量                   |
| ------------------ | --------------------------------------- | ---------------------------- |
| Supermanager 地址  | `ZCODE_BACKLINKS_SUPERMANAGER_BASE_URL` | `SUPERMANAGER_BASE_URL`      |
| Supermanager 令牌  | `ZCODE_BACKLINKS_SUPERMANAGER_TOKEN`    | `SUPERMANAGER_TOKEN`         |
| Cloud Mail 地址    | `ZCODE_BACKLINKS_CLOUD_MAIL_BASE_URL`   | `CLOUDMAIL_BASE_URL`         |
| Cloud Mail 令牌    | `ZCODE_BACKLINKS_CLOUD_MAIL_TOKEN`      | `CLOUDMAIL_TOKEN`            |
| 验证邮箱域名       | `ZCODE_BACKLINKS_MAILBOX_DOMAIN`        | 无                           |
| 批次 provider 选择 | `ZCODE_BACKLINKS_BATCH_SOURCE`          | `DSH_BACKLINKS_BATCH_SOURCE` |
| 邮箱 provider 选择 | `ZCODE_BACKLINKS_MAILBOX`               | `DSH_BACKLINKS_MAILBOX`      |

通常无需设置 provider 选择项；内置实现分别为 Supermanager 和 Cloud Mail。未配置后台地址、令牌或需要的邮箱域名时返回明确错误，不使用源项目中的私人部署值。

### 4.4 浏览器与大结果

浏览器 profile：`<dataBaseDir>/.zcode/backlinks/browser/<workspace-hash>/`。

大结果文件：`<dataBaseDir>/.zcode/backlinks/artifacts/<workspace-hash>/`。

hash 根据 `workspaceIdentity?.trim() || workspacePath` 生成。同一工作区的会话共享插件实例和登录态；不同工作区使用不同 profile。远程工作区的浏览器运行在**远端 Host**，浏览器路径和上传文件也属于远端；有界面模式需要该 Host 具备可访问的图形会话。

相同 profile 被活进程占用时，后来的进程拒绝启动。仅本机且 PID 已确认不存在的明确旧锁可在互斥保护下回收；未知格式、其他主机或状态不明的锁不自动删除。上传验证真实路径，拒绝工作区外的文件、目录和越界符号链接。

工具结果超过 60,000 字符时，保存完整 JSON 并返回文件路径、截断标志和 12,000 字符预览；截图保留 MCP 图片内容。大型结果的完整内容仍可追溯。

## 5. 架构与发布状态

共享业务包为 [packages/backlinks](../../packages/backlinks/README.md)，公开入口 `@zcode/backlinks` 提供浏览器安全类型和 schema，`@zcode/backlinks/node` 提供 Node 工厂。UI 通过 [IBacklinksService](../../packages/services/src/backlinks/CONTRACT.md) 调用 `getSettings`、`updateSettings`、`listBatches`、`getBatch` 四个方法；发布写操作交给已有 Agent/MCP 权限流程。

批次、条目、租约和发布结果以 Supermanager 为唯一事实源，邮箱以 Cloud Mail 为事实源。UI 只保存查询、选择和加载状态；任务通过 ZCode 原有创建与 admission 流程提交，不在前端增加独立队列。所有者关系图见 [迁移规范](SPEC.md)。

运行中的已知租约绑定认领时的 provider，即使用户修改设置，保活和回写也不会发往新服务。关闭时会等待在途 claim 并尝试释放已知 lease；正常 MCP 退出的释放请求有 5 秒预算，HTTP claim 自身可能持续 15 秒。强杀、超时或丢失 claim 回执时，仍需依靠后端租约到期和结果核对，不能保证所有退出场景都主动释放成功。

技能按约 30 秒保活；持有租约时将长邮件等待拆成短段。公开 `live` 结果需要核验可点击的真实反向链接；提交后状态未知、仅文本或转义失败需要人工核对，不能自动重放网站提交。修正了源文档中的不一致参数及虚构回调指令，使用 ZCode 当前的 `Agent`、`AskUserQuestion` 和实际 MCP schema。

## 6. 主要文件与构建资产

| 路径                                                       | 职责                                                |
| ---------------------------------------------------------- | --------------------------------------------------- |
| `packages/backlinks/`                                      | 共享业务、HTTP/配置 adapter、schema、测试、模块合同 |
| `apps/zcode-cli/packages/backlinks-plugin/src/`            | MCP 入口、配置脚本、结果处理、持久浏览器            |
| `apps/zcode-cli/packages/backlinks-plugin/skills/`         | 两项技能及所有源参考资料                            |
| `apps/zcode-cli/packages/backlinks-plugin/commands/`       | 原生发布斜杠命令                                    |
| `apps/zcode-cli/packages/backlinks-plugin/docs/browser.md` | 浏览器合同、使用说明及源 MIT 许可                   |
| `packages/services/src/backlinks/`                         | UI 服务合同与 Node 工厂                             |
| `packages/ui/src/settings/backlinks/`                      | 批次列表、详情、配置表单                            |
| `packages/ui/src/lib/backlinksPublish.ts`                  | 插件启用、建任务、提交输入和成功导航                |
| `scripts/backlinks-plugin-assets.mjs`                      | Desktop、远程和 SEA 共用资产清单                    |
| `third-party/link-harness/`                                | 源版权、完整 MIT License 与修改说明                 |
| `harness/backlinks/`                                       | 迁移规范与本交付文档                                |

官方插件默认关闭、版本为 `0.1.0`。`dist/mcp/server.js`、`dist/configure.js`、完整 `runtime/playwright-core` 是构建产物，通过构建/seed 流程生成与复制，不提交生成目录。独立分发测试已将构建后的插件移出仓库，在没有仓库依赖目录的临时位置启动真实 MCP 客户端并完成协议握手及工具调用。

## 7. 验证记录

验证环境：Linux，Node.js **24.19.0**，通过 Corepack 使用项目固定的 pnpm **10.33.2**。环境 Node 比项目指定的 24.14.0 更新；类型检查和测试结果均来自此实际环境。

| 验证项                                       | 实际结果                                                    |
| -------------------------------------------- | ----------------------------------------------------------- |
| 核心业务与配置测试                           | 14 通过，包括独立进程并发写入、死锁恢复、租约路由与关闭竞争 |
| 浏览器运行时与锁测试                         | 10 通过，模拟浏览器执行并使用真实文件系统验证隔离/锁        |
| MCP handler 测试                             | 3 通过，含延迟启动、会话上下文、图片及大结果落盘            |
| 独立分发 MCP 测试                            | 1 通过，使用真实 MCP client/stdio 子进程                    |
| UI 状态、原生服务、RPC                       | 11 通过                                                     |
| 插件发现、隔离、命令、资源打包               | 30 通过                                                     |
| 浏览器本地页面集成                           | 1 跳过，当前环境无 Chromium                                 |
| 原生 UI 浏览器 E2E                           | 1 跳过，同一浏览器环境限制                                  |
| 总计                                         | **71 项：69 通过、0 失败、2 跳过**                          |
| `pnpm typecheck`                             | 通过                                                        |
| `pnpm --dir apps/zcode-cli typecheck`        | 通过，28 个 Turbo 任务成功                                  |
| `pnpm lint` / `pnpm verify:pre-push`         | 通过；根 lint 有 69 条 warnings，0 errors                   |
| `pnpm architecture:check --changed`          | 通过，0 violations / 0 baseline / 0 new                     |
| 本次新增/修改代码定向 lint、格式及 diff 检查 | 通过；部分原有接线文件保留既有 unused warnings              |
| 实际 UI 组件和完整样式 Vite 编译             | 通过，2132 个模块；通用 chunk 体积警告                      |
| `pnpm --dir apps/zcode-cli lint`             | **未通过：原有 telemetry/debug 文件超出 400 行规则**        |

CLI 全量 lint 报错来自以下未修改文件：`telemetry/src/model-api-recorder.ts`、`telemetry/src/agent-trace-runtime.ts`、`debug/src/App.tsx`、`debug/server/analyzer.ts`，均位于 `apps/zcode-cli/packages/` 下。已用 Git diff 确认本次没有更改它们，没有把该命令写成通过。

依赖安装使用了 `--ignore-scripts`，环境中的原生模块安装脚本受限；因此本次没有完整启动 Electron 安装产物或验证所有原生依赖。Chromium 下载多次 CDN 超时，两个真实浏览器测试保留明确 skip，没有把 mock 或样式编译当成浏览器 E2E 通过。Windows、macOS 和完整跨机器远程会话也没有在本环境实机验收。

### 7.1 复现相关测试

先构建插件，确保分发测试使用当前代码：

```bash
pnpm --filter @zcode/backlinks-plugin build
pnpm --filter @zcode/backlinks test
pnpm --filter @zcode/backlinks-plugin test
node --import tsx --test packages/ui/test/backlinksConsole.test.ts packages/services/test/backlinksService.test.ts packages/client/test/backlinksRemoteService.test.ts
node --import tsx --test apps/zcode-cli/packages/adapters/test/*.test.ts apps/zcode-cli/packages/bootstrap/test/*.test.ts apps/zcode-cli/packages/cli/test/*.test.ts apps/zcode-cli/packages/cli/test/*.test.mjs packages/server/test/backlinksOfficialAssets.test.ts
node --test packages/ui/test/backlinksConsole.e2e.mjs
```

需要补跑真实浏览器时，先在允许下载的环境安装测试浏览器：

```bash
pnpm --filter @zcode/backlinks-plugin exec playwright-core install chromium
node --import tsx --test apps/zcode-cli/packages/backlinks-plugin/tests/browser.integration.test.ts
node --test packages/ui/test/backlinksConsole.e2e.mjs
```

UI E2E 也支持通过测试专用 `ZCODE_BACKLINKS_TEST_BROWSER` 指定浏览器。测试只访问临时本地页面，不使用生产 API 或真实账号。

本环境安装过程中出现过 pnpm 全局版本偏差与 esbuild 二进制版本错配；已通过 Corepack 固定 pnpm，并为本地测试指定与 tsx 匹配的 esbuild 二进制后成功运行。没有为环境问题改写项目依赖版本。锁文件只增加本次新包和 UI 测试依赖的 importer 项，没有整体升级依赖。

## 8. 使用边界与后续验收

功能需要用户已有的 Supermanager/Cloud Mail 服务、可用浏览器和 ZCode 模型配置。本次没有复制源项目的 Cookie、真实令牌、私人部署地址、发布记录或运行数据；新环境需自行配置这些连接。

Desktop 本地、默认 Web Host、Desktop 远程工作区已接入相应服务。Web 旧 `/ws/remote/:id` 桥原本没有完整 Agent/task 服务；本次补齐外链查询/配置转发，但没有扩展其原有任务执行能力。不能将该旧路径描述为已验证端到端发布。完整远程发布应使用现有具备任务通道的 Host/工作区路径。

建议后续在实际运行宿主补齐两项 Chromium 测试，确认令牌配置和批次只读查询，再选择一个明确授权的测试批次验证公开链接、证据回写和租约释放。人工登录或网站审核的成功与否由实际目标站点决定，本次源码迁移不承诺每个站点都会接受发布。

## 9. 更新核对与回滚

可用以下命令核对本地和远程版本：

```bash
git fetch origin
git log -2 --oneline origin/main
git show --stat 0962ec9926f5bc56aa8022b73e52913e5ee8ea41
```

临时停止使用可在插件管理界面禁用 Backlinks，或运行：

```bash
zcode plugins disable backlinks
```

需要回滚代码时，先处理当前工作区的未提交改动，再对功能迁移提交创建反向提交：

```bash
git switch main
git pull --ff-only origin main
git revert 0962ec9926f5bc56aa8022b73e52913e5ee8ea41
git push origin main
```

回滚代码不会撤销网站上已经发布的链接，也不会删除用户配置、浏览器登录态或后台记录。本次交付没有修改后台数据库 schema。

## 10. 许可与归属

迁移保留源项目 **Copyright (c) 2026 DeepSeek / MIT License**。完整源许可和修改说明见 [第三方 NOTICE](../../third-party/link-harness/NOTICE.md) 与 [LICENSE](../../third-party/link-harness/LICENSE)，根 [NOTICE.md](../../NOTICE.md) 也已登记。ZCode 第一方代码继续遵循仓库原有许可说明。
