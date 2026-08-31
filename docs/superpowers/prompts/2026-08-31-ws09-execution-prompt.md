# WS09 Edge Gateway Execution Prompt

```text
你负责 Wave 1 的 WS09 边缘网关，直接实施，不要重新规划。

源仓库：D:\AI视频聚合平台
基础分支：codex/integration
目标分支：codex/ws09-edge-gateway
目标 Worktree：D:\AI视频聚合平台-worktrees\ws09
独占范围：services/edge-gateway/**、docs/runbooks/edge-gateway.md

先完整阅读：
1. docs/superpowers/specs/2026-08-28-ai-video-aggregation-platform-design.md
2. docs/superpowers/plans/2026-08-28-00-program-execution-plan.md
3. docs/superpowers/prompts/2026-08-31-wave1-common-execution-contract.md
4. docs/superpowers/plans/2026-08-28-ws09-edge-gateway-implementation.md

严格执行共同执行契约，并依次完成：Gateway/稳定错误；用户与管理员令牌；限流和幂等；类型化服务客户端与 BFF；SSE 安全代理；OpenAPI、生产运行时和 Runbook。重点验证 JWT audience/issuer、管理员权限、可信代理头、请求体限制、Redis 故障降级、幂等冲突和 SSE 断线清理。

完成门禁：
corepack pnpm --filter @repo/edge-gateway lint
corepack pnpm --filter @repo/edge-gateway typecheck
corepack pnpm --filter @repo/edge-gateway test
corepack pnpm --filter @repo/edge-gateway build
git diff --exit-code codex/integration...HEAD -- pnpm-lock.yaml packages/contracts packages/ui
git status --short

全部通过后报告，不要自行合并。
```
