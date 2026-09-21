---
name: backlink-publish
description: 执行或继续 supermanager 外链发布批次：选择批次、领取租约、用专用持久浏览器发布、cloud-mail 邮箱验证、公开链接核验、结果回写、来源标签和互链徽标。适用于用户要求实际发外链、跑批次、重试已解除阻碍的条目；Google 登录准备由 google-session 技能处理。
user-invocable: true
---

# 外链发布（backlink-publish）

使用本插件的 `backlinks`、`backlinks_browser` 和只读 `backlinks_status` 工具执行发布。名称可能由 ZCode MCP 宿主加命名空间，按本次实际发现的工具调用；下文 JSON 是对应工具的参数，不是 Shell 命令。没有实际工具时先报告插件或配置缺失，不臆造工具、不以直接调用生产 API 绕开宿主。

完整浏览器契约见 [浏览器操作说明](../../docs/browser.md)。开始前用 `backlinks_status` 检查所需服务是否配置就绪；它不返回 token。浏览器只在需要时启动；API token、Google 密码、Cookie 均不写入提示词、证据或提交资料。

## 必须保持的执行规则

1. **幂等提交**：本条或同来源已有 `submitted` / `live`、`publishedUrl` 非空时，不认领、不再提交。同一来源对同一个推广网站只发布一次。最终提交已经发出却无法确认结果时，记为 `failed + manual_required`，不自动重试；无链、被转义的旧评论也不能成为再发一条的理由。
2. **证据回写**：只有亲自检查公开、非预览、无需登录的页面，确认实际可点击链接及其目标地址，才能写 `live`。明确进入审核队列写 `submitted`。导航成功、表单清空、HTTP 200 均不能证明已上线。
3. **租约与页面所有权**：只处理本次租约明确授予的 item。约每 30 秒保活；租约不确定或失效时停止新提交。每个页面操作都带明确 `page`，不同任务不抢同一页；OAuth 弹窗也必须先列出并确认引用。
4. **范围来自用户**：沿用用户已经选择的批次、条目和执行模式，不重复要求批准日常步骤。取消选批次不能解释成选择推荐批次。发布授权不包含付费、绕过验证码、修改第三方无关内容或扩大 OAuth 权限。

## 1. 确定批次、范围与模式

用户输入 `/backlink-publish 123`、提供多个批次号，或从批次控制台发来明确列表时，按这些批次执行，跳过重复的批次选择。多个批次去重，按数字 ID 降序逐个执行；不要同时占用多个批次租约。

没有批次号时：

1. `backlinks`：`{"action":"batch_list"}`。
2. 用 ZCode 原生 **`AskUserQuestion`** 提供最近最多 4 个真实批次供选择，显示网站、待执行数、日期。可以多选；自定义输入由客户端提供，不伪造批次选项。只有 1 个批次时，第二项可设为“暂不执行”。没有可用批次时直接报告。
3. 工具返回 `answers`，其键是问题的完整 `question` 文本。卡片取消、跳过、空回答或选择“暂不执行”时，不认领任何批次，报告“尚未选择执行批次”并结束本次发布流程。

例如，以下 ID 和计数必须替换成刚读取的真实值：

```json
{
  "questions": [
    {
      "question": "本次要执行哪些外链批次？",
      "header": "执行批次",
      "multiSelect": true,
      "options": [
        { "label": "批次 123 · 8 条", "description": "示例站点 A，待执行 8 条" },
        { "label": "批次 122 · 3 条", "description": "示例站点 B，待执行 3 条" }
      ]
    }
  ]
}
```

对每个确定批次调用 `{"action":"batch_get","batchId":123}`，读取完整网站资料包、anchors、条目与发布记录。

- **排除已发布**：`publishStatus` 为 `submitted` / `live`、`publishedUrl` 非空，以及同批次同 `sourceId` 的关联条目，作为“已有发布记录，未执行”单列。不要覆盖它们已有的结果。
- **默认范围**：本批次的待发布和 `retryable` 条目。用户指定手选、某些 item 或全部时沿用；“全部”也不能覆盖去重与未知提交保护。`manual_required` 只有在用户已处理阻碍、核对之前是否提交并明确选择条目后才能再次认领。
- **智能匹配（默认）**：勘察后能匹配六类 playbook 才发布；未知类型写 `skipped`，`skipReason` 为“类型不识别，智能匹配模式下跳过”。
- **全部尝试**：已知类型仍用 playbook；未知类型走通用单条目流程，不因为类型未知而跳过。

仅在范围或模式确实影响结果且用户没有指定时，用 `AskUserQuestion` 一次收集缺失偏好。已明确批次、但用户跳过可选模式问题时，可以说明采用智能匹配和待发布范围后继续；用户取消执行或批次选择仍应停止。无人值守任务沿用任务文本中的范围和模式，未指定时使用上述默认值，不扩大范围。

