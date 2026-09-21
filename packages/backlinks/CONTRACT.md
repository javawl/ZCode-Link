# 外链模块契约

`contract.ts` 公开浏览器安全类型、参数 schema 和端口；`node.ts` 组装文件与 HTTP 适配器。批次、租约、结果和来源标签以 Supermanager 为唯一事实源；邮箱以 Cloud Mail 为唯一事实源。本模块不复制后端队列。

配置适配器是 `<dataBaseDir>/.zcode/v2/backlinks.json` 的唯一写入方；每次调用重新读文件，跨进程锁和原子替换避免丢更新，文件权限为 0600。RPC 和工具只返回令牌存在标志；空白令牌编辑保留原值，`clearToken` 明确禁用该令牌并覆盖环境回退。

HTTP 调用只尝试一次，15 秒内完成并响应取消，冲突保留 Retry-After。认领先重新获取批次排除已有发布记录与同来源已发布条目；显式 itemIds 可包含已人工解除阻塞的 manual_required 条目。提交结果不明时上层必须标记人工核验，不能重放网站提交。

迁移来源为 javawl/link-harness 2.0.0，MIT 许可及归属见仓库的第三方声明。详细产品范围及验收见 `harness/backlinks/SPEC.md`。
