# 批次详情契约错误修复

## 根因

后台返回 HTTP 200，但未填写的网站资料会使用 JSON `null`。迁移后的 schema 使用 `string.optional()`，仅允许字符串或字段缺省，因此将合法空资料误判为契约不一致。

现场只读检查发现：报告批次的 `keyFeatures` 为 null；另一个样本的六个可选资料字段均为 null。参考 deepseek-harness 会省略这些空字段。此前测试夹具省略了字段，未覆盖后台显式返回 null 的形态。

## 修复

- `shortDescription`、`longDescription`、`logoUrl`、`screenshotUrl`、`keyFeatures`、`pricingType` 接受 null 或缺省，统一输出为可选字符串；null 归一为 undefined。
- 必填字段仍严格校验；数字、数组、对象等非法资料类型仍会报错。
- 契约错误增加最多 5 个字段路径，不包含响应值、令牌或原始后台正文。
- 侧栏和 MCP 复用同一 schema。重新构建了 Host、Agent 和 MCP，确认实际插件缓存与新构建的服务器文件哈希一致。

## 实际验证

通过应用运行时与**实际缓存的 MCP 插件**分别执行只读 `batch_get`，三个样本均成功，分别返回 19、36、38 个条目。测试期间没有向真实后台认领、发布或回写结果。

| 验证                                                            | 结果                        |
| --------------------------------------------------------------- | --------------------------- |
| 可空字段、非法类型、必填字段、错误脱敏及原外链逻辑              | 26 项单测通过               |
| 真实 Electron 侧栏 E2E，详情含六个 null 资料字段                | 通过                        |
| 真实 Agent / MCP / 浏览器完整本地发布 E2E，详情含 null 资料字段 | 通过                        |
| `pnpm typecheck`                                                | 通过                        |
| `pnpm lint`                                                     | 通过，66 warnings，0 errors |
| 架构检查                                                        | 0 新违规                    |

回归文件：`packages/backlinks/tests/detail-contract.test.ts`；侧栏与发布 E2E 的后端夹具也已补入 null。

本轮主要修改 backlinks 纯 schema 和 HTTP 错误格式化，公共输出类型、任务所有者、租约和持久化写入链路没有变化。修复不会删除历史错误消息；更新后重新展开详情或重新发起任务即可使用新解析器。

未执行真实网站发布、仓库推送或生产部署；Windows/Linux 实机仍未验收。

本轮生产代码净增加 31 行，新增契约回归文件 118 行，两个 E2E 夹具各补 6 行可空字段。
