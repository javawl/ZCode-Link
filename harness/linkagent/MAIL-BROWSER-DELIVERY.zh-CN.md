# 邮箱与浏览器复用修复交付

## 修复内容

原实现仅保存 Cloud Mail 地址和令牌，`mailbox_create` 仍强制依赖独立的 `mailboxDomain`。技能看到该字段为空后容易重复核实，甚至搜索无关文件。现在域名优先级为：工具显式 domain → 手动 mailboxDomain → Cloud Mail `/setting/websiteConfig` 返回的首个有效域名。`backlinks_status.mailbox` 会给出是否配置、域名来源、候选及有界错误；不会输出令牌，也不会为检查能力创建邮箱。

域名字段已移进 Cloud Mail 配置卡片，提示“留空自动获取”。技能明确以状态工具为准，不遍历其他项目、主目录或凭据文件补配置；邮箱发现失败只影响需要新邮箱的条目。API 域名不能推断为邮箱域名。域名解析成功也不代表创建权限或真实收信已经验证。

浏览器支持默认工作区隔离、已有独立目录复用、本地 CDP 连接三种方式。后两种二选一，设置使用同一配置适配器持久化。已有目录要求原浏览器已关闭，规范真实路径后加独占锁；CDP 连接复用原 context 的登录态，在新页发布。已有页标记 `owned:false` 并禁止修改或关闭；关闭连接只清理自有页面，不关闭原浏览器。

当前本机已选择用户指定参考项目的既有浏览器目录；具体路径只保存在本机配置，不写进仓库。检查时参考浏览器未运行，因此没有强行接管或删除任何 Chrome 锁。另提供 CDP 输入框，供连接已经开放本地调试端口的浏览器。

## 验证

| 检查 | 结果 |
| --- | --- |
| 核心邮箱、配置、浏览器、锁和真实 Chromium 测试 | 36 项通过，0 跳过 |
| MCP 与插件独立分发 | 4 项通过 |
| Web 设置交互及移动宽度 | 1 项通过 |
| Electron 侧栏回归 | 1 项通过 |
| Electron → Agent → 技能 → MCP → 浏览器 → 本地提交 → 结果回写 → 租约释放 | 1 项通过 |
| 根类型检查 | 通过 |
| CLI 类型检查 | 28 个任务通过 |
| 根 lint | 0 errors，66 条已有 warnings |
| 外链插件 lint | 0 errors，0 warnings |
| 架构检查 | 0 violations，0 baseline，0 new |
| CLI 全量 lint | 未通过：未修改的 telemetry、contracts、bootstrap 等文件超过 400 行限制；Turbo 提前终止 |

总计 43 项相关测试通过。真实 Chromium 测试验证：第二连接继承本地测试登录 cookie、完成本地表单，断开后原浏览器和原页仍存活；已有目录重新打开后保留测试登录态。测试 API、模型、网站和数据库均隔离。

实际 Cloud Mail 只读检查及客户端缓存中的真实 MCP 工具均返回 31 个可用域名，`configured=true`、`domainSource=discovered`、默认域名可解析。客户端已重建并重启，MCP 与技能缓存内容校验一致；设置页确认自动域名提示、已有目录配置和 CDP 输入框正常显示。

另外，使用本机已选中的参考项目原浏览器目录启动真实 Chrome，并成功渲染本地验证页后正常关闭，确认该目录可直接使用；未读取或导出真实 Cookie / 账号密码，也没有声称特定站点的账号仍有效。

## 使用与边界

1. 从发布批次列表新建发布任务，使任务加载更新后的技能。旧任务保留的计划或上下文不会自动改写。
2. 邮箱域名可留空；需要指定收件域名时在 Cloud Mail 卡片填写。
3. 使用已有目录前关闭占用该目录的浏览器；若要连接正在运行且已开放调试端口的 Chrome，则填写本地 CDP 地址。不要让两个应用同时自动化同一个浏览器。
4. 浏览器配置变更在新浏览器会话生效，API 配置每次读取。

本次没有创建真实邮箱、发送邮件或向真实网站发布，没有推送、部署或修改生产数据。已有真实账号是否过期、站点是否要求重新验证，仍由站点决定；未进行 Windows / Linux 实机验证。

域名发现依据：[Cloud Mail 网站配置实现](https://github.com/maillab/cloud-mail/blob/main/mail-worker/src/service/setting-service.js) 与 [只读路由](https://github.com/maillab/cloud-mail/blob/main/mail-worker/src/api/setting-api.js)。设计与所有权顺序见 [规格](./MAIL-BROWSER-SPEC.md)。
