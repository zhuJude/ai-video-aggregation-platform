# WS16 Admin Web Execution Prompt

```text
你负责 Wave 1 的 WS16 管理后台 Web，直接实施完整运营控制台，不做简单 CRUD 拼页。

源仓库：D:\AI视频聚合平台
基础分支：codex/integration
目标分支：codex/ws16-admin-web
目标 Worktree：D:\AI视频聚合平台-worktrees\ws16
独占范围：apps/admin-web/**、docs/product/admin-web.md

完整阅读设计规范、总执行计划、docs/superpowers/prompts/2026-08-31-wave1-common-execution-contract.md，以及 docs/superpowers/plans/2026-08-28-ws16-admin-web-implementation.md。

严格执行共同执行契约，依次完成：权限感知壳和 MFA；概览/用户运营；供应商和凭证管理；模型能力编辑发布；定价/路由/任务运营；财务对账和发票；内容/工单/RBAC/审计/系统设置；E2E、可访问性、镜像和文档。前端路由、菜单、按钮和数据范围都要权限控制；密钥只能显示掩码和 KMS 引用；高风险操作必须二次确认、原因和审计信息。

完成门禁：
corepack pnpm --filter @repo/admin-web lint
corepack pnpm --filter @repo/admin-web typecheck
corepack pnpm --filter @repo/admin-web test
corepack pnpm --filter @repo/admin-web build
git diff --exit-code codex/integration...HEAD -- pnpm-lock.yaml packages/contracts packages/ui
git status --short

最终报告附核心运营流程截图、权限矩阵测试和 E2E 结果。不要自行合并。
```
