# LinkAgent 专用外链工作台瘦身规格

## 目标

LinkAgent 是面向外链批次发布的专用桌面工作台，不再向普通用户暴露 ZCode 的通用开发工作台、插件市场或内容生产能力。本轮收缩主导航、设置、官方插件运行面和启动期服务，并把 Agent 文件与普通 MCP 工具访问固定为“完全访问”，同时保留完整的父任务、发布子代理、专用浏览器、邮箱验证、结果回写和租约释放链路。

本轮不实现无人值守发布策略，不跳过发布前由 Backlinks 技能发起的执行范围与执行模式双问答；这两个业务问答不属于工具权限确认。系统仍保留必须由用户直接参与的交互和显式标记为 `alwaysAsk` 的高风险安全边界，不删除 Web/远程协议，不修改生产服务、域名、凭据或部署配置。

## 产品能力 Profile

唯一产品策略由共享的 `LINK_AGENT_PRODUCT_PROFILE` 提供。UI、Agent 官方插件筛选和宿主服务装配只能读取该 Profile，不在各处散落独立的产品判断。

允许的用户能力：

- 发布批次：批次列表、搜索、详情、多选、单批和批量发布。
- 运行记录：复用既有 Task/Session 列表和对话时间线，展示发布过程、问题、工具调用和结果。
- 设置：通用、外观、模型供应商、外链连接与专用浏览器。
- 登录和模型配置保持可选；未登录仍可进入工作台，无模型时不能发送任务。

内部保留但不作为通用设置暴露的能力：

- Task admission、Session 持久化、对话投影和恢复。
- 插件、Skill、MCP 和专用子代理加载运行时。
- `backlinks:backlink-publisher` 及其受限 `backlinks_worker` 工具面。
- `workspaceIdentity?.trim() || workspacePath` 隔离，以及 desktop continuous / web remote replayable 交付边界。

固定的 Agent 权限策略：

- `LINK_AGENT_PRODUCT_PROFILE` 是固定权限模式的唯一所有者，值为协议模式 `yolo`，产品文案显示“完全访问”。
- 新任务、已有草稿、历史会话恢复和分叉恢复都必须在第一次工具调用前归一为该固定模式，旧的 `build` / `acceptEdits` / `plan` 本地状态不能重新覆盖它。
- Composer 只显示不可交互的“完全访问”状态，不显示计划模式或其他权限模式菜单，也不响应模式循环快捷键。
- 普通 `needsApproval` 工具（包括 Backlinks MCP）直接执行，不生成 `permission.updated` 待确认状态，不通过自动点击弹窗或伪造用户选择绕过。
- `requiresUserInteraction` 与 `alwaysAsk` 仍是独立的强制安全边界；本轮不改变其含义。

明确关闭的通用产品能力：

- 任意新建任务入口、Command Center、通用 Automations 与 Plugin Store 主入口。
- Memory、用户 Subagents、Plugin、MCP、Skills、Commands、Hooks、通用 Browser、Computer Use、Shortcuts、Workspace File Search、Usage、Migration 设置入口。
- 非 Backlinks 官方插件的运行时播种与默认启用。
- 启动期 OffPeak 调度服务和 Feedback 提交宿主。

## 状态所有者

| 状态 / 事实                       | 唯一所有者                                | UI 或派生投影                              |
| --------------------------------- | ----------------------------------------- | ------------------------------------------ |
| 批次、条目、`executing`、发布记录 | Backlinks 后台                            | `BacklinksConsoleStore` 只读刷新与临时选择 |
| 已接纳 Agent 输入和任务生命周期   | `IZCodeTaskService` / CLI CommandInbox    | Task/Session 对话投影                      |
| 执行范围和执行模式                | `backlink-publish` 技能 + 当前任务回答    | UI 不持久化第二份选择                      |
| 批次租约                          | 发布父任务                                | 子代理只能 heartbeat 和单条结果回写        |
| 单条站点提交                      | `backlinks:backlink-publisher`            | 父任务核对后台终态后汇总                   |
| 外链连接和浏览器配置              | `BacklinksConfigStore`                    | 设置页 snapshot                            |
| 模型配置和选择                    | ProviderSettings / ModelSelection service | 设置页和提交 intent                        |
| 默认模型                          | ModelSelection service + Personal config  | 模型列表单选标识、Agent / 发布初始选择     |
| 固定权限模式                      | `LINK_AGENT_PRODUCT_PROFILE`              | Composer 状态标识与 Runtime mode override  |

## 事件顺序

```text
用户选择批次
  → BacklinksConsoleStore 临时选择
  → 为当前 workspace 启用内置 Backlinks 能力
  → IZCodeTaskService.createTask(deferPersistenceUntilFirstPrompt)
  → IZCodeTaskService.sendPrompt
  → batch_get（只读）
  → AskUserQuestion（范围 + 模式）
  → batch_claim（明确 item ids）
  → 父任务按 sourceHost 建立最多 3 个槽位
  → 专用子代理逐条 heartbeat / browser / mailbox / item_result
  → 父任务 batch_get 核对终态
  → lease_release
  → 后台 executing/结果刷新到 UI
```

所有新建、冷恢复和分叉得到的 Session 在进入上述链路前先应用 Profile 的 `yolo` mode override；因此 `batch_get`、`batch_claim`、`item_heartbeat`、`item_result` 和 `lease_release` 等普通 Backlinks MCP 调用不会插入工具权限对话框。技能中的范围与模式双问答继续按原顺序阻塞 claim。

