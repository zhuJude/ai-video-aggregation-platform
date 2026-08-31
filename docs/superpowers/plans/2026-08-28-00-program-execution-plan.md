# AI 视频聚合平台 Program Execution Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将已确认的生产级 AI 视频聚合平台拆成可在多个 Codex 子窗口中独立开发、验证并安全合并的工作包。

**Architecture:** 采用 TypeScript monorepo，但每个 NestJS 服务和 Next.js 应用都是独立构建、部署与数据所有权单元。共享契约先冻结，随后领域服务、两个前端、报表与基础设施并行开发，最后由单独集成窗口完成锁文件、跨域流程、压测、安全与上线门禁。

**Tech Stack:** Node.js 24 LTS、pnpm 11、TypeScript 7、Next.js 16、React 19、NestJS 12、PostgreSQL、Prisma 7、Tair/Redis、RocketMQ 5.x、Vitest 4、Playwright 1.62、Docker、Terraform、Helm、ACK Pro。

---

## 1. 计划文件索引

| 工作包 | 计划文件 | 是否可并行 | 依赖 |
|---|---|---|---|
| WS00 | `2026-08-28-ws00-foundation-contracts-implementation.md` | 否，必须先完成 | 设计规范 |
| WS09 | `2026-08-28-ws09-edge-gateway-implementation.md` | Wave 1 | WS00 |
| WS10 | `2026-08-28-ws10-identity-iam-implementation.md` | Wave 1 | WS00 |
| WS11 | `2026-08-28-ws11-catalog-routing-implementation.md` | Wave 1 | WS00 |
| WS12 | `2026-08-28-ws12-wallet-payment-implementation.md` | Wave 1 | WS00 |
| WS13 | `2026-08-28-ws13-generation-provider-implementation.md` | Wave 1 | WS00 |
| WS14 | `2026-08-28-ws14-assets-operations-notifications-implementation.md` | Wave 1 | WS00 |
| WS15 | `2026-08-28-ws15-user-web-implementation.md` | Wave 1 | WS00 |
| WS16 | `2026-08-28-ws16-admin-web-implementation.md` | Wave 1 | WS00 |
| WS17 | `2026-08-28-ws17-reporting-observability-implementation.md` | Wave 1 | WS00 |
| WS18 | `2026-08-28-ws18-infrastructure-deployment-implementation.md` | Wave 1 | WS00 |
| WS20 | `2026-08-28-ws20-integration-hardening-launch-implementation.md` | 否，最终集成 | WS09–WS18 |

## 2. 执行波次

```text
Wave 0（串行）
  WS00 基础工程、共享契约、Provider SDK、测试底座
        |
        v
Wave 1（最多十个独立窗口并行）
  WS09 边缘网关       WS10 身份/IAM           WS11 目录/报价/路由
  WS12 钱包/支付
  WS13 生成/Provider  WS14 资产/运营/通知     WS15 用户端
  WS16 管理后台       WS17 报表/可观测性      WS18 云基础设施
        \                 |                 /
         \________________|________________/
                          v
Wave 2（单一集成窗口）
  WS20 锁文件、跨域 Saga、E2E、压测、故障演练、安全、上线门禁
```

WS00 合并之前不得启动 Wave 1。Wave 1 可以全部并行，但不要让多个窗口修改同一目录。WS20 只能在所有目标工作包合并到集成分支后开始。

## 3. 分支和工作树约定

执行时，每个子窗口先使用 `using-git-worktrees` 技能创建独立工作树。推荐分支和目录：

| 工作包 | 分支 | 工作树目录 |
|---|---|---|
| 集成 | `codex/integration` | `D:\AI视频聚合平台-integration` |
| WS00 | `codex/ws00-foundation` | `D:\AI视频聚合平台-worktrees\ws00` |
| WS09 | `codex/ws09-edge-gateway` | `D:\AI视频聚合平台-worktrees\ws09` |
| WS10 | `codex/ws10-identity-iam` | `D:\AI视频聚合平台-worktrees\ws10` |
| WS11 | `codex/ws11-catalog-routing` | `D:\AI视频聚合平台-worktrees\ws11` |
| WS12 | `codex/ws12-wallet-payment` | `D:\AI视频聚合平台-worktrees\ws12` |
| WS13 | `codex/ws13-generation-provider` | `D:\AI视频聚合平台-worktrees\ws13` |
| WS14 | `codex/ws14-supporting-services` | `D:\AI视频聚合平台-worktrees\ws14` |
| WS15 | `codex/ws15-user-web` | `D:\AI视频聚合平台-worktrees\ws15` |
| WS16 | `codex/ws16-admin-web` | `D:\AI视频聚合平台-worktrees\ws16` |
| WS17 | `codex/ws17-reporting-observability` | `D:\AI视频聚合平台-worktrees\ws17` |
| WS18 | `codex/ws18-infrastructure` | `D:\AI视频聚合平台-worktrees\ws18` |
| WS20 | `codex/ws20-integration-hardening` | `D:\AI视频聚合平台-worktrees\ws20` |

