# link-harness 2.0.0 外链能力迁移规范

## 版本与范围

源：javawl/link-harness tag 2.0.0，commit 3f2de21104493f4c00214a0c1dfc0836b63b6e14。
目标基线：javawl/ZCode-Link main，commit 872ad960de7ec172591f7e1952f7849229f94521。
迁移批次与租约、结果回写、来源标签、互链 badge、验证邮箱、批次控制台与配置，以及 backlink-publish / google-session 两项技能和所有指南。
保留源 MIT 归属；不迁移用户运行记录、Cookie、真实凭据和工作数据。

## 原生边界与唯一状态所有者

- packages/backlinks（@zcode/backlinks）：公开类型、错误与运行时校验；HTTP / 配置文件 adapters；应用层按每次调用读取有效配置并选用 provider。公开入口 src/contract.ts（浏览器安全类型）和 src/node.ts（Node adapter 工厂）。
- apps/zcode-cli/packages/backlinks-plugin：官方可启用插件，MCP 工具 backlinks / backlinks_browser / backlinks_status，以及迁移后的两项技能。commands/backlink-publish.md 将原生 /backlink-publish 命令映射到发布技能，保留用户参数。通过现有插件宿主和权限入口启动；按需启动浏览器。
- packages/services 的 IBacklinksService：仅 getSettings、updateSettings、listBatches、getBatch 四个方法，通过既有 RPC 供 Desktop/Web UI 使用。
- UI 只拥有搜索、勾选、展开、加载等临时状态。批次/条目/lease/发布记录唯一事实源是 supermanager；邮箱事实源是 cloud-mail。UI 不自行维护任务队列。
- 配置唯一持久化适配器为 BacklinksConfigStore，位置为 <dataBaseDir>/.zcode/v2/backlinks.json。dataBaseDir 与现有 ZCODE_DATA_BASE_DIR / homedir 规则一致，由宿主注入。MCP 与 UI 使用同一文件，每次操作读取以支持热更新；原子写入、并发更新串行化、权限 0600；只向 UI 返回 tokenConfigured。
- 专用发布浏览器由插件浏览器 adapter 独占持久 profile，保留跨运行登录态、文件上传及可人工接管的 headed 模式；相同页面按顺序执行。默认关闭释放自有浏览器；显式 CDP 复用仅清理自建页并断连。第二进程占用 profile 时返回可操作错误，不删除活进程锁强行接管。只允许回收本机、格式明确且 PID 已证实不存在的遗留锁，回收通过独立互斥保护并复核文件身份；未知锁保持不动。

```mermaid
flowchart TD
  UI["Desktop / Web 批次与设置"] --> RPC["IBacklinksService"]
  Agent["Desktop / Web / TUI Agent"] --> MCP["Backlinks MCP"]
  RPC --> Config["BacklinksConfigStore"]
  MCP --> Config
  RPC --> Backend["supermanager 批次与租约"]
  MCP --> Backend
  MCP --> Mail["cloud-mail"]
  MCP --> Browser["专用持久浏览器"]
```

## 功能契约

1. backlinks 动作与源一致：batch_list、batch_get、batch_claim、lease_heartbeat、lease_release、item_result、badge_add、source_tags、mailbox_create、mail_wait，并保留已支持参数。
2. 批次包含网站资料包、anchors、submitUrl、sourceNotes、分类/标签、支付类型、已发布 URL/状态等所有源字段。
3. 结果闭合联合：live（公开核验 URL+anchor+target）、submitted、failed（retryable/manual_required）、skipped（skipReason）。结果未知不能自动重放提交。已发布条目及同来源重复项禁止重复发布；保留人工解除后显式选择 manual_required 的能力。
4. lease 由服务器授予；仅授权领取的 item 可进入执行；约每 30 秒 heartbeat，失败后停止新的不可逆提交；完成或取消后 release。未知回写结果应先读取核对，不重放网站提交。
5. provider 保留源 HTTP 路由、认证、响应 envelope、错误分类、Retry-After、15 秒单请求超时、取消和有界邮件轮询。变更配置不需重启。邮箱等待默认 120 秒 / 间隔 5 秒；整个 MCP 调用有界。
6. 配置：supermanager / cloudMail 的 baseUrl 和 write-only token，以及 browser 的 executablePath、headless（默认 false）、channel（默认 chrome，使用已安装的 Google Chrome）。当前外链生产部署的验证邮箱域名固定配置为 `screwdom.org`；Cloud Mail 的域名发现只用于只读诊断和非生产部署，不能在生产配置为空时把返回列表首项当作注册域名。已有 profile / CDP 复用、域名解析及所有权边界见 `harness/linkagent/MAIL-BROWSER-SPEC.md`。token 空白编辑保留旧值，clearToken 显式删除；非法 URL / 类型不能覆盖原配置。
   浏览器保留可选 launchArgs、ignoreDefaultArgs、windowPosition 配置，以兼容源启动参数；默认使用可见标准 Chrome。禁止参数覆盖 profile 目录。改变浏览器配置后 close 再打开即重新读取；API 地址与令牌每次调用读取。正常 MCP 关闭以五秒有界请求释放已知租约，未知 claim 响应依赖后端租约到期与人工核对。