发布入口的 `publishing` 只表示任务提交请求尚未结束，不能冒充后台 `executing`。晚到 ACK 必须继续经过 workspace、service 和 task-service identity 防护；页面重开不能自动重提任务。

模型默认值只有一条写入路径：`IModelSelectionService.setConfiguredDefault` 校验当前 Registry 中可执行的完整模型选择后写入 Personal Provider 配置。没有显式配置时，Registry 顺序中的第一个可选模型是派生默认值；用户在模型列表选择其他模型后，保存为显式默认值。模型被删除、禁用或失效时不执行坏配置，读取面自动回退到新的第一个可选模型。新建 Agent 会话和外链发布任务都把同一份 `preferredSelection` 固化到创建 intent，不能各自维护另一份默认模型。

## UI 规则

- 侧栏默认打开“发布批次”；另一个一级 tab 为“运行记录”。
- 移除侧栏顶部的新建任意任务、搜索、Automations 和 Plugin Store 入口。
- 发布成功后侧栏继续停留在批次 tab，主区打开被接纳的运行任务。
- 设置导航只显示通用、外观、模型和外链；旧的深链或持久化 section 统一回退到通用设置。
- 继续复用 `DESIGN.md` 的颜色、组件和 `text-ui-*` 字号；桌面与窄屏不产生横向溢出。
- 减少动态效果偏好下，执行中批次使用静态 warning 高亮。
- Composer 左下角以只读状态展示“完全访问”；点击不展开模式菜单，历史草稿也不能让它回退到其他模式。
- 模型列表每行提供互斥的“设为默认”选择；当前默认模型显示“默认”标识。首个可选模型在未配置时即显示为默认，选择成功后再更新标识，保存失败保留旧默认并展示错误。
- 外链发布创建父任务时必须读取目标 Host 的 `preferredSelection` 并传入 `createTask`；打开该 Agent 会话后 Composer 展示的模型与设置页默认值一致。

## 官方插件和服务装配

- 官方插件目录可以继续保留完整定义供源码兼容，但产品运行时只能播种和发现 Profile allowlist 中的 Backlinks 插件。
- Backlinks 是专用工作台唯一允许的官方插件，必须在 Agent 进程发现阶段默认启用；不能等用户点击发布后才修改配置，否则已启动的 workspace Agent 会继续持有旧插件快照。默认启用只让 command、skill、agent 与 MCP 可用，不代表自动认领或发布；第三方写操作仍由“发布”按钮和双问答显式触发。
- Backlinks MCP 继续按 workspace 隔离，并在首次实际需要时启动浏览器。
- 非 allowlist 插件不得进入默认启用集合、可恢复内置列表或插件来源播种。
- OffPeak 与 Feedback 服务不在 LinkAgent Profile 下启动；调用方不得再读取它们。
- 其余通用服务本轮允许暂时保留，以降低对现有 Task/Session 和远程协议的风险；后续只有在 `dep:refs` 与完整回归证明无消费者后才能物理删除。

## 失败语义

- Backlinks 插件准备失败：不创建任务，保留批次选择并显示错误。
- 任务创建或 admission 失败：不清空选择，不声称发布开始。
- 默认模型保存失败：不做本地成功假象，不改变发布任务的模型。
- 批次停止先取消对应会话及全部后台任务，再释放该会话持有的租约；任一步失败都保留可见错误和后台 `executing` 事实，不把按钮提前恢复成“发布”。
- 双问答取消或无效：不 claim、不启动浏览器、不产生第三方写操作。
- 租约失效：停止新的站点提交，先读取批次核对。
- 最终提交结果不确定：写 `failed + manual_required`，不得自动重试。
- CAPTCHA、MFA、付费或账号所有者输入：保留页面并进入人工处理。

## 验收场景

1. 启动后侧栏默认显示发布批次，只有“运行记录 / 发布批次”两个一级 tab，不显示新建任务、搜索、Automations 或 Plugin Store。
2. 设置页只显示通用、外观、模型供应商和外链；旧 section 深链安全回退。
3. Agent 官方插件运行面只包含 Backlinks，专用插件仍携带 command、skill、agent 和 workspace-isolated MCP。
4. 批次发布继续在认领前显示范围与模式双问答；取消不认领。
5. 完整本地发送链路实际经过父任务、专用发布子代理、受限 worker、真实浏览器表单提交、公开链接核验、结果回写和租约释放。
6. `workspaceIdentity`、desktop/web delivery kind、stale ACK 和后台 `executing` 唯一事实源保持不变。
7. 执行相关单测、桌面 E2E、`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 和格式检查，并分别报告已有问题与本次新增问题。
8. 新任务和历史会话的 Runtime mode 均为 `yolo`；Backlinks 完整发送 E2E 不再自动点击任何权限选项，并断言页面未出现工具权限确认对话框。
9. 未配置默认模型时首个可选模型显示为默认；切换默认后重启仍保持，新建发布任务的 `modelSelection` 与该默认值一致。
10. `executing=true` 的批次显示“停止”；点击后父会话、后台子任务和该会话租约依次停止 / 释放，同一批量任务的其他批次同步结束，普通会话 Stop 语义不变。

## 迁移边界

- 已有 Task、Session、Backlinks 配置和浏览器 profile 不迁移、不删除。
- 已安装的非 Backlinks 插件文件不主动删除，只是不再进入 LinkAgent 产品运行面。
- 旧设置 section 偏好只做路由回退，不清除用户本地数据。
- 本轮不推送、发布、部署，不连接真实生产写接口执行测试。
