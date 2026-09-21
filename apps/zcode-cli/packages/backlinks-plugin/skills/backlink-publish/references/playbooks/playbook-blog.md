# 博客评论（category: 博客）

改编自 link-harness 2.0.0 同名 playbook；共同的授权、查重、租约和结果规则遵循 [主技能](../../SKILL.md)。评论应与文章真实相关，遵守站点规则；一个博客对同一推广网站只评论一次。

## 流程

1. 从 `sourceUrl` 或站内最新列表选择与推广网站相关的近期文章。先读文章内容与现有评论，不能只凭标题生成无关推广。
2. 检查本站既有链接与后台提交记录，避免重复评论；然后勘察评论表单并完成下面的懒加载检查。
3. 有姓名 / 邮箱 / Website / 评论字段时，Website 填 anchors 的 targetUrl，邮箱由已配置 cloud-mail 提供。评论写 2–3 句针对文章的真实观点，正文无需重复放目标链接。
4. 没有 Website 时，按下面的实际编辑器能力选择正文嵌链。没有可信带链途径则 skipped，不发试探性无链评论。
5. 登录是常规流程的一部分：Wix 会员墙、Disqus、Blogger 等先按 [Google / 邮箱决策](../google-session.md) 处理。有正常邮箱注册时先注册；仅在确实需要人工登录、验证码或账号资格时 manual_required。
6. 提交前复核，最终提交一次。明确待审写 submitted；立即可见仍需公开页链接核验才写 live；结果未知或 HTML 被转义写 manual_required，绝不自动发第二条。

## 评论区懒加载检查

首屏快照没有评论区不代表不存在。每一步都带本项明确 `page`，找到有效入口即可停止探测：

1. 使用 `waitFor` 检查真实常见锚点：`#comments`、`#respond`、`#commentform`、`[id*='comment']`、`iframe`，例如 `timeoutMs:5000`，随后重新 snapshot。`waitFor` 必须有 selector 或 URL，不是无条件睡眠。
2. `press` End / PageDown 滚到正文下方，再 snapshot；查看加载提示或登录入口。
3. 看到真实的 Load comments / Comments / 展开评论按钮，先 click，再 snapshot。
4. 检查有关 iframe，使用 `frame(iframe[src*='disqus.com'])>>内部选择器` 等真实选择器。iframe 也可能是广告，须核实归属，不能一律当成评论。
5. 必要时将当前文章 URL 的 fragment 设为 `#comments` 后导航并读取，避免盲拼出两个 fragment。

全部检查仍不存在入口时，skipped 的 skipReason 为“评论区延迟加载探测后仍不存在”。如果确认评论关闭，应记录明确的关闭提示；不是以一次快照推断“静态页面不能评论”。

## 编辑器识别与嵌链

| 所见能力                                                | 正确方式                                                         |
| ------------------------------------------------------- | ---------------------------------------------------------------- |
| Website 字段                                            | 填目标 URL，正文写相关观点                                       |
| 带链接按钮的富文本 / contenteditable                    | 先输入内容，通过工具栏插入链接；必要时用键盘选中锚文本再设置 URL |
| 页面明确标注允许 HTML，或同类型字段已有核验的 HTML 先例 | 可用 `<a href="targetUrl">anchorText</a>`                        |
| BBCode 提示或已核验 BBCode 先例                         | 可用 `[url=targetUrl]anchorText[/url]`                           |
| 只有纯文本框，无链接工具/格式说明/先例                  | 不假定能解析 HTML，skipped 并说明无可靠带链途径                  |

一段评论只嵌一个目标链接，锚文本融入自然观点。裸 URL 只在站点明确自动转为链接、且实际核验该能力时可用；提交后的裸字符串不能算 live。

WordPress 的 `commentform`、`wp-comments-post` 或 HTML allowed 提示，Blogger 的评论 iframe，Disqus 容器和 Wix 的富文本工具栏都只是勘察线索。**不能按平台品牌保证某段 HTML 会被渲染**：源版本对不同 Wix 表单记录的行为不同，本迁移统一以当前编辑器能力和实际先例为准，删除固定站点传闻与个人评论 ID。

## 核验与失败

公开评论正文或作者 Website 链接需能点击，且实际 href 对应 targetUrl；HTML 字面文本不满足标准。被转义的旧评论不是有效链接，但已有提交事实仍阻止自动重发。若当前只显示“已收到评论”但公开页不可见，按回执写 submitted；未知回执交人工核对。

站规禁止外链、评论明确关闭、主题不相关或没有可确认的带链方式时 skipped。不要为了获得发言资格刷多篇评论。
