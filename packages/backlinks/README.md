# @zcode/backlinks

从 `javawl/link-harness` 的 `2.0.0` 迁移的原生外链业务模块。提供批次与租约、逐条结果回写、互换徽章、来源标签、验证邮箱和共享配置，不依赖原项目的 Cordis/Typert 运行时。

## 公开入口

```ts
import type { BacklinksSettingsSnapshot, BacklinkBatchDetail } from "@zcode/backlinks";
import { createBacklinksRuntime, executeBacklinksCommand } from "@zcode/backlinks/node";

const runtime = createBacklinksRuntime({ dataBaseDir: process.env.ZCODE_DATA_BASE_DIR });
const settings = await runtime.getSettings();
const result = await executeBacklinksCommand(runtime, { action: "batch_list" });
// MCP 进程正常结束、取消任务时释放本进程明确获得的租约。
await runtime.releaseOwnedLeases();
```

工厂不访问磁盘或网络。首次使用某项能力时才读取配置、选择 provider 和请求后台；未配置外链不影响其他 ZCode 功能。浏览器安全的 `contract.ts` 只暴露类型、参数 schema 和端口；具体文件与 HTTP 适配器只在 Node 入口公开。

## 配置

配置文件为 `<dataBaseDir>/.zcode/v2/backlinks.json`。未注入 dataBaseDir 时使用 `ZCODE_DATA_BASE_DIR`，再回退系统用户目录。文件按字段保存覆盖项，每次操作重读；并发更新先取得跨进程文件锁，再原子替换文件，权限为 `0600`。

| 设置               | 新环境变量                              | 兼容源环境变量               |
| ------------------ | --------------------------------------- | ---------------------------- |
| Supermanager 地址  | `ZCODE_BACKLINKS_SUPERMANAGER_BASE_URL` | `SUPERMANAGER_BASE_URL`      |
| Supermanager 令牌  | `ZCODE_BACKLINKS_SUPERMANAGER_TOKEN`    | `SUPERMANAGER_TOKEN`         |
| Cloud Mail 地址    | `ZCODE_BACKLINKS_CLOUD_MAIL_BASE_URL`   | `CLOUDMAIL_BASE_URL`         |
| Cloud Mail 令牌    | `ZCODE_BACKLINKS_CLOUD_MAIL_TOKEN`      | `CLOUDMAIL_TOKEN`            |
| 邮箱域名           | `ZCODE_BACKLINKS_MAILBOX_DOMAIN`        | 无                           |
| 工作源选择         | `ZCODE_BACKLINKS_BATCH_SOURCE`          | `DSH_BACKLINKS_BATCH_SOURCE` |
| 邮箱 provider 选择 | `ZCODE_BACKLINKS_MAILBOX`               | `DSH_BACKLINKS_MAILBOX`      |

持久配置高于新环境变量，新环境变量高于兼容变量。未配置服务地址和邮箱域名时明确报错，不使用源项目的私人部署地址。`getSettings()` 只返回 `tokenConfigured`，不会返回令牌；普通空白 token 草稿保留原值，`clearToken: true` 保存显式空值并阻止环境变量回退。

浏览器设置包含 `headless`（默认 false）、`channel`（默认 chrome）、`executablePath`、可选 `launchArgs`、`ignoreDefaultArgs`、`windowPosition`。启动参数默认空，不启用源项目的自动化标记隐藏；参数不能改写专用 profile 目录。更改浏览器启动设置后，应先正常关闭当前浏览器再重新启动。

## 工具动作

支持源版本的十个动作：`batch_list`、`batch_get`、`batch_claim`、`lease_heartbeat`、`lease_release`、`item_result`、`badge_add`、`source_tags`、`mailbox_create`、`mail_wait`。邮箱创建可省略 domain，此时使用配置中的 mailboxDomain；仍缺失则报错。邮箱轮询默认 120 秒，每 5 秒检查，最大等待 300 秒。

所有 HTTP 操作仅请求一次、默认最多 15 秒并传播取消信号。Supermanager 使用 Bearer 令牌，Cloud Mail 使用原始令牌；响应业务错误、错误格式、HTTP 错误、网络、超时和取消均明确区分。错误不包含后台原始正文或令牌，Retry-After 保留在 `BacklinksError.retryAfterSeconds`。

## 租约和防重复

认领前读取权威批次详情，排除 `submitted`/`live`、已有 publishedUrl 以及同 sourceId 已发布记录；同一次认领对同 sourceId 仅保留一个条目。默认选 pending 与 retryable failed，显式 ID 可选择人工解除阻塞的 manual_required 条目。空数组、未知 ID 和超出批次的 ID 不会变成全量认领。

本进程获得的 lease 只保存必要的路由归属和 item ID，heartbeat、结果、release 固定使用授予租约时的 provider，避免修改配置后请求落到错误服务。本进程持有租约时，拒绝回写不属于这些租约的 item。独立子任务未在本进程 claim 时，保持源 API 的无状态回写路径，授权以后台为准。

`releaseOwnedLeases()` 先等待本进程正在进行的认领请求结束，再释放已知租约，避免关闭时漏掉刚刚获得的租约；释放失败会保留本地记录以便重试，并报告错误。宿主退出时采用 5 秒清理预算，而单个认领请求上限为 15 秒，因此退出清理属于尽力执行：认领结束前清理预算耗尽、进程被强杀或 claim 回执丢失时，应依赖后端租约到期。客户端无法知道丢失回执中的 leaseId，不能伪造释放结果。网页提交不在本模块内执行；技能必须核验公开可点击链接，并将提交后结果不明的条目标记 manual_required，不能重放提交。

## 验证

```sh
pnpm --filter @zcode/backlinks typecheck
pnpm --filter @zcode/backlinks test
pnpm --filter @zcode/backlinks lint
```

测试使用脚本化 HTTP 响应、临时配置目录和独立 Node 子进程，不连接生产系统，不发送真实外链。覆盖全部动作、API 认证与字段、错误和取消、邮箱等待、跨进程配置更新、令牌保密、源去重和租约路由。

迁移来源的 MIT 版权与许可保留在仓库第三方声明中；产品范围见 `harness/backlinks/SPEC.md`。
