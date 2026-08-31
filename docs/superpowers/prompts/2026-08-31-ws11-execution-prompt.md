# WS11 Catalog, Quote and Routing Execution Prompt

```text
你负责 Wave 1 的 WS11 模型目录、报价和路由，直接实施，不要重新规划。

源仓库：D:\AI视频聚合平台
基础分支：codex/integration
目标分支：codex/ws11-catalog-routing
目标 Worktree：D:\AI视频聚合平台-worktrees\ws11
独占范围：services/catalog-service/**、services/quote-routing-service/**、docs/runbooks/catalog-routing.md

完整阅读设计规范、总执行计划、docs/superpowers/prompts/2026-08-31-wave1-common-execution-contract.md，以及 docs/superpowers/plans/2026-08-28-ws11-catalog-routing-implementation.md。

严格执行共同执行契约，依次完成：供应商/模型/能力版本化；目录管理和公开查询；纯整数定价；确定性智能路由；报价快照和专业模式；健康快照、毛利保护和 Runbook。能力发布前必须用 CapabilityDocumentSchema、AJV、UI 字段引用和 costDimensions 做完整校验；定价不得使用浮点数；同输入必须产生确定性报价和可解释路由。

完成门禁：
corepack pnpm --filter @repo/catalog-service test
corepack pnpm --filter @repo/quote-routing-service test
corepack pnpm --filter @repo/catalog-service build
corepack pnpm --filter @repo/quote-routing-service build
git diff --exit-code codex/integration...HEAD -- pnpm-lock.yaml packages/contracts packages/ui
git status --short

全部通过后报告，不要自行合并。
```
