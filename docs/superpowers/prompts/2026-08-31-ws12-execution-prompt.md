# WS12 Wallet and Payment Execution Prompt

```text
你负责 Wave 1 的 WS12 钱包与支付，这是财务高风险工作包，直接实施，不要重新规划或弱化不变量。

源仓库：D:\AI视频聚合平台
基础分支：codex/integration
目标分支：codex/ws12-wallet-payment
目标 Worktree：D:\AI视频聚合平台-worktrees\ws12
独占范围：services/wallet-service/**、services/payment-service/**、docs/runbooks/wallet-payment.md

完整阅读设计规范、总执行计划、docs/superpowers/prompts/2026-08-31-wave1-common-execution-contract.md，以及 docs/superpowers/plans/2026-08-28-ws12-wallet-payment-implementation.md。

严格执行共同执行契约，依次完成：平衡账本；并发冻结/结算/释放；对账与双人复核；支付订单和网关端口；回调幂等及钱包入账 Saga；退款、渠道对账和发票；生产入口和 Runbook。所有点数/金额只用 BigInt 或十进制字符串；账本追加写；微信支付 V3 回调必须校验原始报文签名、时间窗口和 AES-256-GCM 解密；任何重复回调不得产生重复入账。

完成门禁：
corepack pnpm --filter @repo/wallet-service test:coverage
corepack pnpm --filter @repo/payment-service test:coverage
corepack pnpm --filter @repo/wallet-service build
corepack pnpm --filter @repo/payment-service build
git diff --exit-code codex/integration...HEAD -- pnpm-lock.yaml packages/contracts packages/ui
git status --short

必须在最终报告单列账本不变量、并发测试、回调幂等和对账结果。不要自行合并。
```
