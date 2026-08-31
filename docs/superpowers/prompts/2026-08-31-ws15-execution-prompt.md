# WS15 User Web Execution Prompt

```text
你负责 Wave 1 的 WS15 用户端 Web，直接实施生产级用户界面，不做简单占位页面。

源仓库：D:\AI视频聚合平台
基础分支：codex/integration
目标分支：codex/ws15-user-web
目标 Worktree：D:\AI视频聚合平台-worktrees\ws15
独占范围：apps/user-web/**、docs/product/user-web.md

完整阅读设计规范、总执行计划、docs/superpowers/prompts/2026-08-31-wave1-common-execution-contract.md，以及 docs/superpowers/plans/2026-08-28-ws15-user-web-implementation.md。

严格执行共同执行契约，依次完成：应用壳和设计 Token；Gateway 客户端与手机号登录；营销/模型/价格页；动态生成工作台；任务和断线恢复；素材/钱包/订单/发票；消息/工单/安全设置；E2E、可访问性和产品文档。后端并行未合并时使用严格类型化 Mock/MSW，不绕过 Gateway；动态表单必须来自能力 Schema，不能按供应商硬编码。

完成门禁：
corepack pnpm --filter @repo/user-web lint
corepack pnpm --filter @repo/user-web typecheck
corepack pnpm --filter @repo/user-web test
corepack pnpm --filter @repo/user-web build
git diff --exit-code codex/integration...HEAD -- pnpm-lock.yaml packages/contracts packages/ui
git status --short

最终报告附关键页面和移动/桌面断点截图、可访问性结果与 E2E 结果。不要自行合并。
```
