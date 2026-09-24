---
description: 发布指定外链批次，遵守租约、公开核验和不重复提交规则。
argument-hint: [batch IDs]
skills: backlinks:backlink-publish
---

使用已加载的 `backlinks:backlink-publish` 技能执行本次外链发布任务。

用户指定的批次或补充要求：$ARGUMENTS

保留用户给定的批次；没有批次号时按技能的批次选择流程处理。读取所选批次详情后，必须调用一次 `AskUserQuestion`，同时显示“执行范围”和“执行模式”两个问题。两项回答都存在且有效之前，不得调用 `batch_claim` 或开始任何网站发布。认领后必须按技能使用 `backlinks:backlink-publisher` 子代理和最多 3 个并发槽处理条目；不要静默退回主任务直接发布。不要扩大发布范围，也不要重放结果未知的提交。
