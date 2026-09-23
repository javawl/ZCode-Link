# 外链插件浏览器操作说明

本文件说明 `backlinks_browser` 的模型调用契约，以及迁移自 link-harness 2.0.0 的页面操作在 ZCode 中的使用方式。浏览器适配器是本插件的独立边界；发布数据与租约仍由 supermanager 管理，不由浏览器保存。

## 配置与生命周期

- 默认 `browser.channel` 为 `chrome`，`browser.headless` 为 `false`，需要宿主安装 Google Chrome。可在外链设置指定实际 `browser.executablePath`；具体可用 channel 以设置和运行时校验为准。
- 高级配置保留源版本的 `browser.launchArgs`、`browser.ignoreDefaultArgs`（字符串数组）以及 `browser.windowPosition`（例如 `-32000,-32000`）。默认数组为空，不移动窗口，也不主动更改自动化标记。仅显式配置后才传给 Chromium；独立的 windowPosition 字段优先于 launchArgs 中的同名参数。两个参数数组都禁止覆盖 `--user-data-dir` 或 `--profile-directory`，持久 profile 的隔离由宿主负责。不同浏览器版本可能拒绝特定参数；这些选项不保证 Google 接受登录，也不用于绕过验证码。
- 浏览器按需启动。`status` 可以在未启动时读取配置与运行状态，不应为了看状态创建窗口。`tabs` 返回当前打开的页。
- profile 由宿主按工作区身份管理，正常关闭后可复用登录态；不同工作区隔离。不自行拼接 profile 路径，不复制用户日常浏览器 Cookie，不导出 profile，不删除锁文件强行占用正在运行的实例。
- 第二个运行时使用同一个 profile 会收到 `BROWSER_PROFILE_IN_USE`。先正常关闭占用该 profile 的宿主。异常退出留下的锁，只有在它属于本机、记录完整、PID 已确定不存在，且所有者和文件 inode 均未变化时才会安全回收；并发回收有独立互斥保护。活进程、其他主机、未知格式或未知回收锁一律保留并报告，不能强行删除。
- 有界面 Chrome 的窗口在工具运行的宿主机器上。远程 Web/手机客户端操作同一宿主，并不在客户端新建 Chrome。
- `headless:true` 不提供可见交互窗口。人工登录/CAPTCHA 需要可见宿主窗口；先按设置调整并在不影响执行中任务时正常重新启动。修改浏览器启动配置对新启动实例生效，不能把配置值变化当作已运行实例已重启。
- 服务器正常退出会释放浏览器。日常批次完成只关闭自己不需要的页面，保留人工页；全局 `close` 会关闭自有浏览器或断开外部连接，不应在其他任务仍使用时调用。
- 浏览器出错时检查结构化错误码和原因；发生过点击等可能提交的操作后，若返回 `sideEffect:"uncertain"` 或无法确认结果，不重放最终提交。

## 复用已有登录态

「连接与浏览器」支持已有独立浏览器目录 `browser.userDataDir` 与本地 CDP 地址 `browser.cdpEndpoint`，二选一。目录复用要求原浏览器已关闭；不复制 Cookie、不删除原浏览器锁。CDP 使用例如 `http://127.0.0.1:9222`，连接现有默认 context，在新页面中共享账号。`tabs` 在 CDP 模式下会先连接并返回 `owned`；`owned:false` 的原有页面只可观察或显示，不能修改或关闭。`close` 在连接模式仅关闭自建页面并断开，保留原浏览器及原有标签页；独立启动模式仍关闭自有浏览器。两个程序不应同时自动化操作同一账号。

`backlinks_status.mailbox` 返回域名解析结果。`settings.mailboxDomain` 留空时从 Cloud Mail 网站配置自动读取首个候选域名，不需要查找其他文件。

## 工具名与参数

插件原始工具名为 `backlinks_browser`，ZCode MCP 宿主可能增加命名空间。使用运行时实际发现的名称；不要依赖猜测的完整 `mcp__...` 前缀。

公共参数为 `action`、`url`、`page`、`selector`、`value`、`key`、`files`、`waitUntil`、`timeoutMs`、`format`、`maxChars`。只传当前动作需要的字段；未知字段、非法类型和不适用参数以实际 schema 校验结果为准。

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
| `bringToFront` | **page**                                         | 把指定页所属窗口带到宿主前台                                                                   |
| `closePage`    | **page**                                         | 关闭指定页，不删除持久 profile                                                                 |
| `tabs`         | 无页面参数                                       | 列出可操作页面引用、URL、标题及可用的 openerPage                                               |
| `status`       | 无页面参数                                       | 读取 running / headless / persistent                                                           |
| `close`        | 无页面参数                                       | 正常关闭整个插件浏览器，保留持久 profile                                                       |

`navigate` 的 URL 使用绝对 HTTP(S) 地址。`waitUntil` 支持 `load` / `domcontentloaded` / `networkidle`，通常优先 `domcontentloaded`，再针对真实元素 waitFor；不要用 networkidle 假定动态评论已渲染。

超时只表示等待没有在期限内完成，不证明提交没发生。`maxChars` 控制文本输出上限，大页面优先按实际 selector 缩小范围。截图和快照可能包含页面个人信息，只收集当前任务所需部分，不保存密码页或邮件秘密作为发布证据。

## 明确页面引用

保留源版本 11 个页面动作，全部要求 `page`；不能依赖“当前活动页”或“最后打开的页”。创建独占页：

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

`page` 名称来自实际结果，示例不是固定生成规则。确认 openerPage / URL / 标题及新增关系后，用实际 popup page 操作。弹窗关闭后重新 tabs，再检查原发布页是否完成登录。新窗口数量大于一个或归属不清时先读取候选页确认，不能隐式跳到最后一张页。

`status` 返回形状：

```json
{ "kind": "status", "running": false, "headless": false, "persistent": true }
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

迁移保留浏览、语义/iframe/坐标操作、ARIA/文本快照、键盘、选择表单、真实文件上传、截图、等待、前台人工接管与关页。新增 tabs / status / close 使 OAuth 页面归属和生命周期可以观察。

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
