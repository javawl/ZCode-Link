# 外链插件浏览器操作说明

本文件说明 `backlinks_browser` 的模型调用契约，以及迁移自 link-harness 2.0.0 的页面操作在 ZCode 中的使用方式。浏览器适配器是本插件的独立边界；发布数据与租约仍由 supermanager 管理，不由浏览器保存。

## 配置与生命周期

- 默认 `browser.channel` 为 `chrome`，`browser.displayMode` 为 `background`，需要宿主安装 Google Chrome。可在外链设置指定实际 `browser.executablePath`；具体可用 channel 以设置和运行时校验为准。
- 高级配置保留源版本的 `browser.launchArgs`、`browser.ignoreDefaultArgs`（字符串数组）以及 `browser.windowPosition`（例如 `-32000,-32000`）。默认数组为空，不移动窗口，也不主动更改自动化标记。仅显式配置后才传给 Chromium；独立的 windowPosition 字段优先于 launchArgs 中的同名参数。两个参数数组都禁止覆盖 `--user-data-dir` 或 `--profile-directory`，持久 profile 的隔离由宿主负责。不同浏览器版本可能拒绝特定参数；这些选项不保证 Google 接受登录，也不用于绕过验证码。
- 浏览器按需启动。`status` 可以在未启动时读取配置与运行状态，不应为了看状态创建窗口。`tabs` 返回当前打开的页。
- profile 由宿主按工作区身份管理，正常关闭后可复用登录态；不同工作区隔离。不自行拼接 profile 路径，不复制用户日常浏览器 Cookie，不导出 profile，不删除锁文件强行占用正在运行的实例。
- 第二个运行时使用同一个 profile 会收到 `BROWSER_PROFILE_IN_USE`。先正常关闭占用该 profile 的宿主。异常退出留下的锁，只有在它属于本机、记录完整、PID 已确定不存在，且所有者和文件 inode 均未变化时才会安全回收；并发回收有独立互斥保护。活进程、其他主机、未知格式或未知回收锁一律保留并报告，不能强行删除。
- 有界面 Chrome 的窗口在工具运行的宿主机器上。远程 Web/手机客户端操作同一宿主，并不在客户端新建 Chrome。
- 服务器正常退出会释放浏览器。批次完成不调用全局 `close`；页面按下文规则自动回收，held 页保留给人工处理。全局 `close` 会关闭自有浏览器或断开外部连接，不应在其他任务仍使用时调用。

### 显示模式

`browser.displayMode` 取 `background` / `visible` / `headless`，在外链设置中选择。未设置时，旧配置 `headless:true` 读为 `headless`，其余为 `background`；`status` 同时返回 `displayMode` 与派生的 `headless`。

- `background`（默认）：有界面 Chrome 在后台运行，窗口停靠到显示器角落之外（Chrome 只保留约 40×100 像素的细边），新页以后台标签创建，除显式 `bringToFront` 外不抢焦点。不使用最小化：最小化窗口在锁屏或应用隐藏后会停止渲染，导致截图与页面脚本卡住。macOS 在启动与站点弹窗后把前台交还原应用；启动和站点弹窗可能短暂闪现（约 1 秒）。Windows / Linux 只做后台标签与停靠。
- `visible`：普通可见窗口，用于调试。
- `headless`：无窗口，`bringToFront` 不提供可交互窗口。人工登录/CAPTCHA 需要切换到 `background` 或 `visible`，并在不影响执行中任务时正常重新启动。修改浏览器启动配置对新启动实例生效，不能把配置值变化当作已运行实例已重启。
- CDP 连接用户浏览器时只以后台标签创建页面，绝不移动、隐藏或切走用户浏览器的前台。
- 显示（`bringToFront`）把该页所在窗口移回屏幕可见位置并激活。显示中的窗口不会被停靠，也不会放入新的自动化标签：之后的批次在另一个停靠窗口中运行，自动化弹窗照常停靠；用户在显示页上操作产生的弹窗保持原样。有页面处于显示状态时不做前台交还，避免打断用户在该 Chrome 中的操作。显示页被关闭或回收后，本插件的窗口重新停靠；显示过的页面不会回池复用。
- 只停靠和复用本插件拥有的窗口与页面。用户在插件 Chrome 中自行打开的窗口/标签（或站点以 noopener 打开的新标签）仍会出现在 `tabs` 中可供观察和操作，但属于外来页面：回收时只解除页名，绝不清空、回池或关闭；有外来标签时整个浏览器不会因空闲被关闭。窗口中一旦出现外来标签，该窗口即转为用户所有，之后不再停靠，也不再放入自动化页面；此后新的自动化页面直接在新的停靠窗口中创建。
- 插件 Chrome 被隐藏（如 Cmd+H）后页面无法截图；macOS 下每次为新页名取页前会取消隐藏（不激活）。

