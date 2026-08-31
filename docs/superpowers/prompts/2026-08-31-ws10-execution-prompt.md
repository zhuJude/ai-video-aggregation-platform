# WS10 Identity and IAM Execution Prompt

```text
你负责 Wave 1 的 WS10 身份与 IAM，直接实施，不要重新规划。

源仓库：D:\AI视频聚合平台
基础分支：codex/integration
目标分支：codex/ws10-identity-iam
目标 Worktree：D:\AI视频聚合平台-worktrees\ws10
独占范围：services/identity-service/**、services/iam-service/**、docs/runbooks/identity-iam.md

完整阅读设计规范、总执行计划、docs/superpowers/prompts/2026-08-31-wave1-common-execution-contract.md，以及 docs/superpowers/plans/2026-08-28-ws10-identity-iam-implementation.md。

严格执行共同执行契约，依次完成：身份持久化/手机号值对象；短信验证码和限流；用户会话与 Refresh Rotation；管理员 MFA；自定义 RBAC/数据范围/审计；生产入口、健康、指标和 Runbook。必须覆盖验证码哈希与过期、重放防护、Refresh Family 复用撤销、MFA 恢复码、超级管理员保护、手机号变更和账户注销事件。阿里云短信只通过端口和 KMS 引用接入，不提交密钥。

完成门禁：
corepack pnpm --filter @repo/identity-service test:coverage
corepack pnpm --filter @repo/iam-service test:coverage
corepack pnpm --filter @repo/identity-service build
corepack pnpm --filter @repo/iam-service build
git diff --exit-code codex/integration...HEAD -- pnpm-lock.yaml packages/contracts packages/ui
git status --short

全部通过后报告，不要自行合并。
```
