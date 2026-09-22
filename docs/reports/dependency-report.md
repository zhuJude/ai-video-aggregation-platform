# WS20 依赖与锁文件报告

- 生成日期：2026-09-22
- 包管理器：pnpm 11.24.0（Corepack）
- 根锁文件：`pnpm-lock.yaml`
- SHA-256：`88a95d515b97d53fbc40076843ba6fc5b9762374fa8a2b90d876bc462460f54c`
- 锁文件 importers：根项目 1 + workspace 23
- 仓库内锁文件数量：1

## 可重现性门禁

依次执行并通过：

```text
corepack pnpm install
corepack pnpm dedupe
corepack pnpm install --frozen-lockfile
```

删除了三个工作包遗留锁文件：

- `apps/user-web/pnpm-lock.yaml`
- `services/iam-service/pnpm-lock.yaml`
- `services/identity-service/pnpm-lock.yaml`

`scripts/verify-workspace.test.ts` 新增唯一根锁回归守卫，并在删除前以这三个路径稳定红灯，删除和重建后通过。

## 生产依赖审计

最终命令：

```text
corepack pnpm audit --prod --audit-level high
```

最终结果：`No known vulnerabilities found`。

| 严重性 | 数量 |
| --- | ---: |
| Critical | 0 |
| High | 0 |
| Moderate | 0 |
| Low | 0 |

审计元数据在修复前为 596 个生产/可选依赖记录，其中 9 个 High 全部由 Prisma 传递依赖链引入。没有使用 `auditConfig.ignoreCves`、审计忽略、风险接受或关闭门禁。

## Prisma 传递依赖处置

初次审计发现：

- Generation 和 Provider Runtime 仍固定 Prisma 7.2.0，带入存在公告的 Hono、`@hono/node-server`、Effect、Lodash；
- Prisma 7.10.0/7.2.0 的共同传递链带入旧版 `deepmerge-ts` 与 `mysql2`。

处置：

1. 将 `services/generation-service` 与 `services/provider-runtime` 的 `prisma`、`@prisma/client`、`@prisma/adapter-pg` 全部统一到 7.10.0；
2. 在 pnpm workspace 级别将 `deepmerge-ts` 约束到 8.0.0；
3. 将 `mysql2` 约束到 3.23.1（3.22.0 随后出现新的中危解压炸弹公告，继续升级至已修复版本）；
4. 重新生成并 dedupe 根锁，执行 frozen install、审计、lint、typecheck、两服务 522 个测试及 build。

最终 Prisma 图只有 7.10.0 系列；`@prisma/dev` 为 0.24.17，旧 7.2.0/0.17.0 传递链已消失。

## Playwright 检查

解析版本：

- `@playwright/test` 1.63.0
- `playwright` 1.63.0
- `playwright-core` 1.63.0

Playwright 未出现在最终生产审计发现中。浏览器 E2E 的实际可执行性、浏览器安装和证据记录在后续 E2E/安全任务中独立判定。

## 结论

唯一根锁、frozen install 与生产依赖 High/Critical=0 门禁均通过；最终审计为零已知漏洞。Task 3 状态：**PASS**。