## 2. 认领与保活

调用 `{"action":"batch_claim","batchId":123,"itemIds":[1001,1002]}`；`itemIds` 来自本次选择并去除已发布项。省略 `itemIds` 表示服务端默认待发布和可重试范围，不等于全部强制执行。仅以返回租约授予的条目作为执行清单，记下真实 `leaseId`。

- 主任务拥有租约，约每 30 秒调用 `{"action":"lease_heartbeat","leaseId":900}`。并发和串行使用相同的时间规则，不能按“每完成几个条目”计时。
- 长时间浏览器等待、收邮件或人工处理不能阻塞保活。持有租约时把单次邮件等待缩短至例如 `waitTimeoutMs:20000`，有界分段等待之间保活；总计默认最多等 120 秒。不要在一次 120 秒阻塞调用期间假定租约仍然有效。
- `LEASE_CONFLICT` 遵循服务端 `Retry-After`，不抢占别人的租约。保活失败或 `LEASE_NOT_ACTIVE` 时停止新提交，先读取批次核对结果；不能不核对就重新 claim 并重放提交。
- 全部条目结束或用户取消时，由主任务调用 `{"action":"lease_release","leaseId":900}`。先让正在运行的子任务停止新操作并核对未知提交，不能在仍有发布动作时提前释放。释放失败如实报告，不声称已释放。

## 3. 选择执行方式

默认串行。条目至少 3 个、分属不同域名、可保证保活且每组独占页面时，可使用最多 3 个 ZCode **`Agent`** 子任务并发处理。按 `sourceHost` 分组，同域名串行；同 `sourceId` 或同推广网站的重复来源不能分派到不同组。共享登录、验证码或 OAuth 账号操作串行处理；无法隔离就回到串行。

原生工具调用形状是：

```json
{
  "description": "处理目录站分组",
  "subagent_type": "general-purpose",
  "run_in_background": true,
  "prompt": "完整、自包含的分组任务说明，包含下面列出的约束和真实条目数据。"
}
```

`Agent` 返回后台任务信息，完成后通知主任务。不要调用不存在的 `subagent` / `Subagent` 工具或添加 `model`、`action` 字段。主任务负责等待、保活、汇总和 release，不假定子任务会自动加载技能。

每个子任务提示词必须带上：

- 执行模式、完整网站资料包与 anchors、分组内全部 item 信息（id / sourceId / sourceUrl / submitUrl / sourceHost / category / tags / sourceNotes / 状态 / publishedUrl），真实 `leaseId`、允许执行的 item IDs 和独占页面名。
- 本技能的幂等、证据、租约规则，以及对应 playbook 的完整相关内容；`navigate` 指定独占页，之后所有页面动作都带该页。Google 会话检查和 OAuth 弹窗使用独立明确的页引用，不抢其他组的页面。
- 找不到评论区前完成懒加载探测；根据实际编辑器能力选择 Website、富文本链接或明确支持的 HTML / BBCode，不向富文本框直接输入 HTML。
- 可自助邮箱注册；`mailbox_create` 的邮箱域名来自配置，不猜域名。验证码链接先核对站点和邮箱上下文；Google 密码与二次验证只由用户输入。
- 一次最终提交；结果未知或正文 HTML 被转义写 `failed + manual_required`，不重发。每条立即 `item_result`，然后按观察 `source_tags`。
- 不自行 claim、release、不改主任务的范围、不另开用户问题。发现人工阻碍时 `bringToFront` 保留页面并报告；失去租约或收到取消后停止新的副作用。

## 4. 单条目流程

### 4.1 发布前查重

重新核对 item 和同来源记录。已提交、已上线或已有 publishedUrl 的条目不进入站点提交。若租约授予后发现其他并行任务已完成，停止本项；按后端允许的当前状态回写，不能覆盖别人的成功记录。

在目标站公开搜索/列表中检查目标网站域名和实际可点击链接。有真实旧链接可记 `skipped`（“目标站已存在本站链接，跳过重复发布”）。若只是转义文本或裸 URL，不应误称已发布，但仍需检查旧提交记录：此前确实提交过或结果未知时交人工核对，不能因此自动重发。已提交待审核项允许只读复核并在汇总报告新证据；后端不允许认领它时，不冒充持有租约修改记录。

### 4.2 勘察与分类

优先 `submitUrl`，其次 `sourceUrl`：

```json
{
  "action": "navigate",
  "page": "batch-123-item-1001",
  "url": "https://directory.example/submit",
  "waitUntil": "domcontentloaded"
}
```

```json
{ "action": "snapshot", "page": "batch-123-item-1001", "format": "aria", "maxChars": 18000 }
```