7. 新环境变量仅用于启动配置 fallback：ZCODE_BACKLINKS_SUPERMANAGER_BASE_URL、ZCODE_BACKLINKS_SUPERMANAGER_TOKEN、ZCODE_BACKLINKS_CLOUD_MAIL_BASE_URL、ZCODE_BACKLINKS_CLOUD_MAIL_TOKEN、ZCODE_BACKLINKS_MAILBOX_DOMAIN。优先级：有效持久化字段 > 新环境变量 > 源版本兼容环境变量（如源配置声明）；缺失时明确报配置错误，不猜测服务地址或邮箱域名。浏览器设置优先配置文件。
8. backlinks_browser 保留 navigate / snapshot / click / fill / select / press / upload / screenshot / waitFor / bringToFront / closePage，增加 tabs 与 close/status 供观察 OAuth 和正常关闭。保持 source page refs、语义/iframe/坐标 selector、ARIA 快照、上传能力；返回的图片与文本遵守 MCP 内容协议。上传限制在用户工作区的真实文件，明确拒绝越界路径。
9. 技能保留六类站点 playbook、证据与状态、Google 会话；使用实际工具名与 schema。当前外链生产注册统一使用已配置的 `screwdom.org`，不能因为 Cloud Mail 返回其他候选域名就切换注册域名；非生产环境仍可显式选择其他域名。浏览器并发以页面隔离为前提；同域/同项不可并发提交，未知结果交人工核验。

## UI 验收

- 批次按数字 ID 降序，搜索网站/主机/ID，展示状态计数与执行中标志，详情按需加载，30 秒刷新。
- 多选与“全选当前过滤结果”保留隐藏选项；去重后按 ID 降序生成 /backlink-publish 批次列表。
- “批量发布”创建并提交一次正常 Agent 会话输入，走现有 admission；失败保留选择，成功清空并导航/提供任务入口。
- 插件默认关闭时，界面明确说明“发布时启用当前工作区的 Backlinks 插件”；点击后先通过既有 pluginManagementService 启用并核对状态，再创建任务。启用失败不创建任务，保留选择。
- 新设置界面遵守 DESIGN.md、主题、中英文和手机 Web 布局。Token 不返显；更新失败保留旧配置。
- Desktop、Web、远程工作区通过既有 service 访问对应宿主的数据；TUI 使用同一 MCP 工具/技能。

## 构建与验证

- backlinks 官方插件默认关闭，需用户在插件设置或 CLI 中显式启用。MCP isolation=workspace 必须从 manifest 保留到已有连接池，同 workspace 的会话共享实例；不同 workspace 不共享页面。发布 profile 按 workspaceIdentity 或实际 workspacePath 的 SHA-256 分目录。
- MCP server 为 dist/mcp/server.js；完整 Playwright 核心模块复制到 runtime/playwright-core，构建时重写其模块引用；不打包浏览器二进制。Desktop、SEA、远程和开发构建必须验证服务器、配置入口、两项技能、命令别名、docs/browser.md 与 Playwright 入口均存在。
- 除原有十动作与浏览器工具外，提供只读 backlinks_status 返回脱敏配置与准备状态；命令行配置入口从 stdin 读取 JSON，凭据不放命令行参数或模型上下文。
- 补齐官方插件发现、seed、CLI/SEA、桌面本地与远程资源、Web 服务资源路径，避免只在源码下可用。
- 实现前准备测试：HTTP 路由/envelope/错误/取消、邮件筛选与超时、配置热更新/保密/原子失败、命令 schema 与结果/lease、批次选择与提交失败、浏览器真实本地页面交互/上传/持久 profile。
- 实际运行 root typecheck/lint、CLI typecheck/lint、architecture:check --changed、相关单元/集成与可运行的 UI E2E。分清迁移新增问题、既有失败、环境限制；不把模拟通过称为真实网站发布通过。
- 不连接用户真实生产 API、不登录真实账户、不发布真实外链来测试。本次授权为迁移、验证和更新 GitHub。
- 最终中文 Markdown 交付包含迁移矩阵、使用配置、路径、测试原始结果摘要、限制、提交与回滚步骤。

# LinkAgent 侧栏发布批次与鉴权修复

## 侧栏展开列表

