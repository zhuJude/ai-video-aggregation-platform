# WS13 Generation and Provider Runtime Execution Prompt

```text
你负责 Wave 1 的 WS13 生成编排与 Provider Runtime，直接实施，不接入未提供文档的真实供应商。

源仓库：D:\AI视频聚合平台
基础分支：codex/integration
目标分支：codex/ws13-generation-provider
目标 Worktree：D:\AI视频聚合平台-worktrees\ws13
独占范围：services/generation-service/**、services/provider-runtime/**、providers/mock-provider/**、docs/runbooks/generation-provider.md

完整阅读设计规范、总执行计划、docs/superpowers/prompts/2026-08-31-wave1-common-execution-contract.md，以及 docs/superpowers/plans/2026-08-28-ws13-generation-provider-implementation.md。

严格执行共同执行契约，依次完成：任务状态机；幂等创建 Saga；确定性 Mock Provider；执行与重试策略；回调/轮询/熔断；成功、失败、取消和安全切换；指标、镜像和 Runbook。必须覆盖重复/乱序回调、429、5xx、超时、回调丢失、歧义受理、失败全额释放点数和不可安全切换场景。真实供应商字段与密钥不得虚构。

完成门禁：
corepack pnpm --filter @repo/generation-service test:coverage
corepack pnpm --filter @repo/provider-runtime test:coverage
corepack pnpm --filter @repo/mock-provider test
corepack pnpm --filter @repo/generation-service build
corepack pnpm --filter @repo/provider-runtime build
corepack pnpm --filter @repo/mock-provider build
git diff --exit-code codex/integration...HEAD -- pnpm-lock.yaml packages/contracts packages/ui
git status --short

全部通过后报告，不要自行合并。
```
