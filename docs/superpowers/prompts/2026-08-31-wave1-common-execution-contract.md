# Wave 1 Common Execution Contract

WS09–WS18 每个独立窗口都必须遵守本文件。

## 启动前置门禁

1. 源仓库是 `D:\AI视频聚合平台`。
2. `codex/integration` 必须已经存在，并且包含主窗口验收通过的 `codex/ws00-foundation`。
3. 如果 `git merge-base --is-ancestor codex/ws00-foundation codex/integration` 返回非 0，停止并报告，不得从 `main` 或旧 WS00 提交创建分支。
4. 使用 `using-git-worktrees` 检测现有隔离环境；优先使用平台原生 Worktree 能力，没有时才使用 Git fallback。
5. 新分支必须从 `codex/integration` 创建，使用各工作包指定的分支和绝对 Worktree 路径。
6. 进入 Worktree 后运行：

```powershell
corepack pnpm install --lockfile=false
corepack pnpm verify
corepack pnpm audit --audit-level high
git status --short
```

要求基线质量链路通过、High/Critical 漏洞为 0、状态干净。任一失败立即停止并报告，不得带病开发。

## 实施纪律

- 完整阅读设计规范、总执行计划和本工作包实施计划。
- 使用 `executing-plans` 和 `test-driven-development`，严格按 Task 顺序执行。
- 每个行为先写失败测试并确认按预期失败，再写最小生产实现，再重跑验证。
- 不做 MVP 式空实现，不留下未完成标记、假接口、硬编码密钥或绕过安全/财务规则的代码。
- 只能修改本工作包独占目录和自己目录中的 `package.json`。
- 安装依赖使用 `corepack pnpm install --lockfile=false`；不得修改或提交 `pnpm-lock.yaml`。
- 不得修改根配置、`packages/contracts/**`、`packages/ui/**` 或其他工作包目录。
- 契约不足时新增 `docs/contract-change-requests/WSxx-contract-change.md`（将 WSxx 替换为当前工作包编号），不得直接改冻结契约。
- 每个 Task 完成并验证后独立提交；不得压成一个巨型提交。
- 遇到外部密钥、商户号、短信签名或真实供应商文档缺失时使用明确的端口、Mock 和 KMS 引用，不虚构真实凭证。
- 完成后使用 `verification-before-completion` 和 `finishing-a-development-branch`，但不得自行合并到 `codex/integration` 或 `main`。

## 最终报告

必须列出 Worktree、分支、任务状态、提交哈希、测试/覆盖率/构建结果、数据库迁移结果、锁文件和共享目录差异检查、未解决风险及是否建议合并。