读实际页面再匹配 [目录](references/playbooks/playbook-directory.md)、[博客](references/playbooks/playbook-blog.md)、[论坛](references/playbooks/playbook-forum.md)、[内容](references/playbooks/playbook-article.md)、[游戏](references/playbooks/playbook-gaming.md)、[工具](references/playbooks/playbook-tools.md)。`category` 是提示，冲突时以页面为准并记录原因。

判断“无评论区/无入口”前，依次检查 `#comments`、`#respond`、`#commentform`、`[id*='comment']`、`iframe` 等真实锚点（`waitFor` 设置例如 5000 毫秒的上限），`press` End / PageDown 后重新快照，点击真实存在的 Load comments / 展开按钮，检查 iframe 内容，必要时导航到当前 URL 的 `#comments`。每步都带同一 `page`；iframe 可能与评论无关，应根据页面结构识别，不能把所有 iframe 当成评论。全部探测仍无入口才写 `skipped`：“评论区延迟加载探测后仍不存在”。

选择器优先使用快照中的 `role:button|Create Account`、`label:Email`、`placeholder:you@example.com`、`text:Sign in`，CSS 兜底。iframe 使用 `frame(iframe选择器)>>内部选择器`，支持嵌套；截图后的 `xy:120,240` 仅用于 `click`。

### 4.3 注册与登录

- 已登录：复用当前工作区专用浏览器会话。
- 有邮箱注册：`{"action":"mailbox_create","localPart":"agent-7f42a1"}`，其中 localPart 每次生成唯一的字母/数字前缀，由配置的 `mailboxDomain` 补齐域名；也可显式提供用户指定且服务支持的 `domain`。未配置时报告缺失，不硬编码运营者域名。使用返回的真实邮箱注册，再调用 `{"action":"mail_wait","mailEmail":"agent-7f42a1@example.test","subjectContains":"Verify","waitTimeoutMs":20000}` 等待验证码或验证链接；示例 mailEmail 必须换成工具实际返回的邮箱，过滤条件按真实站点选择，避免错取其他邮件。
- 有 Google OAuth：按 [Google 会话指南](references/google-session.md) 检查会话、选择明确弹窗并继续。若 Google 登录未就绪但站点同时提供邮箱注册，可走邮箱路径；仅 Google 且未就绪时 `manual_required`。
- CAPTCHA、设备验证或注册被拒：保留页面，调用 `{"action":"bringToFront","page":"batch-123-item-1001"}`，记人工阻碍。普通“需要登录”不等于人工事件；先完成可用的常规注册流程。

### 4.4 准备资料、填表和提交

优先用 batch 的 website 提交资料包：`shortDescription`、`longDescription`、`logoUrl`、`screenshotUrl`、`keyFeatures`、`pricingType` 及核心名称和 URL。文案按站点长度与语言调整，事实不杜撰；证据注明“使用后台资料包”。仅缺失项才从推广网站公开资料获取，注明“该项自获取”；必要且无法获取时交用户提供。

上传前把有权使用的素材下载到当前工作区的真实文件。`upload` 的 `files` 接受工作区内绝对路径或工作区相对路径，不能直接传 URL、外部文件路径或指向工作区外的符号链接。不能为了上传复制个人 Cookie、浏览器 profile 或其他敏感文件。

锚文本与 targetUrl 从实际返回的 anchors 选用；若提供启用标记则优先启用项，否则使用列表中的实际可用项，不臆造 active 字段。带链方式：

- Website 字段可携带目标链接时优先填字段，正文写与页面相关的观点。
- `contenteditable` 或富文本工具栏：先输入内容，通过实际提供的插入链接/选中文字等界面操作建立链接，不能将 `<a>` 作为文本填入。
- HTML / BBCode：只有页面说明或已核验先例确认支持时使用相应格式。纯文本框本身不证明支持 HTML；没有可确认的带链方式就跳过，不能发布试探性无链评论。
- 一段评论或一篇投稿一般只放一个目标链接；内容须与文章、版块或目录真实相关，遵守目标站规则。

提交前快照复查 URL、分类、文案、定价与图片。对明确的最终提交按钮只执行一次。网络或工具错误若标为 `sideEffect:"uncertain"`，或无法判断点击是否生效，立即进入人工核对路径，不再点一次。

### 4.5 互链徽标（要求时，在最终提交前）