### 页面池与自动回收

页面生命周期由浏览器 adapter 管理，不依赖模型调用 `closePage`。

- 页名 `batch-{batchId}-item-{itemId}`（可带 `-` / `_` / `/` 后缀）绑定该条目；站点弹窗按 opener 继承绑定。
- `navigate` 新页名时优先复用空闲池中的 `about:blank` 页；自有浏览器空闲池最多 3 页，超出直接关闭。
- `backlinks` 或 `backlinks_worker` 的 `item_result` 成功回写后：`live` / `submitted` / `skipped` / `failed + retryable` 关闭该条目弹窗，页面导航到 `about:blank` 后回池，页名失效（后续页面动作返回 `BROWSER_PAGE_NOT_FOUND`）；`failed + manual_required` 的条目页自动标记 held（`holdReason` 为 `manual_required`；子代理随后显式 `hold` 时替换为其给出的原因；具体阻碍仍以条目的 `failureReason` 为准）。页面核验必须在回写前完成。浏览器未启动时不为回收而启动，回收失败不影响回写结果。
- 空闲清扫：非 held 页 10 分钟未使用回收（显示中的页面及其弹窗 30 分钟）；held 页及其弹窗随保留一起，24 小时后关闭；没有页面、没有 held 页且 30 分钟无活动时关闭整个浏览器（保留 profile 登录态；CDP 模式仅断开），下次使用时按最新的外链浏览器设置重新启动。修改显示方式等浏览器设置后，只要浏览器没有任何页面（含保留页与用户标签）且没有执行中的动作，下一次调用就会立即按新设置重建，不必等待空闲关闭。
- 重试已保留的条目时，第一次 `navigate` 结束旧页面的保留，并在新的停靠页面中开始。
- CDP 模式不启用页面池：回收（`item_result` 后、空闲超时或 `closePage`）只关闭自建页面，绝不触碰 `owned:false` 页面。
- 回收只在该页当前动作结束后执行，不会中断执行中的动作。用户手动关闭的页自动移除记录。
- 浏览器出错时检查结构化错误码和原因；发生过点击等可能提交的操作后，若返回 `sideEffect:"uncertain"` 或无法确认结果，不重放最终提交。

## 复用已有登录态

「连接与浏览器」支持已有独立浏览器目录 `browser.userDataDir` 与本地 CDP 地址 `browser.cdpEndpoint`，二选一。目录复用要求原浏览器已关闭；不复制 Cookie、不删除原浏览器锁。CDP 使用例如 `http://127.0.0.1:9222`，连接现有默认 context，在新页面中共享账号。`tabs` 在 CDP 模式下会先连接并返回 `owned`；`owned:false` 的原有页面只可观察或显示，不能修改或关闭。`close` 在连接模式仅关闭自建页面并断开，保留原浏览器及原有标签页；独立启动模式仍关闭自有浏览器。两个程序不应同时自动化操作同一账号。

`backlinks_status.mailbox` 返回域名解析结果。`settings.mailboxDomain` 留空时从 Cloud Mail 网站配置自动读取首个候选域名，不需要查找其他文件。

## 工具名与参数

插件原始工具名为 `backlinks_browser`，ZCode MCP 宿主可能增加命名空间。使用运行时实际发现的名称；不要依赖猜测的完整 `mcp__...` 前缀。

公共参数为 `action`、`url`、`page`、`selector`、`value`、`key`、`files`、`waitUntil`、`timeoutMs`、`format`、`maxChars`、`reason`。只传当前动作需要的字段；未知字段、非法类型和不适用参数以实际 schema 校验结果为准。

