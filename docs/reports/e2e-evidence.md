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

## 后台 E2E 阻断

首次运行因 Playwright 1.63 浏览器二进制缺失失败；浏览器下载在 195.6 MiB 的 0% 处长时间无进展后终止。随后通过 `PLAYWRIGHT_EXECUTABLE_PATH` 使用本机 Chrome，已成功启动 Next.js 与 HTTPS fixture，但 global setup 的密码挑战返回 `CHALLENGE_INVALID`，等待“双因素验证”180 秒超时。

最终命令与结果：

```text
PLAYWRIGHT_EXECUTABLE_PATH=<system chrome>
corepack pnpm exec playwright test tests/e2e/admin-operations.spec.ts --workers=1
FAIL: MFA readiness login did not reach the TOTP screen
```

因此 MFA、RBAC、运营与双人审批的浏览器级证明为 **NO-GO**；组件/页面既有测试通过不能替代此门禁。
