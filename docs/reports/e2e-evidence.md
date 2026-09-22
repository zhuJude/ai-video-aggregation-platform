# WS20 E2E 与业务闭环证据

日期：2026-09-22  
总体结论：**PARTIAL / NO-GO**

## 通过项

命令：

```text
corepack pnpm exec playwright test tests/e2e/user-commercial-flow.spec.ts tests/e2e/user-failure-refund.spec.ts tests/e2e/finance-integrity.spec.ts tests/e2e/security-boundaries.spec.ts --workers=1
```

结果：4/4 PASS，耗时约 2.6 分钟。

覆盖：

- 用户商业成功路径：一次结算、钱包点数守恒。
- Provider 失败：一次释放/退款，无重复效果。
- Wallet/Payment/Provider callback：账本 property、对账、回调幂等与 circuit integration。
- Edge/IAM/Payment/Provider/Wallet 安全边界组件套件。

这些是 Playwright 聚合入口驱动现有领域/集成测试，不等同于完整 Compose 栈的浏览器端到端证明。

后台浏览器链路最终命令与结果：

```text
corepack pnpm exec playwright test tests/e2e/admin-operations.spec.ts
PASS: 1/1，耗时约 1.8 分钟
```

覆盖：MFA 登录、RBAC 权限边界、运营操作、财务控制与双人审批。为使 secure cookie 与浏览器行为一致，测试仅在执行期间生成临时自签名证书并以 HTTPS 启动 Next.js，结束时删除证书；浏览器优先使用 Playwright 配置，缺失时自动发现系统 Chrome。四张验收截图与 HTML 报告位于 `apps/admin-web/output/playwright/`。

根 Playwright 配置把发现范围固定为 `tests/e2e/**/*.spec.ts`，排除由 Vitest 执行的 `contracts.spec.ts`；`--list` 共发现 6 个文件、25 个测试，避免意外扫描整个 monorepo。

## 完整栈 E2E 阻断

基础设施容器运行时执行：

```text
corepack pnpm exec playwright test tests/e2e/stack-health.spec.ts --reporter=line
4 PASS / 16 FAIL
```

PostgreSQL、Redis、RocketMQ NameServer、MinIO 四项 TCP 检查通过；用户端、管理端与 14 个应用服务均因镜像未完成构建而返回 `ECONNREFUSED`。因此隔离式用户/后台闭环已通过，但完整 Compose 栈浏览器/API 端到端门禁仍为 **NO-GO**。
