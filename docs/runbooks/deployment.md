# 阿里云生产部署与恢复 Runbook

## 1. 范围与安全边界

本 Runbook 适用于 WS18 定义的 staging/production 阿里云基础设施和 ACK 工作负载。仓库中的 Terraform 是声明式基础设施代码；部署工作流只校验 Terraform plan，不自动执行 apply。apply 只能由值班基础设施负责人在已审批的变更窗口内手工执行。

禁止把 AccessKey、数据库密码、支付密钥、第三方 API Key 或证书私钥写入 Git、tfvars、Terraform state、Helm values 或 Actions 日志。禁止在公网 runner 上连接 ACK；集群 API 仅私网开放，部署使用 VPC 内受控 self-hosted runner。生产只接受已扫描、已签名的 sha256 digest。禁止 apply -auto-approve、-lock=false 或未经复核的 saved plan。

## 2. 架构基线

- 两个环境使用独立 OSS state key、VPC CIDR 和 GitHub Environment。
- ACK Managed Pro 开启 Auto Mode、RRSA、审计日志、删除保护，工作负载跨两个可用区。
- RDS PostgreSQL 高可用、Tair 主从、RocketMQ Serverless 和 OSS 均仅私网访问并启用加密/备份。
- 每服务使用独立 RAM role；运行时通过 RRSA 和 Secrets Store CSI 引用 KMS，Terraform 不管理 secret payload。
- ACR EE repository 私有且禁止自动创建；release push 自动扫描，部署前 Cosign 验签。
- SLS 应用日志保留 30 天，审计和安全日志至少 180 天；ARMS 监控错误率、p95 延迟和副本可用性。
- Helm 默认非 root、只读根文件系统、丢弃全部 capabilities、PDB、HPA/KEDA 和默认拒绝 NetworkPolicy。

爬坡期使用小规格 RDS/Tair、RocketMQ Serverless、按流量计费入口和较低 HPA 下限。后续通过提高 managed service class/storage upper bound、HPA/KEDA 上限及 ACK Auto Mode 容量扩容，不改变服务接口或网络边界。

## 3. 首次启用前提

### 3.1 工具

```powershell
terraform version  # 1.13.x
helm version       # 3.21.x
kubectl version --client
aliyun version
cosign version
```

### 3.2 远程 state

由独立 bootstrap 流程预先创建：

- 私有 OSS bucket，开启版本控制、服务端加密、公共访问阻断和审批删除。
- TableStore instance/table；表主键必须是名为 LockID 的 String。
- staging/production OIDC role，仅允许访问各自 state prefix 和锁表。

这些 bootstrap 资源不能由依赖该 backend 的同一 root module 创建。

### 3.3 GitHub Environment 与 OIDC

建立 staging 和 production Environment。production 必须配置 required reviewers，禁止管理员绕过审批，并限制受保护分支。配置以下 repository/environment variables（均为资源标识，不是凭证）：

- ALICLOUD_GITHUB_OIDC_PROVIDER_ARN
- STAGING_DEPLOY_ROLE_ARN、PRODUCTION_DEPLOY_ROLE_ARN
- STAGING_ACK_CLUSTER_ID、PRODUCTION_ACK_CLUSTER_ID
- ACR_REGISTRY、ACR_INSTANCE_ID
- STAGING_SERVICE_ROLE_PREFIX、PRODUCTION_SERVICE_ROLE_PREFIX
- STAGING_HOST、PRODUCTION_RDS_INSTANCE_ID
- BUDGET_ALERTS_ACTIVE=true

OIDC trust policy必须限定 organization、repository、workflow ref 和 Environment subject；session 最长 30 分钟。不得创建供 Actions 使用的长期 AccessKey。

### 3.4 预算告警

Alibaba Cloud Provider v1.279.0 没有 Budget Management resource，因此 Terraform 只输出预算契约和 CostCenter tags。负责人必须在费用与成本中心创建并启用：

| 环境       |    月预算 | 告警阈值       | 通知对象             |
| ---------- | --------: | -------------- | -------------------- |
| staging    | CNY 1,000 | 50%、80%、100% | 平台值班             |
| production | CNY 3,000 | 50%、80%、100% | 平台值班、财务负责人 |

启用后才可设置 BUDGET_ALERTS_ACTIVE=true。每月检查 CostCenter tag 覆盖率、Serverless 峰值、跨地域流量、SLS 保存量和闲置公网 IP。

## 4. Terraform 计划与人工应用

示例中的 bucket、endpoint 通过受控环境变量提供；OIDC 注入短期 STS 凭证。

