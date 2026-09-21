# 状态模型与回写映射

本指南随 [backlink-publish](../SKILL.md) 使用，改编自 link-harness 2.0.0 同名参考文档。

## 状态判定

`backlinks` 调用使用 `{"action":"item_result","itemId":1001,...}`；item 必须属于本次已领取范围。运行时维护条目与租约的关联；源版本和本迁移的 `item_result` 实际 schema 均不以 `leaseId` 作为参数，只有 `lease_heartbeat` / `lease_release` 传 leaseId。结果是闭合分支，只传对应状态字段，不混合失败与成功字段。

| 情形                                               | 状态与字段                                                                    | 后续动作                               |
| -------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------- |
| 公开页已核验可点击目标链接                         | `live` + `publicUrl` / `anchorText` / `targetUrl`，可附 `evidence`            | 记录核验事实                           |
| 有明确提交成功、待审核/收录回执                    | `submitted` + `anchorText` / `targetUrl`，可附 `publicUrl` / `evidence`       | 不重复提交，之后只读复核               |
| 本条/同来源已有 submitted、live 或 publishedUrl    | 不认领、不覆盖原记录；汇总为“已有发布记录，未执行”                            | 可只读检查公开页面                     |
| 尚未提交且公开目标站已有对应链接                   | `skipped` + `skipReason`                                                      | 说明查重依据                           |
| CAPTCHA、人工登录/设备验证、资料或权限需要用户处理 | `failed` + `failureMode:"manual_required"` + `failureReason`，可附 `evidence` | 保留人工页面                           |
| 提交之前可确认无副作用的网络/超时错误              | `failed` + `failureMode:"retryable"` + `failureReason`，可附 `evidence`       | 留待服务端或后续批次有界重试           |
| 最终提交已发出但回执丢失、浏览器变更结果未知       | `failed` + `failureMode:"manual_required"` + `failureReason`                  | 核对公开页、站内记录和邮件，不重放提交 |
| 提交后的 HTML 显示为纯文本，目标链接未生效         | `failed` + `failureMode:"manual_required"` + `failureReason`                  | 不能自动发第二条补救                   |
| 付费墙、站点停服、资格不符、站规禁止、模式排除     | `skipped` + `skipReason`                                                      | 原因具体，不能以一次首屏快照下结论     |

“平台审核中”属于 `submitted`，不因为包含“人工审核”四字改记失败。后台或浏览器超时只有在能确定第三方提交没有发生时才是 `retryable`；时间超出本身不能证明未提交。

### 示例

```json
{
  "action": "item_result",
  "itemId": 1001,
  "status": "submitted",
  "anchorText": "Example Tool",
  "targetUrl": "https://product.example/",
  "evidence": "提交后显示审核队列回执，公开目录尚未发现条目；使用后台资料包"
}
```

这只是形状示例，不能把示例 ID、URL 或证据直接当作真实发布记录。

## 租约纪律与恢复

- 主任务约每 30 秒 `lease_heartbeat`，并检查返回状态。串行和并行均按时间保活，不按完成条目数量计时。
- 同一时刻一个租约所有者；子任务只处理分配到的 item，主任务负责保活与释放。
- `LEASE_CONFLICT` 遵循 `Retry-After`，不强抢。`LEASE_NOT_ACTIVE` 或保活结果未知时停止新提交，先 `batch_get` 查当前状态。
- 丢失租约不能作为“重头再来”的依据。恢复前核对哪些动作已发生；未知项留给人工，不能重新认领后自动重放。
- `item_result` 的返回丢失时，先读取批次确认服务器是否已接受；只有当前租约仍有效且明确未写入时才可重试同一后台结果写入。此过程始终不重做目标站提交。
- 正常完成、取消或失败收尾时释放租约，释放结果不明如实报告。不要在子任务还可能提交时提前 release。

## 人工处理后的再执行

用户已经解决 CAPTCHA、提供资料或初始化会话后，可以显式选择相关 `manual_required` 条目。认领前先核实之前是否提交；单纯解除了登录墙不等于允许重发已经进入审核队列的内容。服务端仍拒绝条目时保留错误，不绕过限制。

## 汇总口径

`live` 是已核验公开链接；`submitted` 是有提交回执但未证实上线；`failed` 分可重试与人工处理；`skipped` 是本次选择不执行的原因。预先排除的已有发布记录单独统计，不能伪造新的 skipped 回写或把旧成果计成本次新发。
