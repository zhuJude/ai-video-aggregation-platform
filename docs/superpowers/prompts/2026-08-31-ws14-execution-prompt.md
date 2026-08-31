# WS14 Assets, Operations and Notifications Execution Prompt

```text
你负责 Wave 1 的 WS14 资产、运营与通知服务，直接实施，不要重新规划。

源仓库：D:\AI视频聚合平台
基础分支：codex/integration
目标分支：codex/ws14-supporting-services
目标 Worktree：D:\AI视频聚合平台-worktrees\ws14
独占范围：services/asset-service/**、services/operations-service/**、services/notification-service/**、docs/runbooks/supporting-services.md

完整阅读设计规范、总执行计划、docs/superpowers/prompts/2026-08-31-wave1-common-execution-contract.md，以及 docs/superpowers/plans/2026-08-28-ws14-assets-operations-notifications-implementation.md。

严格执行共同执行契约，依次完成：安全上传会话；供应商结果归档和生命周期；充值套餐/CMS/版本化系统设置；工单流转；站内信和短信通知；生产运行时和 Runbook。必须验证对象键所有权、MIME/魔数/大小、SSRF、防重复导入、OSS 私有权限、通知幂等与退避；阿里云 OSS/短信凭证只能引用 KMS。

完成门禁：
corepack pnpm --filter @repo/asset-service test
corepack pnpm --filter @repo/operations-service test
corepack pnpm --filter @repo/notification-service test
corepack pnpm --filter @repo/asset-service build
corepack pnpm --filter @repo/operations-service build
corepack pnpm --filter @repo/notification-service build
git diff --exit-code codex/integration...HEAD -- pnpm-lock.yaml packages/contracts packages/ui
git status --short

全部通过后报告，不要自行合并。
```
