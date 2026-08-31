# WS00 Review Remediation Prompt

将下面整段复制到原 WS00 子窗口：

```text
继续负责 WS00，但本轮只处理主窗口代码审查发现的阻断项。不要开始 Wave 1，不要合并到 main。

仓库：D:\AI视频聚合平台
现有 Worktree：D:\AI视频聚合平台-worktrees\ws00
现有分支：codex/ws00-foundation
当前已审查提交：19a6b57ab8665f4440160fa402eacb97aba58026

开始时使用 systematic-debugging 和 test-driven-development；先确认 Worktree/分支/状态正确且干净。完整阅读设计规范、总执行计划和 WS00 计划，然后完成以下返修：

1. 修复依赖安全阻断。
   - packages/service-kit/package.json 中 Fastify 5.6.2 命中 High 漏洞。
   - 升级到当前已修复版本 5.12.1，并更新 pnpm-lock.yaml。
   - 运行 corepack pnpm audit --audit-level high，要求退出码 0，High/Critical 均为 0。

2. 收紧冻结契约标量。
   - 为 packages/contracts/src/common/scalars.ts 先增加失败测试。
   - UuidSchema 必须拒绝非 UUID v7；使用 Zod 4 的 UUID v7 校验能力。
   - UtcDateTimeSchema 必须只接受 UTC 的 Z 结尾时间，拒绝 +08:00 等偏移时间。
   - 保留点数和金额禁止浮点数的约束。

3. 修复公共错误映射。
   - 为 PostgreSQL 风格 code=23505 的未知异常先增加失败测试。
   - toApiError 不得返回不符合 ApiErrorSchema 的 code，也不得把数据库/网络内部错误码当成公开业务错误码。
   - 建立显式公开错误识别机制或严格白名单；未知错误统一映射 INTERNAL_ERROR。
   - 增加测试证明返回值始终可以被 ApiErrorSchema.parse。

4. 把根级冒烟测试纳入常规质量链路。
   - package.json 增加根级测试脚本，执行 scripts/verify-workspace.test.ts 和 scripts/validate-compose.test.ts。
   - pnpm verify 必须包含该根级测试，CI 也必须实际执行。
   - CI 增加 docker compose -f infra/local/compose.yaml config --quiet，以便在有 Docker 的 runner 上验证 Compose。

5. 记录 TypeScript 版本偏差。
   - 计划写 TypeScript 7.0.2，当前实现为 5.9.3。
   - 验证与 ESLint/NestJS 的兼容性；能安全升级则升级，不能升级则在提交说明和最终报告中给出可复现原因，不得静默偏离。

每个问题先做红灯测试，再实现，再运行针对性测试。可以拆为多个小提交，不得改动 WS00 所有权以外的业务目录。

最终强制验证：

corepack pnpm exec turbo run lint typecheck test build --force
corepack pnpm dlx vitest@4.1.11 run scripts/verify-workspace.test.ts scripts/validate-compose.test.ts
corepack pnpm audit --audit-level high
docker compose -f infra/local/compose.yaml config --quiet
git diff --check main...HEAD
git status --short

若本机仍没有 Docker，明确报告唯一未执行的 Docker 命令，但必须保证 CI 已加入该命令；不要伪造通过结果。

完成后使用 verification-before-completion。不要自行合并。最终报告提交哈希、测试数量、审计结果、Docker 结果、版本偏差结论以及是否满足 Wave 1 门禁。
```
