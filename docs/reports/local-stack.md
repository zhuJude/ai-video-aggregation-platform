# WS20 本地完整栈证据

日期：2026-09-22  
结论：**NO-GO — 完整栈健康门禁未通过**

## 已完成

- `docker compose -f infra/local/compose.yaml -f infra/local/compose.services.yaml config --quiet`：PASS。
- Compose 已声明用户端、管理端、Gateway、Identity、IAM、Catalog、Routing、Wallet、Payment、Generation、Provider Runtime、Asset、Notification、Operations、Reporting、Mock Provider，以及 PostgreSQL、Redis、RocketMQ、MinIO、Mailpit。
- PostgreSQL 创建 12 个隔离数据库；11 组 Prisma migration 和 Reporting SQL migration 实际执行成功。
- MinIO 镜像由不存在的 Docker Hub 未来标签改为 Quay 固定摘要。
- 唯一根锁改造后，Identity/IAM Dockerfile 与 Dockerfile 专属 ignore 同步改为使用根 `pnpm-lock.yaml`。
- `scripts/local-stack.ps1` 的 `down` 保留卷；`reset` 固定项目名 `ai-video-local`，要求键入 `RESET ai-video-local`。

## 失败证据

第一次 `up` 在 `minio/mc:RELEASE.2026-07-16T15-35-03Z` 拉取失败；改为可解析摘要后通过。第二次构建遇到 Docker Hub token 超时；有界重试后基础 Node 镜像成功缓存。全量构建随后稳定暴露 Dockerfile ignore 未放行根锁，修复后 Identity/IAM 单独构建进入依赖安装。

最终阻断是 npm registry 在容器构建中持续返回 `ECONNRESET`/`UND_ERR_SOCKET`，数百个依赖多轮重试仍未完成。因镜像未全部构建，以下命令不能得到 PASS：

```text
pwsh scripts/local-stack.ps1 up
corepack pnpm exec playwright test tests/e2e/stack-health.spec.ts
```

因此没有声称服务全部 ready，也没有声称 superadmin、用户、模型和充值包已在真实数据库完成种子写入。`stack-health.spec.ts` 已存在并静态列出 16 个 HTTP 健康检查与 4 个基础设施 TCP 检查，待构建环境恢复后执行。
