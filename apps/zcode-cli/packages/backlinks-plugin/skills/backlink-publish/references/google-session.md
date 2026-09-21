# Google 会话与 OAuth

本指南供 [backlink-publish](../SKILL.md) 与 [google-session](../../google-session/SKILL.md) 共用，改编自 link-harness 2.0.0 同名参考文档。

专用浏览器使用由宿主按工作区身份管理的持久 profile。用户在有界面 Chrome 中人工登录后，后续同工作区运行可尝试复用当前会话；有效期和站点再次授权由 Google 与目标站决定，不保证长期有效或以后全部自动通过。

## 初始化和检查

1. 用 `backlinks_browser` 的 `status` 读取 `running` / `headless`，用 `tabs` 检查已打开的页。
2. 选明确的 `google-session` 页，`navigate` 到 `https://accounts.google.com`。新命名页只通过 `navigate` 创建。所有 `snapshot`、`waitFor`、`bringToFront` 等操作都传该 `page`。
3. 页面已显示登录账号时，导航到 `https://myaccount.google.com` 复核。否则将该页 `bringToFront`，请用户在宿主 Chrome 中自行输入密码并完成 2FA。
4. 约每 10 秒检查该页状态，最多 10 分钟；用户取消即停，超时如实报告。不要在密码或验证码填写时反复捕捉敏感字段。`waitFor` 只用于已知 URL/元素，不支持省略条件的睡眠。
5. 确认后报告“当前 Google 会话已登录，可用于后续站点尝试”，同时说明若再验证仍需用户处理。账号默认脱敏显示，不在发布 evidence 保存账号信息。

`headless:true` 下 `bringToFront` 不会创建可交互窗口。先用外链设置切换有界面模式，并在不影响执行中批次的时机正常重启浏览器。远程工作区的窗口在服务宿主上；不能承诺点击按钮后窗口会出现在用户手机。

## 发布流程中的决策树

1. 目标站已登录：继续正常表单。
2. 有 Google 按钮：用与发布页分开的命名页检查 Google 会话，避免导航覆盖尚未保存的表单。
3. Google 已登录：回到明确的发布页点击 OAuth 按钮，按下一节定位实际授权页；只处理用户已授权范围内的账号选择和正常基本登录同意。
4. Google 未登录或要求“确认是你本人”/设备验证：若网站也有邮箱注册，可以走配置 cloud-mail 的正常路径。只有 Google 且无法完成时，`failed + manual_required`，说明“Google 会话未初始化或需重新验证，可先运行 /google-session”，保留页面。
5. CAPTCHA 或其他人工墙：对明确的页 `bringToFront`，记实际阻碍，不破解。

## OAuth 弹窗必须明确寻址

专用浏览器**不会隐式把后续操作切到最后打开的页**。每次 OAuth 点击前后列出 tabs，并用页引用绑定后续动作：

```json
{ "action": "tabs" }
```

返回形状示意：

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

工具生成的真实 `page` 可能不同，必须使用返回值，不把示例 `popup-1` 当作固定名称。根据 `openerPage`（若有）、点击前后新增页面、当前 URL 和标题确认归属；无法确认时先 snapshot 候选页，不随便点其他组的授权页。

- 弹窗模式：用返回的 popup page 执行 snapshot / click / waitFor；弹窗关闭后重新 `tabs`，回原始发布页核对站点登录成功。
- 当前页跳转模式：沿用原发布页引用，等待它回到目标站，然后快照核对。
- 多账号：只有用户已选定账号或界面仅有确定账号时继续；不猜哪个账号代表用户。
- 权限范围出现邮件、通讯录、云盘管理等超出基本登录的要求时暂停，由用户决定。正常登录授权不等于批准所有 OAuth scope。

同一 Google 账号的授权与共享会话状态按顺序处理，不能让多个组同时更换账号或退出登录。完成 OAuth 后才恢复跨域独立页面的并行。

## 会话与凭据管理

用户可以选择为发布工作使用专用 Google 账号；账号选择是用户决定，不自动创建。密码、2FA、Cookie、完整 profile 永不写入技能、证据、Git 或上传资料。不要从用户日常 Chrome 复制 Cookie，不猜测 profile 文件位置，不承诺固定存储目录或有效月数。

再次调用检查是只读/导航性质的会话核验，不清理旧 Cookie。用户要求“重置”时先明确是重新登录、换账号还是删除会话；普通初始化不删除 profile。正常批次结束不调用全局 `close`，避免关闭其他待人工处理的页。