### 4.1 Staging

```powershell
terraform -chdir=infra/terraform/environments/staging init -reconfigure `
  -backend-config="bucket=$env:TF_STATE_BUCKET" `
  -backend-config="region=cn-hangzhou" `
  -backend-config="tablestore_endpoint=$env:TF_LOCK_ENDPOINT" `
  -backend-config="tablestore_table=$env:TF_LOCK_TABLE"
terraform -chdir=infra/terraform/environments/staging plan `
  -input=false -lock-timeout=10m -out=staging.tfplan
terraform -chdir=infra/terraform/environments/staging show -no-color staging.tfplan |
  Set-Content staging-plan.txt
Get-FileHash staging.tfplan -Algorithm SHA256
```

复核区域、VPC CIDR、资源数量、destroy/replace 和预算输出。审批后由基础设施负责人手工执行：

```powershell
terraform -chdir=infra/terraform/environments/staging apply `
  -input=false -lock-timeout=10m staging.tfplan
```

### 4.2 Production

```powershell
terraform -chdir=infra/terraform/environments/production init -reconfigure `
  -backend-config="bucket=$env:TF_STATE_BUCKET" `
  -backend-config="region=cn-hangzhou" `
  -backend-config="tablestore_endpoint=$env:TF_LOCK_ENDPOINT" `
  -backend-config="tablestore_table=$env:TF_LOCK_TABLE"
terraform -chdir=infra/terraform/environments/production plan `
  -input=false -lock-timeout=10m -out=production.tfplan
terraform -chdir=infra/terraform/environments/production show -no-color production.tfplan |
  Set-Content production-plan.txt
Get-FileHash production.tfplan -Algorithm SHA256
```

将 production.tfplan 和 production-plan.txt 作为 terraform-plan-production artifact 上传，记录 run ID 和 SHA-256。必须双人复核，无未解释的 destroy/delete/replace，且备份与预算为绿色。然后由负责人在维护窗口手工执行：

```powershell
terraform -chdir=infra/terraform/environments/production apply `
  -input=false -lock-timeout=10m production.tfplan
```

保存 apply 输出、state serial、变更单和审批记录。不得重新生成 plan 后沿用旧审批。

## 5. DNS、证书与入口

1. 在证书服务导入/签发证书；Terraform 只接收 certificate resource ID，不接收私钥。
2. 确认 ALB 为 StandardWithWaf、双可用区、HTTPS listener 和严格 TLS 1.2+ policy。
3. 用临时 hostname 检查健康、WAF、Host 路由和证书链。
4. 将用户、管理端和 API DNS 指向 ALB DNS name，TTL 先设 60 秒。
5. 管理端域名另启用身份网关/IP allowlist；稳定 24 小时后再提高 TTL。

## 6. KMS Secret 创建与轮换

Terraform 只创建 CMK、RRSA role 和 exact secret ARN 契约，不创建 secret payload，因为 payload 会进入 state。

首次创建：

1. 隔离 bootstrap Job 使用专用 RRSA role，从批准的密码生成器/支付平台读取一次性输入。
2. Job 调用 KMS Secret Manager 创建 ai-video-env/service secret；payload 从 stdin/内存传入，不出现在参数或日志。
3. 服务通过 CSI 和独立 RRSA role 读取；验证其他 service account 被拒绝。
4. 删除 Job 和临时输入，保留 ActionTrail。

轮换时写入 AWSPENDING，在单个 canary pod 验证，再切 AWSCURRENT 并滚动重启。观察错误率 30 分钟后撤销旧版本；数据库先创建新用户/权限再撤销旧用户。CMK 每 30 天自动轮换，禁止关闭删除保护。

## 7. 数据库迁移

所有 schema 变更遵守 expand/contract：

1. 先备份并验证可恢复。
2. workflow 用应用同一 digest 运行 /app/bin/migrate up --expand-only。
3. 新旧版本必须同时兼容扩展后 schema；先加列/表/索引，不删除或重命名旧字段。
4. 应用 100% 稳定且旧版本不再运行后，单独窗口执行 contract migration。
5. Job 使用服务 RRSA、非 root、只读根文件系统和最短 TTL，不在 manifest 注入密码。

## 8. Staging 部署

deploy-staging.yml 只在 ci 对 codex/integration 成功后触发：

1. checkout CI 已验证 SHA，GitHub OIDC 换取 staging 短期 role。
2. 构建带 SBOM/provenance 的镜像并 push 私有 ACR；扫描链阻断高危漏洞。
3. Cosign keyless 签名并记录 digest manifest。
4. 运行 expand migration。
5. Helm --atomic --wait 按 digest 部署，检查 rollout 和 smoke；失败自动 helm rollback。