| action         | 主要参数                                         | 行为                                                                                           |
| -------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `navigate`     | **page**、url；可选 waitUntil                    | 导航指定页；只有此动作可创建新的命名页                                                         |
| `snapshot`     | **page**；可选 selector、format、maxChars        | 读取页面或元素文本，`format:"aria"` 提供角色/名称                                              |
| `click`        | **page**、selector                               | 点击已观察的元素或截图坐标                                                                     |
| `fill`         | **page**、selector、value                        | 填文本；空字符串用于清空                                                                       |
| `select`       | **page**、selector、value                        | 选择真实表单选项                                                                               |
| `press`        | **page**、key                                    | 对页面当前焦点按键，例如 Enter / End / ControlOrMeta+A；需要先定位焦点，是否等于提交取决于页面 |
| `upload`       | **page**、selector、files                        | 上传工作区内的真实文件                                                                         |
| `screenshot`   | **page**                                         | 返回 PNG 图片，按 MCP 图片内容使用                                                             |
| `waitFor`      | **page**、selector 与 url 二选一；可选 timeoutMs | 等待已知元素或 URL，有界等待；不是无条件睡眠                                                   |
| `hold`         | **page**；可选 reason（≤200 字符）               | 标记指定页 held：保留给人工处理、不被回收，不改变窗口；返回 `acked`                            |
| `bringToFront` | **page**                                         | 显示指定页：恢复窗口、激活标签与 Chrome；仅用于用户同意的人工处理或用户发起的 Google 登录      |
| `closePage`    | **page**                                         | 释放页名：自有浏览器中回池，CDP 模式中关闭；不删除持久 profile                                 |
| `tabs`         | 无页面参数                                       | 列出可操作页面引用、URL、标题及可用的 openerPage、held、holdReason、itemId                     |
| `status`       | 无页面参数                                       | 读取 running / headless / persistent / displayMode / pages / heldPages                         |
| `close`        | 无页面参数                                       | 正常关闭整个插件浏览器，保留持久 profile                                                       |

`navigate` 的 URL 使用绝对 HTTP(S) 地址。`waitUntil` 支持 `load` / `domcontentloaded` / `networkidle`，通常优先 `domcontentloaded`，再针对真实元素 waitFor；不要用 networkidle 假定动态评论已渲染。

超时只表示等待没有在期限内完成，不证明提交没发生。`maxChars` 控制文本输出上限，大页面优先按实际 selector 缩小范围。截图和快照可能包含页面个人信息，只收集当前任务所需部分，不保存密码页或邮件秘密作为发布证据。

## 明确页面引用

保留源版本 11 个页面动作并新增 `hold`，全部要求 `page`；不能依赖“当前活动页”或“最后打开的页”。创建独占页：

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

对未知 page 调用 click / snapshot 等动作会报错，不会悄悄选一张页面。对同一页顺序执行；不同组独占页。同域来源和共享账号授权仍需按发布规则串行，不因开了多页就获得并发提交许可。

OAuth 会产生新窗口时，点击前后读取 tabs；返回示意：

```json
{
  "kind": "tabs",
  "tabs": [
    { "page": "batch-123-item-1001", "url": "https://directory.example/login", "title": "Login" },
    {
      "page": "popup-1",
      "url": "https://accounts.google.com/example",
      "title": "Sign in",
      "openerPage": "batch-123-item-1001"
    }
  ]
}
```

held 页额外带 `held:true`、`holdReason`，绑定条目的页带 `itemId`，例如 `{ "page": "batch-123-item-1002", "url": "https://forum.example/register", "title": "Register", "held": true, "holdReason": "manual_required", "itemId": 1002 }`。

`page` 名称来自实际结果，示例不是固定生成规则。确认 openerPage / URL / 标题及新增关系后，用实际 popup page 操作。弹窗关闭后重新 tabs，再检查原发布页是否完成登录。新窗口数量大于一个或归属不清时先读取候选页确认，不能隐式跳到最后一张页。

`status` 返回形状：

