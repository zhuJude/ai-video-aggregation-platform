# WS18 Infrastructure and Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 Terraform、Helm 和 CI/CD 定义阿里云生产环境，满足双可用区、弹性扩缩、KMS 密钥、备份、网络隔离、灰度和回滚要求，并控制爬坡期成本。

**Architecture:** Terraform 管云资源，Helm 管 ACK 工作负载；环境配置与密钥分离。所有服务用统一 chart 约束非 root、健康检查、资源、PDB、HPA/KEDA、NetworkPolicy 和工作负载身份。

**Tech Stack:** Terraform、Alibaba Cloud Provider、Helm 3、ACK Pro Auto Mode、ACR、ALB、RDS PostgreSQL、Tair、OSS/CDN、RocketMQ Serverless、KMS、SLS/ARMS、GitHub Actions。

---

## 文件所有权

只修改 `infra/terraform/**`、`infra/helm/**`、`.github/workflows/deploy-staging.yml`、`.github/workflows/deploy-production.yml`、`docs/runbooks/deployment.md`。

### Task 1: Define Terraform validation and environment layout

**Files:**
- Create: `infra/terraform/versions.tf`
- Create: `infra/terraform/environments/staging/main.tf`
- Create: `infra/terraform/environments/production/main.tf`
- Create: `infra/terraform/tests/structure.tftest.hcl`

- [ ] **Step 1: Write failing Terraform test**

```hcl
run "production_requires_two_zones" {
  command = plan
  module { source = "./environments/production" }
  assert {
    condition     = length(var.availability_zones) >= 2
    error_message = "production must use at least two availability zones"
  }
}
```

- [ ] **Step 2: Add providers and state policy**

Pin Terraform and Alibaba provider versions. Use remote state in an encrypted OSS Bucket with versioning and state locking; backend credentials come from OIDC/RAM, never committed variables. Separate staging/production state and VPC.

- [ ] **Step 3: Validate and commit**

Run: `terraform -chdir=infra/terraform fmt -check -recursive && terraform -chdir=infra/terraform test`

Expected: PASS after environment variables provide two zones.

```powershell
git add infra/terraform
git commit -m "chore(infra): bootstrap validated Terraform environments"
```

### Task 2: Provision network, ACK and ingress

**Files:**
- Create: `infra/terraform/modules/network/main.tf`
- Create: `infra/terraform/modules/ack/main.tf`
- Create: `infra/terraform/modules/edge/main.tf`
- Test: `infra/terraform/modules/ack/tests/ack.tftest.hcl`

- [ ] **Step 1: Write failing production policy assertions**

Assert ACK is managed Pro with Auto Mode, API server is private by default, node switches span two zones, audit logging is enabled, deletion protection is true and public traffic enters only through ALB/WAF.

- [ ] **Step 2: Implement modules**

Network creates VPC, two private workload vSwitches, two data vSwitches, NAT/EIP and security groups with least ingress. ACK enables managed Pro/Auto Mode, managed Prometheus/logging, workload identity and required CSI/KMS components. Edge creates ALB listeners 80->443 redirect, TLS 1.2+, WAF association, host routing for user/admin/API and CDN origins.

- [ ] **Step 3: Validate and commit**

Run: `terraform -chdir=infra/terraform test`

Expected: policy tests pass.

```powershell
git add infra/terraform/modules/network infra/terraform/modules/ack infra/terraform/modules/edge
git commit -m "feat(infra): add secure ACK and edge network"
```

### Task 3: Provision managed data and messaging

**Files:**
- Create: `infra/terraform/modules/data/main.tf`
- Create: `infra/terraform/modules/messaging/main.tf`
- Create: `infra/terraform/modules/storage/main.tf`
- Test: `infra/terraform/modules/data/tests/data.tftest.hcl`

- [ ] **Step 1: Write failing durability assertions**

Assert production RDS is high availability, encrypted, deletion-protected and has PITR/backup retention satisfying RPO; Tair is primary-replica; OSS is private/encrypted/versioned with lifecycle; RocketMQ uses private VPC and public access disabled.

- [ ] **Step 2: Implement cost-aware modules**

Parameterize sizes with production startup defaults and explicit upper scaling options. Create separate PostgreSQL databases/users through a post-provision migration job, not Terraform plaintext passwords. OSS prefixes/lifecycle implement 24-hour temp and seven-day deleted recovery. RocketMQ Serverless topics include domain events, delayed polling, retry and dead-letter with retention. Create budgets/alerts for each managed service.

- [ ] **Step 3: Validate and commit**

Run: `terraform -chdir=infra/terraform test`

Expected: PASS.

```powershell
git add infra/terraform/modules/data infra/terraform/modules/messaging infra/terraform/modules/storage
git commit -m "feat(infra): add durable managed data services"
```

### Task 4: Provision KMS, RAM, ACR and observability