生产审批必须引用同一 commit/digest，禁止重新构建。

## 9. Production 10/50/100 灰度

手工触发 deploy-production.yml，提供 service、commit SHA、digest、Ingress host/path、Terraform plan run/checksum 和 RDS backup ID。Environment reviewer 批准后：

1. 校验 commit/digest、预算和 plan checksum；拒绝含 destroy/delete 的 plan。
2. OIDC 访问 ACR/ACK，Cosign 验证 staging workflow 签名。
3. 查询 RDS backup 状态为 Success，再运行 expand migration。
4. 部署独立 service-canary release 和 ALB canary Ingress。
5. 依次把 alb.ingress.kubernetes.io/canary-weight 设为 10、50、100；每档 rollout/smoke 后观察 300 秒。
6. 100% 通过后以同一 digest 更新 stable release，再删除 canary。

每档检查 5xx 不高于 1% 且不超过基线两倍；p95 不高于 2 秒且不超过基线 20%；pod restart/OOM、数据库连接失败、RocketMQ retry/DLQ 无突增；支付、钱包和回调对账 smoke 通过。任一门槛失败即停止。

## 10. 应用回滚

workflow 的 ERR trap 会把 canary weight 归零、卸载 canary 并回滚 stable。人工执行：

```powershell
kubectl annotate ingress <service>-canary -n platform `
  alb.ingress.kubernetes.io/canary-weight="0" --overwrite
helm uninstall <service>-canary -n platform --wait
helm history <service> -n platform
helm rollback <service> <last-good-revision> -n platform --wait --timeout 15m
kubectl rollout status deployment/<service> -n platform --timeout 10m
```

如果新版本已写入向前兼容数据，先回滚应用，不回滚 expand migration。contract migration 尚未执行是快速回滚的前提。

## 11. 集群重建

1. 宣布事件并冻结部署；保存 state serial、Helm history、KMS/RAM/ACR/SLS IDs。
2. 确认 RDS/Tair/RocketMQ/OSS 完好，禁止销毁 data plane。
3. 在新 VPC/ACK 临时环境执行审批 plan；验证双区、RRSA、CSI、ALB controller、Prometheus。
4. 从 ACR digest 重放 releases；先 data access smoke，再 workers，最后 gateway。
5. 用新 ALB canary endpoint 全链路验证，低 TTL 切 DNS。
6. 旧集群保留 24 小时后再单独审批清理。

## 12. RDS Point-in-Time 恢复

1. 冻结写入，记录故障时间、最后正确事件和目标恢复时间。
2. 创建到新实例的 PITR，绝不覆盖原实例。
3. 隔离验证 schema、账本总额、订单/回调数量和外键一致性。
4. 重放 PITR 后可证明幂等的 RocketMQ 事件；钱包/支付先对账。
5. 更新 KMS pending DB endpoint，canary 验证后切 AWSCURRENT。
6. 原实例保持只读取证，复盘后按策略清理。

目标 RPO 不超过 5 分钟；每季度记录实际 RTO。

## 13. OSS 恢复

- 误删 7 天内：定位 object version ID，将上一版本复制为 current。
- temp/ 仅保留 24 小时，不作为恢复来源；failed/ 保留 7 天。
- 主区域不可用：核对 critical prefix 跨地域复制和 KMS，从 DR bucket 恢复到新私有 bucket。
- 恢复后检查 private ACL、Public Access Block、版本、KMS 和下载审计，禁止临时公网读。

## 14. RocketMQ 重试与 DLQ

1. 暂停对应 consumer group，不暂停无关 topic。
2. 从 dead-letter 导出 message ID、业务 key、原 topic、重试次数和错误，不输出敏感 payload。
3. staging 用脱敏样本验证修复和幂等。
4. 小批重投到 retry/原 topic，监控重复写和下游限流。
5. 恢复 consumer 并保留清单；超过 16 次不得自动无限循环。

## 15. 定期演练与审计

- 每周：失败部署、Helm history、DLQ、证书有效期、预算趋势。
- 每月：备份成功、OSS version restore 抽样、RAM 一对一和公网暴露。
- 每季度：RDS PITR、集群重建和应用 rollback 演练。
- 每次发布：保存 commit、digest、Cosign verification、plan SHA-256、backup ID、灰度指标和 Helm revision。

完成后不要自行合并 WS18 分支；由集成负责人按共同执行契约处理。