```json
{
  "kind": "status",
  "running": true,
  "headless": false,
  "persistent": true,
  "displayMode": "background",
  "pages": 2,
  "heldPages": 1
}
```

该状态只表明浏览器模式和生命周期，不表示 Google 已登录，也不返回 Cookie、密码或认证 token。配置就绪与邮箱域名可通过插件的只读 `backlinks_status` 读取。

## 选择器

先读取 ARIA 快照，再用实际名称寻址；不要为了省一次快照猜按钮或 CSS。

| 写法                       | 示例                                            | 使用条件                              |
| -------------------------- | ----------------------------------------------- | ------------------------------------- |
| `role:<role>\|<name>`      | `role:button\|Create Account`                   | 已观察到角色和名称                    |
| `label:<text>`             | `label:Email`                                   | 表单实际标签                          |
| `placeholder:<text>`       | `placeholder:you@example.com`                   | 实际占位提示                          |
| `text:<text>`              | `text:Sign in`                                  | 页面所见文字                          |
| CSS                        | `input[name="email"]`                           | 语义寻址不适用且已观察真实结构        |
| `frame(<iframe CSS>)>>...` | `frame(iframe[src*="comments"])>>label:Comment` | 表单位于已确认的 iframe，可嵌套 frame |
| `xy:<x>,<y>`               | `xy:120,240`                                    | 仅 click；根据当前页面截图取坐标      |

示例：

```json
{
  "action": "fill",
  "page": "batch-123-item-1001",
  "selector": "label:Email",
  "value": "实际返回的验证邮箱"
}
```

```json
{ "action": "waitFor", "page": "batch-123-item-1001", "selector": "#comments", "timeoutMs": 5000 }
```

```json
{
  "action": "snapshot",
  "page": "batch-123-item-1001",
  "selector": "frame(iframe[src*=\"comments\"])>>body",
  "format": "aria"
}
```

ARIA 的 link 角色能证明元素是链接，但其名称不一定显示实际 href。发布核验还需确认指向真实 targetUrl；可依据实际 DOM 的 `a[href="..."]` 匹配或独立验证页的实际导航结果。详见 [证据指南](../skills/backlink-publish/references/evidence.md)。

## 素材上传

远程 URL 先下载为当前工作区内的授权素材，再上传。可用工作区相对路径：

```json
{
  "action": "upload",
  "page": "batch-123-item-1001",
  "selector": "input[type=file]",
  "files": ["assets/tool-logo.png"]
}
```

也可传真实绝对路径，但必须仍在当前工作区内；适配器按真实路径检查，拒绝越界文件与通过符号链接访问工作区外文件。不能直接传 `https://.../logo.png`、用户其他目录文件或不存在的路径。不通过复制 profile、Cookie、私人文档等方式绕开上传限制。

## 保留的使用场景与迁移调整

迁移保留浏览、语义/iframe/坐标操作、ARIA/文本快照、键盘、选择表单、真实文件上传、截图、等待、前台人工接管与关页。新增 tabs / status / close 使 OAuth 页面归属和生命周期可以观察；新增 hold、后台显示模式与页面自动回收，人工处理集中到批次末尾。

技能仍包括目录、博客、论坛、内容、游戏、工具六类 playbook；Google 会话、租约和证据指南保留。迁移调整了固定邮箱域名、硬编码己方刷新接口、隐式活动页、不一致并发规则、把 HTML 直写到富文本框与未知结果重发等源文档冲突。实际发布须经过用户选定范围和正常站点规则；迁移代码测试不代表已经向真实站点发布。

## 来源与许可

本目录技能及参考指南改编自 [javawl/link-harness tag 2.0.0](https://github.com/javawl/link-harness/tree/2.0.0/examples/backlink-agent/skills)，经 tag ref 核对的源 commit 为 `3f2de21104493f4c00214a0c1dfc0836b63b6e14`。原始 2 个 SKILL.md 与全部 10 个参考文件（含 6 类 playbook），共 12 个源技能文件都保留对应迁移文件；另新增本 browser.md，共交付 13 个技能与浏览器说明文件。内容已适配 ZCode 的原生插件、工具 schema、配置和运行边界。源许可如下：

```text
MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