每个窗口只提交自己的分支，不直接向 `main` 提交。集成窗口按依赖顺序将已通过评审的分支合并到 `codex/integration`，全部上线门禁通过后再决定如何合入 `main`。

## 4. 文件所有权

并行期间严格执行以下所有权。未列出的共享文件只能由 WS00 或 WS20 修改。

| 工作包 | 独占目录/文件 |
|---|---|
| WS00 | 根配置、初始 `pnpm-lock.yaml`、`packages/contracts/**`、`packages/capability-schema/**`、`packages/provider-sdk/**`、`packages/service-kit/**`、`packages/testkit/**`、`packages/ui/**`、`infra/local/**`、`.github/workflows/ci.yml` |
| WS09 | `services/edge-gateway/**`、`docs/runbooks/edge-gateway.md` |
| WS10 | `services/identity-service/**`、`services/iam-service/**`、`docs/runbooks/identity-iam.md` |
| WS11 | `services/catalog-service/**`、`services/quote-routing-service/**`、`docs/runbooks/catalog-routing.md` |
| WS12 | `services/wallet-service/**`、`services/payment-service/**`、`docs/runbooks/wallet-payment.md` |
| WS13 | `services/generation-service/**`、`services/provider-runtime/**`、`providers/mock-provider/**`、`docs/runbooks/generation-provider.md` |
| WS14 | `services/asset-service/**`、`services/operations-service/**`、`services/notification-service/**`、`docs/runbooks/supporting-services.md` |
| WS15 | `apps/user-web/**`、`docs/product/user-web.md` |
| WS16 | `apps/admin-web/**`、`docs/product/admin-web.md` |
| WS17 | `services/reporting-service/**`、`packages/observability/**`、`docs/runbooks/observability.md` |
| WS18 | `infra/terraform/**`、`infra/helm/**`、`.github/workflows/deploy-*.yml`、`docs/runbooks/deployment.md` |
| WS20 | `tests/e2e/**`、`tests/load/**`、`tests/chaos/**`、`docs/reports/**`、合并后的最终 `pnpm-lock.yaml`；经评审后可修复跨目录集成问题 |

### 并行冲突规则

1. Wave 1 窗口不得修改 `packages/contracts`。发现契约缺陷时，在自己的分支新增 `docs/contract-change-requests/WSxx-<name>.md`，由集成窗口集中处理。
2. WS00 负责生成并提交初始 `pnpm-lock.yaml`；Wave 1 窗口可以修改自己目录内的 `package.json`，但使用 `pnpm install --lockfile=false`，不得修改或提交 `pnpm-lock.yaml`；WS20 在全部分支合并后重新生成并提交最终锁文件。
3. 根 `package.json`、`pnpm-workspace.yaml`、`turbo.json`、TypeScript/ESLint/Prettier 配置由 WS00 独占。
4. UI 窗口不得修改 `packages/ui`；缺少的通用组件先在各自应用内实现，WS20 再判断是否抽取。
5. 领域服务不得读取其他服务数据库。跨域需求只能使用冻结契约中的 HTTP 命令或领域事件。

## 5. 冻结契约

WS00 完成后，以下契约视为 Wave 1 的只读输入：

- 标准 API 错误：`packages/contracts/src/common/error.ts`
- 幂等和 Trace 头：`packages/contracts/src/common/headers.ts`
- 事件信封：`packages/contracts/src/common/event-envelope.ts`
- 身份与 IAM：`packages/contracts/src/identity/**`、`iam/**`
- 模型和能力：`packages/contracts/src/catalog/**`
- 报价与路由：`packages/contracts/src/routing/**`
- 钱包与支付：`packages/contracts/src/wallet/**`、`payment/**`
- 生成任务：`packages/contracts/src/generation/**`
- Provider 运行时：`packages/contracts/src/provider/**`
- 资产、运营和通知：`packages/contracts/src/asset/**`、`operations/**`、`notification/**`
- 报表：`packages/contracts/src/reporting/**`

所有 JSON 中的点数使用十进制字符串，数据库内部使用 `BIGINT`。所有时间使用 UTC ISO 8601 字符串。所有 ID 使用 UUID v7 字符串。所有金额使用最小货币单位整数和 ISO 4217 币种，不使用浮点数。

## 6. 设计规范追踪矩阵

该矩阵用于判断需求是否真正落入实施范围。某一行涉及多个工作包时，以第一个工作包拥有领域实现、WS20 拥有跨域验收为原则。

