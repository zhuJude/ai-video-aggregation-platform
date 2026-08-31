# WS17 Reporting and Observability Execution Prompt

```text
你负责 Wave 1 的 WS17 报表与可观测性，直接实施，不要重新规划。

源仓库：D:\AI视频聚合平台
基础分支：codex/integration
目标分支：codex/ws17-reporting-observability
目标 Worktree：D:\AI视频聚合平台-worktrees\ws17
独占范围：services/reporting-service/**、packages/observability/**、docs/runbooks/observability.md

完整阅读设计规范、总执行计划、docs/superpowers/prompts/2026-08-31-wave1-common-execution-contract.md，以及 docs/superpowers/plans/2026-08-28-ws17-reporting-observability-implementation.md。

严格执行共同执行契约，依次完成：低基数观测原语；幂等报表投影；报表 API/导出；Dashboard/告警；生产运行时和 Runbook。财务/任务指标必须能与源事件对账；重复事件不得重复累计；标签不得包含 userId/taskId 等高基数值；日志不得记录手机号、验证码、令牌或密钥。

完成门禁：
corepack pnpm --filter @repo/observability lint
corepack pnpm --filter @repo/observability test
corepack pnpm --filter @repo/reporting-service test
corepack pnpm --filter @repo/reporting-service build
git diff --exit-code codex/integration...HEAD -- pnpm-lock.yaml packages/contracts packages/ui
git status --short

全部通过后报告，不要自行合并。
```
