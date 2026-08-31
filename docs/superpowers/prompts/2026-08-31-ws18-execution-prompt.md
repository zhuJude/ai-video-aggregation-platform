# WS18 Infrastructure and Deployment Execution Prompt

```text
你负责 Wave 1 的 WS18 阿里云基础设施与部署，直接实施可扩容、可回滚的生产基础设施代码，不创建真实云资源。

源仓库：D:\AI视频聚合平台
基础分支：codex/integration
目标分支：codex/ws18-infrastructure
目标 Worktree：D:\AI视频聚合平台-worktrees\ws18
独占范围：infra/terraform/**、infra/helm/**、.github/workflows/deploy-*.yml、docs/runbooks/deployment.md

完整阅读设计规范、总执行计划、docs/superpowers/prompts/2026-08-31-wave1-common-execution-contract.md，以及 docs/superpowers/plans/2026-08-28-ws18-infrastructure-deployment-implementation.md。

严格执行共同执行契约，依次完成：Terraform 环境布局和测试；VPC/ACK/入口；RDS/Tair/RocketMQ/OSS；KMS/RAM/ACR/可观测性；通用 Helm Chart/策略；部署工作流和回滚。不得执行 terraform apply，不得访问或改动真实阿里云资源；凭证只用变量/KMS/RAM 引用。架构必须支持当前低成本爬坡和后续水平扩容，并默认私网、最小权限、加密、备份和预算告警。

完成门禁：
terraform -chdir=infra/terraform fmt -check -recursive
terraform -chdir=infra/terraform validate
terraform -chdir=infra/terraform test
helm lint infra/helm/platform-service
pwsh infra/helm/tests/render.ps1
git diff --exit-code codex/integration...HEAD -- pnpm-lock.yaml packages/contracts packages/ui apps services
git status --short

最终报告必须确认没有执行 apply、没有创建云资源，并列出 Terraform/Helm 测试结果。不要自行合并。
```