| 设计规范范围 | 主责工作包 | 验收证据 |
|---|---|---|
| 产品边界、用户端与运营后台 | WS15、WS16、WS20 | 页面路由清单、Playwright 关键旅程、越界功能缺失检查 |
| 生产级服务拆分、Gateway、同步/异步通信 | WS00、WS09、WS13、WS18 | 冻结契约、网关集成测试、RocketMQ 事件测试、部署拓扑 |
| 手机号认证、后台 MFA、自定义角色权限 | WS10、WS09、WS16、WS20 | 登录/MFA/RBAC/数据范围测试和越权安全测试 |
| 模型目录、动态能力、报价和智能/专业路由 | WS00、WS11、WS15、WS16 | Schema 校验、报价快照、路由解释、运营配置旅程 |
| 钱包、充值、微信支付、冻结/结算/退款、发票 | WS12、WS15、WS16、WS20 | 账本不变量、回调幂等、对账、失败退款、发票流程 |
| 生成任务、供应商运行时、故障切换 | WS13、WS11、WS20 | 状态机、Mock Provider 准入、乱序/重复回调、故障注入 |
| 素材、作品、工单、公告、通知、运营设置 | WS14、WS15、WS16、WS20 | OSS 安全测试、用户旅程、后台运营旅程、通知重试 |
| 报表、审计、可观测性、SLO | WS17、WS09–WS14、WS20 | 指标准确性测试、审计事件、Dashboard/Alert、SLO 报告 |
| 阿里云部署、弹性、备份、灾备、成本边界 | WS18、WS20 | Terraform/Helm 验证、扩缩容、恢复/回滚演练和账单告警 |
| 安全、性能、发布和上线门禁 | WS20（所有工作包配合） | E2E、200 并发压测、DAST/依赖扫描、Go/No-Go 报告 |
| 真实 AI 视频供应商接入 | WS13 的准入框架；供应商独立后续 WS | 官方文档映射、沙箱任务、计费核验、至少一个适配器通过准入 |

## 7. 每个子窗口的启动提示

打开子窗口后，把对应计划文件路径和以下提示一起交给 Codex：

```text
在 D 盘项目的独立 worktree 中执行指定 WS 计划。先完整阅读：
1. docs/superpowers/specs/2026-08-28-ai-video-aggregation-platform-design.md
2. docs/superpowers/plans/2026-08-28-00-program-execution-plan.md
3. 对应的 WS 实施计划

严格遵守文件所有权和冻结契约。使用 test-driven-development，先写失败测试；每个任务完成后运行计划中的验证命令并提交。WS00 按计划提交初始 pnpm-lock.yaml；Wave 1 不得修改或提交该文件；WS20 负责最终更新。不要修改其他工作包目录。遇到契约缺陷时写 contract-change-request，不要直接修改共享契约。
```

## 8. Wave 1 合并顺序

Wave 1 的分支在自身范围内互相独立，完成顺序不限。推荐合并顺序用于尽早暴露核心风险：

1. WS12 钱包/支付。
2. WS11 目录/报价/路由。
3. WS13 生成/Provider。
4. WS09 边缘网关。
5. WS10 身份/IAM。
6. WS14 资产/运营/通知。
7. WS17 报表/可观测性。
8. WS15 用户端。
9. WS16 管理后台。
10. WS18 基础设施。

每次合并后执行：

```powershell
corepack pnpm install
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

期望：所有命令退出码为 0。某个分支失败时先修复或回退该分支，不继续叠加后续分支。

## 9. 工作包完成定义

每个 Wave 1 工作包必须满足：

- 计划内复选框全部完成。
- 单元和集成测试通过。
- 自己服务的迁移可以在空库执行，也可以从前一迁移升级。
- OpenAPI 或事件契约与冻结契约一致。
- 日志包含 Trace ID，不记录密钥、验证码和支付敏感信息。
- 健康检查、就绪检查和 Prometheus 指标端点可用。
- Docker 镜像以非 root 用户运行。
- Runbook 包含启动、常见告警、恢复和回滚步骤。
- 分支工作区干净，并有按任务拆分的提交。

## 10. 真实供应商接入边界

当前计划实现 Mock Provider、统一 Provider SDK 和适配器准入套件。由于真实供应商文档和密钥尚未提供，本计划不虚构任何真实请求字段。用户提供某个供应商网址、文档、计费规则和测试密钥后，为该供应商生成独立实施计划和独立分支；其上线必须通过 WS13 建立的准入套件。WS20 的正式上线门禁要求至少一个真实供应商适配器通过，但平台核心集成测试不等待供应商文档。

## 11. Program 完成定义

WS20 必须证明：

- 手机号登录、后台 MFA/RBAC、测试充值、点数冻结、生成成功、生成失败退款、作品入库和通知形成完整闭环。
- 重复提交、重复支付回调和重复供应商回调不产生重复账务效果。
- Mock Provider 的成功、失败、超时、429、5xx、回调丢失和乱序场景全部通过。
- 1 万注册用户模型和 200 并发异步任务的压测指标达标。
- Worker/Pod 故障、消息重复、RDS 切换和版本回滚演练通过。
- 钱包和支付对账差异为零。
- 所有 P0/P1 缺陷关闭。
- 部署、监控、恢复、对账和回滚文档可执行。

完成后由主窗口运行 `verification-before-completion`，再提供合入 `main`、创建 PR 或继续保留集成分支的选择。