- 对齐参考 harness 的紧凑条目列表：每个条目独占一行，左侧显示来源域名，右侧显示后台原始状态。
- `executed` 绿色、`failed` 红色，其余状态弱化为灰色。长域名单行省略，悬停可查看完整域名；状态保持完整并右对齐。
- 侧栏紧凑模式不显示网站简介、锚文本、表头或结果长文本，避免三列表格撑宽侧栏；宽屏详情组件保留原有完整模式。
- 紧凑模式的发布按钮位于条目列表之后，展开时域名列表紧接批次标题。
- 不改变批次选择、详情读取、发布、状态事实或排序，继续以后台数据为准。

## 批次详情可空资料字段

- Supermanager 的网站资料字段 `shortDescription`、`longDescription`、`logoUrl`、`screenshotUrl`、`keyFeatures`、`pricingType` 在未填写时会返回 JSON `null`，也允许缺省。
- 共用 schema 接受这些字段的 `string | null | undefined`，将 `null` 归一为 `undefined`，对 UI、MCP 维持原有 `string | undefined` 输出契约。保留已提供的字符串，不编造资料。
- 不放宽必填身份、批次计数、条目、状态和锚文本字段的校验；数组/数字等错误资料类型仍拒绝。
- 解析错误应带有限的字段路径，便于定位契约问题；不包含原始响应、字段值、令牌或自由文本错误详情。
- 现场以只读 GET 验证出现过问题的批次，回归测试使用脱敏的相同字段形态，同时覆盖侧栏详情与真实 MCP 发布测试；不得为验证契约而认领或发布真实批次。

## 发布首条输入的持久化边界

- 发布按钮仍按「启用当前工作区插件 → 创建空任务 → 提交发布命令」执行。
- 创建空任务必须传 `deferPersistenceUntilFirstPrompt: true`，使用已有 task facade / V4 admission 协议：CLI 先持久化 session 主记录，再写带外键的 session_input 账本。
- 不关闭外键、不补写数据库行、不增加等待时间或重试来掩盖时序问题；会话与输入仍由 CLI runtime 唯一拥有。Desktop continuous 与 Web replayable 都走同一边界。
- 失败不清除选中批次，不自动重发可能已接收的命令；成功 ACK 后才导航到任务。
- 必须用隔离数据目录、真实 Electron/Host/Agent/SQLite 和本地模型/批次/站点服务测试。不能仅以 mock createTask/sendPrompt 的单测宣称发布流程通过。

```mermaid
sequenceDiagram
    participant UI as 批次面板
    participant H as Host task facade
    participant R as CLI V4 admission
    participant DB as Session SQLite
    UI->>H: enable plugin → createTask(deferred)
    H-->>UI: taskId / traceId
    UI->>R: 经 Host 提交 sendText
    R->>DB: ensureSessionPersistedForExternalActivity
    R->>DB: 写 session_input（外键有效）
    R-->>UI: accepted ACK
    R->>R: 执行技能与工具
```

- 侧栏一级切换依次为「分组 / 项目 / 发布批次」。发布批次在侧栏直接显示搜索、刷新、全选、多选批量发布、单批发布及详情，不再通过上方独立入口跳转批次设置页。
- 参照 deepseek-harness 当前批次面板的信息密度：紧凑的批次号/域名、待/成/败计数、行级发布按钮；适配窄侧栏及中英文。连接与浏览器配置通过侧栏入口前往既有设置页。
- Root/WorkspaceSidebar 的本地 tab 状态只控制 UI，不改写任务分组持久化值。批次 store 仍是单个宿主的只读投影，后台继续拥有批次、租约及发布状态；发布复用既有插件准备和任务 admission。
- 切换到批次 tab 不改变当前任务/工作区；切回项目/分组恢复原视图。隐藏面板不发起轮询；显示时刷新。跨工作区/远程 identity 继续隔离投影与发布目标，保留 stale ACK 防护。
- 401 调查确认：同一服务地址、相同 Bearer 头，LinkAgent 本地令牌返回 401，用户指定 harness 的令牌返回 200。仅通过既有配置 writer 修正本机令牌；不改服务端认证、不轮换令牌、不写生产后台，不把凭据或服务地址提交到仓库。
- 401/403 UI 提示应明确说明 Agent Token 被拒绝并提供连接设置入口，禁止将 token 拼入错误消息；不自动重试发布操作。
- 验收包括：第三 tab 位置、紧凑列表搜索/排序/多选、发布任务路由、切换视图、只读真实查询恢复及 HTTP 拒绝回归测试。测试发布只用本地 stub，真实服务仅 GET 查询。

```mermaid
sequenceDiagram
    participant U as 用户
    participant S as 侧栏批次面板
    participant H as 当前工作区 Host
    participant B as 批次后台
    U->>S: 打开发布批次 tab
    S->>H: listBatches（既有 service）
    H->>B: GET /api/agent/batches + 当前保存的 Agent Token
    B-->>S: 经 Host 返回批次投影
    U->>S: 选择批次并发布
    S->>H: 启用插件 → 创建任务 → 串行 admission
    H-->>S: 当前 identity 的接收 ACK
```