1. 从目标站实际徽标区获取官方 HTML，核对链接目标与内容；先检查己方公开页面是否已挂上，已有则复用。
2. 用真实 websiteId 调用 `{"action":"badge_add","websiteId":50,"name":"目标目录名称","html":"实际核对过的徽标 HTML","isActive":true}`。
3. 检查返回的 `callbackTriggered` 等结果，但它不证明公开页已经更新。刷新/抓取己方公开页面，核验徽标实际链接和目标域名；可有界检查最多 3 次，间隔约 5 秒，并保持租约。
4. 回调由后端按己方网站已配置的机制执行。不猜测 `/footer/refresh`、不拼接未经确认的回调地址，也不照搬源环境地址。如果公开页没有更新，只有在用户已有授权且后台或项目配置明确提供实际刷新机制时才能使用该机制；否则记“徽标已入库但公开页面未更新”，交人工处理。
5. 确认公开徽标生效后，才回目标站执行 Verify Backlink / 最终提交。

### 4.6 核验、回写与来源标签

提交后读回执，再检查公开列表页/详情页。使用独立验证页可保留原表单；每个动作明确 `page`。ARIA 中真实 link 的名称要与锚文本相符，且实际 href 必须指向目标 URL（见 [证据指南](references/evidence.md)）；不能仅看文字中出现 URL。

结果使用 `backlinks` 的 `item_result`，共同参数为 `itemId`。租约上下文用来确认该 item 属于本次已领取范围；运行时维护条目与租约的关联，`item_result` 的实际 schema 不接受 `leaseId`，不要把它作为额外字段传入。只有 `lease_heartbeat` / `lease_release` 传 `leaseId`：

| 状态        | 必需结果字段                                | 适用情形                                                                         |
| ----------- | ------------------------------------------- | -------------------------------------------------------------------------------- |
| `live`      | `publicUrl`、`anchorText`、`targetUrl`      | 公开页已核验实际目标链接                                                         |
| `submitted` | `anchorText`、`targetUrl`；`publicUrl` 可选 | 有明确提交成功/待审回执                                                          |
| `failed`    | `failureMode`、`failureReason`              | `retryable` 仅用于可确定未提交的瞬时失败；人工阻碍或提交未知用 `manual_required` |
| `skipped`   | `skipReason`                                | 查重、付费、规则不允许、资格不符或当前模式排除                                   |

`live` / `submitted` / `failed` 可附 `evidence`；`skipped` 将事实写入 `skipReason`，不要添加该结果分支不接受的字段。正文 HTML 被转义说明目标链接没有生效，记 `failed + manual_required`，禁止重发。后台 `item_result` 响应未知时先 `batch_get` 核对，不能重做第三方网站提交。详见 [状态模型](references/status-model.md)。

回写后按本次实际观察调用 `{"action":"source_tags","sourceId":156,"tags":["免徽章","可复用"]}`；每次 1–10 个非空标签，只增不删：

| 标签     | 条件                                                                                     |
| -------- | ---------------------------------------------------------------------------------------- |
| `免徽章` | 可免费提交且未要求互挂徽章                                                               |
| `要徽章` | 要求互链徽标或验证                                                                       |
| `可复用` | 此次结果为 `live` 或 `submitted`，表示来源今后可用于其他符合条件的网站，不是同站再次提交 |
| `有盾`   | 实际遇到 Cloudflare / Turnstile 质询，无论是否通过                                       |
| `付费`   | 付费是唯一提交方式；有免费渠道时不因付费加速选项打此标签                                 |

结果回写与打标分别核对成功；标签失败不撤销已成功回写的发布结果，不重新发布。在本次汇总记录新增标签和未完成的后台操作。

## 5. 完成与人工恢复

主任务核对每条结果、停止子任务、释放租约，然后输出中文表格：批次 / 条目 / 来源 / live、submitted、failed、skipped / 公开 URL 或具体原因；另外列出未认领的已有发布记录、人工阻碍、回写或 release 失败。不能把“后台已收到结果”写成“公开链接已上线”。

保留需要人工操作的页面。批次完成不调用全局 `close`，避免关闭其他组或待人工处理的窗口；不再需要的自有页面可 `closePage`。登录态由宿主按工作区身份保存，通常可供之后复用，但会过期；不能承诺所有站点自动登录。用户完成 CAPTCHA / 登录后，仅重试已明确选择且确认未提交的条目。

用户只要求“初始化/检查 Google 会话”时，改用 [google-session](../google-session/SKILL.md)，不认领批次。

补充：[授权与频控](references/safety.md) · [状态模型](references/status-model.md) · [证据标准](references/evidence.md)。

## 来源与修改说明

由 [javawl/link-harness tag 2.0.0](https://github.com/javawl/link-harness/tree/2.0.0/examples/backlink-agent/skills) 的同名技能及全部 10 篇参考指南改编，MIT，Copyright (c) 2026 DeepSeek。适配 ZCode MCP、`AskUserQuestion` / `Agent`、工作区隔离浏览器、可配置邮箱、回调核验和不重复提交规则；源许可全文见 [浏览器说明中的许可](../../docs/browser.md#来源与许可)。