**Files:**
- Create: `infra/terraform/modules/security/main.tf`
- Create: `infra/terraform/modules/observability/main.tf`
- Create: `infra/terraform/modules/registry/main.tf`
- Test: `infra/terraform/modules/security/tests/security.tftest.hcl`

- [ ] **Step 1: Write failing least-privilege tests**

Assert each service has a distinct RAM/workload identity, wildcard actions/resources are rejected, secrets are KMS-managed, ACR image scanning/signing is enabled and SLS retention differs by audit/security/application class.

- [ ] **Step 2: Implement modules**

Create per-service roles and policies for only required database secret, OSS prefix, RocketMQ topic and KMS secret. Configure KMS Secret Manager and ACK CSI integration. ACR has immutable production tags and vulnerability scan gate. SLS projects/logstores retain application logs 30 days, security/audit 180 days, with archive policy; ARMS/APM and alert contacts are environment inputs.

- [ ] **Step 3: Validate and commit**

Run: `terraform -chdir=infra/terraform test`

Expected: PASS.

```powershell
git add infra/terraform/modules/security infra/terraform/modules/observability infra/terraform/modules/registry
git commit -m "feat(infra): add KMS identities registry and telemetry"
```

### Task 5: Build reusable Helm charts and policies

**Files:**
- Create: `infra/helm/platform-service/Chart.yaml`
- Create: `infra/helm/platform-service/values.yaml`
- Create: `infra/helm/platform-service/templates/deployment.yaml`
- Create: `infra/helm/platform-service/templates/service.yaml`
- Create: `infra/helm/platform-service/templates/pdb.yaml`
- Create: `infra/helm/platform-service/templates/hpa.yaml`
- Create: `infra/helm/platform-service/templates/networkpolicy.yaml`
- Create: `infra/helm/environments/production.yaml`
- Test: `infra/helm/tests/render.ps1`

- [ ] **Step 1: Write failing render policy test**

```powershell
$rendered = helm template test infra/helm/platform-service -f infra/helm/environments/production.yaml
if ($rendered -notmatch 'runAsNonRoot: true') { throw 'runAsNonRoot missing' }
if ($rendered -notmatch 'readOnlyRootFilesystem: true') { throw 'readOnlyRootFilesystem missing' }
if ($rendered -notmatch 'kind: PodDisruptionBudget') { throw 'PDB missing' }
if ($rendered -notmatch 'kind: NetworkPolicy') { throw 'NetworkPolicy missing' }
```

- [ ] **Step 2: Implement chart**

Deployment requires non-root UID, read-only root, dropped capabilities, seccomp, CPU/memory requests/limits, startup/liveness/readiness probes, graceful termination and topology spread. ServiceAccount binds workload identity. HPA supports CPU and custom QPS. Provider Worker values enable KEDA RocketMQ lag scaling. NetworkPolicy denies by default and allows DNS plus declared service/data/provider egress.

- [ ] **Step 3: Validate and commit**

Run: `helm lint infra/helm/platform-service && pwsh infra/helm/tests/render.ps1`

Expected: PASS.

```powershell
git add infra/helm
git commit -m "feat(infra): add hardened autoscaling Helm charts"
```

### Task 6: Implement deployment workflows and rollback

**Files:**
- Create: `.github/workflows/deploy-staging.yml`
- Create: `.github/workflows/deploy-production.yml`
- Create: `docs/runbooks/deployment.md`

- [ ] **Step 1: Add workflow policy tests**

Use actionlint or YAML tests to assert production requires environment approval, uses OIDC instead of static access keys, deploys image digest rather than mutable tag, runs migration compatibility check before rollout and automatically rolls back on failed health gate.

- [ ] **Step 2: Implement workflows**

Staging triggers after CI on integration branch, signs images, pushes ACR, runs migrations, deploys Helm and executes smoke tests. Production is manual with approved commit/digest, Terraform plan attachment, database backup verification, canary 10% then 50% then 100%, five-minute health windows and `helm rollback` on failure.

- [ ] **Step 3: Write deployment Runbook**

Document prerequisites, exact Terraform plan/apply, DNS/certificate, KMS secret creation/rotation, database migration, canary, rollback, cluster rebuild, RDS point-in-time restore, OSS recovery, RocketMQ dead-letter and cost review.

- [ ] **Step 4: Verify and commit**

Run: `terraform -chdir=infra/terraform fmt -check -recursive && terraform -chdir=infra/terraform validate && helm lint infra/helm/platform-service`

Expected: PASS.

```powershell
git add .github/workflows/deploy-staging.yml .github/workflows/deploy-production.yml docs/runbooks/deployment.md
git commit -m "chore(infra): add canary deployment and rollback"
```

## WS18 completion gate

Run: `terraform -chdir=infra/terraform test && helm lint infra/helm/platform-service && pwsh infra/helm/tests/render.ps1 && git status --short`

Expected: pass, clean branch, no application/shared-contract/lockfile changes.
