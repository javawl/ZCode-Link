# 发布按钮外键错误修复与链路验证

## 根因

批次入口通过 `createTask()` 创建空会话后立即调用 V4 `sendText`，但没有传递现有的 `deferPersistenceUntilFirstPrompt` 参数。

Host 已返回任务元信息，CLI 的 session 主记录却尚未落库；V4 admission 写入 `session_input` 时触发外键失败。此时尚未进入网站发布阶段。参考 harness 的实现也是先建立会话再提交指令，迁移入口需要同时遵守 LinkAgent 自身的持久化契约。

## 修改

`packages/ui/src/lib/backlinksPublish.ts` 的任务创建请求补上 `deferPersistenceUntilFirstPrompt: true`。

这复用自动化任务已使用的机制：CLI admission 先调用统一的首发持久化边界，再写输入账本并返回 ACK。没有关闭外键、修改数据库结构、延时重试或新增数据库写入路径。工作区 identity、远程 session、trace 和插件准备顺序保持原样。

## 验证过程

1. 修改前，用真实 Electron、Host、Agent 和 SQLite 复现同样的 `FOREIGN KEY constraint failed`。
2. 修复后，发布指令被实际配置的本地测试模型接收。
3. 完整测试继续通过真实工具链执行以下操作：

| 检查点                                         | 实际结果              |
| ---------------------------------------------- | --------------------- |
| 加载 `backlinks:backlink-publish` 技能         | 成功                  |
| MCP 工具链步骤                                 | 12 步                 |
| 读取并认领本地测试批次                         | 认领 1 次             |
| 租约保活                                       | 1 次                  |
| 真实 Chrome 导航、填写并提交测试表单           | 提交 1 次，无重复提交 |
| 用匹配目标 href 的浏览器 selector 核验公开链接 | 成功                  |
| 后台接收 `live` 结果及证据                     | 回写 1 次             |
| 释放租约                                       | 1 次                  |
| SQLite `PRAGMA foreign_key_check`              | 0 项错误              |
| 输入账本和 session 父记录关联                  | 有效                  |

测试的模型响应、批次后台和目标网站均为本机临时服务；Electron、Host、Agent、技能、MCP、浏览器和 SQLite 均实际运行。测试经现有“仅允许这一次”权限交互执行，不切换为完全访问模式。Agent DB 显式使用临时目录中的 `agent-sessions.sqlite`。

## 检查结果

- 33 项相关单测通过。
- 完整发布 Electron E2E 通过。
- 浏览器 UI E2E（多选、模拟 admission、失败恢复、配置及窄屏）通过。
- `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`、格式检查通过；lint 66 warnings、0 errors，架构 0 新违规。

复跑完整链路（先确保桌面开发服务和构建就绪，且已安装 Chrome）：

```sh
node --test packages/desktop/test/backlinksPublish.e2e.mjs
```

测试代码位于 `packages/desktop/test/backlinksPublish.e2e.mjs` 和 `test/fixtures/backlinksPublishServer.mjs`。本轮生产逻辑净增加 3 行，原有单测增加 1 行断言，新增测试文件共 427 行；主要变更模块为 UI。

## 使用及边界

重新点击批次的「发布」或「批量发布」会建立新任务。若出现工具权限卡片，按当前权限模式确认后继续。

本轮没有向真实网站提交、认领真实批次或写回真实后台结果，也没有推送/发布仓库。生产网站的账号、验证码、审核与真实模型表现仍需对应环境验收；既有失败空任务没有被批量清理。
