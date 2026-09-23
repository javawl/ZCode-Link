---
name: google-session
description: 在外链插件专用的持久浏览器中初始化或检查 Google 登录会话，为外链站的 Continue with Google 做准备。用户在 Chrome 窗口人工完成密码和二次验证；智能体只导航、显示窗口、观察状态并核验。使用此技能不会执行外链批次。
user-invocable: true
---

# Google 会话管理（google-session）

使用实际发现的 `backlinks_browser` MCP 工具；名称可能由宿主增加命名空间。完整规则见 [Google 会话参考](../backlink-publish/references/google-session.md) 和 [浏览器说明](../../docs/browser.md)。

## 初始化或检查

先用 `backlinks_status` 确认所选浏览器。已有 profile / CDP 登录态直接复用，在新页检查登录；不要复制 Cookie 或修改原有 `owned:false` 页面。

1. 调用 `{"action":"status"}`，读取 `running` / `headless`。运行时默认是有界面 Chrome；尚未运行时状态检查本身不启动浏览器。远程宿主的 Chrome 窗口在宿主机器上，不在手机或浏览器客户端内。
2. 调用 `{"action":"tabs"}`，复用明确属于本次会话检查的 `page`，或创建独立命名页：`{"action":"navigate","page":"google-session","url":"https://accounts.google.com","waitUntil":"domcontentloaded"}`。所有后续页面操作明确带此 `page`，不使用“当前活动页”或“最后打开的页”。
3. `{"action":"snapshot","page":"google-session","format":"aria"}` 确认是否已经登录。已登录直接复核；未登录时 `{"action":"bringToFront","page":"google-session"}`，告知用户在宿主的 Chrome 窗口亲手完成 Google 登录和 2FA，不让用户把密码或验证码发到聊天。
4. 约每 10 秒检查该页一次，最多观察 10 分钟；持续等待时保持简短进度说明。不要把 `waitFor` 当纯睡眠：它必须有目标 `selector` 或 `url`，等待上限用 `timeoutMs`。密码/验证码页只判断状态，不反复抓取敏感字段。用户取消即停止，超时报告“尚未确认完成”。
5. 登录完成后，`{"action":"navigate","page":"google-session","url":"https://myaccount.google.com","waitUntil":"domcontentloaded"}` 再 snapshot 核验，报告会话当前是否就绪。可显示足以区分账号的脱敏邮箱；只有确需用户辨认账号时显示完整邮箱，不保存到发布证据。

## Headless、远程与失败处理

- `headless:true` 无法通过 `bringToFront` 提供可交互窗口。先说明需将外链浏览器设置为有界面模式，并在宿主打开窗口；不要假称窗口已显示。配置的重新启动时机以浏览器说明为准，避免关闭仍在执行的发布页。
- 浏览器未安装或可执行路径错误：报告工具返回的具体错误，指向外链设置中的 `browser.channel` / `browser.executablePath`，不读取或复制用户其他浏览器的 Cookie。
- 用户说“重置”时先明确其含义；普通初始化/检查不会清除 profile、退出其他账号或删除登录态。涉及更换账号时使用 Google 的正常界面，让用户处理密码与验证。

## 使用边界

不自动填写 Google 密码或 2FA。会话已登录只表示当前 Google 会话可用；目标站仍可能要求账号选择、额外同意、设备验证或重新登录，不能承诺以后自动通过所有授权。异常权限要求交用户决定。

本技能不调用 `batch_claim`、不执行发布。浏览器 profile 由宿主按工作区身份保存，跨运行复用不保证固定时长；不提交、导出或分发 profile 文件。

来源：[link-harness 2.0.0](https://github.com/javawl/link-harness/tree/2.0.0/examples/backlink-agent/skills/google-session)，MIT，Copyright (c) 2026 DeepSeek；已适配 ZCode 的显式页面引用、持久浏览器配置与会话核验，许可全文见 [浏览器说明](../../docs/browser.md#来源与许可)。
