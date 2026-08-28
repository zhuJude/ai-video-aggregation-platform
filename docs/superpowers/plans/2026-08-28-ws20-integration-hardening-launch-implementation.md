# WS20 Integration, Hardening and Launch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 合并所有并行工作包，解决契约请求，完成全平台本地运行、跨域 E2E、锁文件、安全扫描、压测、故障演练、恢复验证和上线 Go/No-Go 报告。

**Architecture:** 集成窗口是唯一允许跨工作包修改和提交 `pnpm-lock.yaml` 的窗口。先逐分支合并并保持全绿，再补跨域 Saga 与端到端测试；最后执行不可跳过的财务、安全、容量和恢复门禁。

**Tech Stack:** 全仓库技术栈、Docker Compose、Playwright、k6、Vitest、Testcontainers、Trivy、Semgrep、Gitleaks、Terraform、Helm。

---

## 文件所有权

独占 `tests/e2e/**`、`tests/load/**`、`tests/chaos/**`、`docs/reports/**`、`pnpm-lock.yaml`。可以在评审后修复跨目录集成问题，但必须将修复提交按领域拆分，并通知原工作包负责人。

### Task 1: Merge Wave 1 branches one at a time

**Files:**
- Modify: integration branch as produced by WS09–WS18
- Create: `docs/reports/merge-log.md`

- [ ] **Step 1: Verify the integration baseline**

Run:

```powershell
git status --short
corepack pnpm install --frozen-lockfile
corepack pnpm verify
```

Expected: clean status and all baseline checks pass.

- [ ] **Step 2: Merge in the fixed order**

```powershell
$branches = @(
  'codex/ws12-wallet-payment',
  'codex/ws11-catalog-routing',
  'codex/ws13-generation-provider',
  'codex/ws09-edge-gateway',
  'codex/ws10-identity-iam',
  'codex/ws14-supporting-services',
  'codex/ws17-reporting-observability',
  'codex/ws15-user-web',
  'codex/ws16-admin-web',
  'codex/ws18-infrastructure'
)
foreach ($branch in $branches) {
  git merge --no-ff $branch -m "merge: integrate $branch"
  if ($LASTEXITCODE -ne 0) { throw "merge failed: $branch" }
  corepack pnpm install --lockfile=false
  corepack pnpm lint
  corepack pnpm typecheck
  corepack pnpm test
  corepack pnpm build
  if ($LASTEXITCODE -ne 0) { throw "verification failed: $branch" }
}
```

Expected: every branch merges and verifies before the next begins.

- [ ] **Step 3: Record provenance and commit merge log**

Record each branch tip SHA, merge SHA, commands, duration and any repair commit in `docs/reports/merge-log.md`.

```powershell
git add docs/reports/merge-log.md
git commit -m "docs: record parallel workstream integration"
```

### Task 2: Resolve contract change requests and freeze APIs

**Files:**
- Modify: `packages/contracts/**` only for accepted requests
- Create: `docs/reports/contract-resolution.md`
- Test: `tests/e2e/contracts.spec.ts`

- [ ] **Step 1: Inventory requests**

Run: `Get-ChildItem docs/contract-change-requests -File -ErrorAction SilentlyContinue | Sort-Object Name`

Expected: a deterministic list; no request may be silently ignored.

- [ ] **Step 2: Write failing cross-service contract tests**

For every accepted request, add a producer fixture and consumer parse assertion. Add a global test that loads all JSON event fixtures, validates event envelope/type/version and ensures point/time/ID serialization rules.

- [ ] **Step 3: Apply only backward-compatible fixes**

New optional fields and new event versions are allowed. Renaming/removing fields in v1 is rejected; create v2 and keep consumers compatible with v1 during rollout. Update affected producers/consumers in separate commits.

- [ ] **Step 4: Verify and commit**

Run: `corepack pnpm test && corepack pnpm typecheck`

Expected: PASS.

```powershell
git add packages/contracts services apps tests/e2e/contracts.spec.ts docs/reports/contract-resolution.md
git commit -m "fix: resolve reviewed cross-service contracts"
```

### Task 3: Regenerate the only committed lockfile and dependency report

**Files:**
- Modify: `pnpm-lock.yaml`
- Create: `docs/reports/dependencies.md`

- [ ] **Step 1: Recreate from manifests**

Run:

```powershell
Remove-Item -LiteralPath 'pnpm-lock.yaml' -ErrorAction SilentlyContinue
corepack pnpm install
corepack pnpm dedupe
corepack pnpm install --frozen-lockfile
```

Expected: one deterministic lockfile and frozen install passes.

- [ ] **Step 2: Audit dependencies**

Run: `corepack pnpm audit --prod`

Expected: no high or critical production vulnerability. Record package counts, overrides and accepted lower-severity findings with rationale in `docs/reports/dependencies.md`.

- [ ] **Step 3: Commit**

```powershell
git add pnpm-lock.yaml docs/reports/dependencies.md
git commit -m "chore: lock integrated production dependencies"
```

### Task 4: Build the full local stack

**Files:**
- Modify: `infra/local/compose.yaml`
- Create: `infra/local/compose.services.yaml`
- Create: `scripts/local-stack.ps1`
- Test: `tests/e2e/stack-health.spec.ts`

- [ ] **Step 1: Write failing stack health test**

Test user/admin Web, Gateway, every service `/readyz`, PostgreSQL databases, Redis, MinIO and Mock Provider. Assert no service reports ready before migrations finish.

- [ ] **Step 2: Compose all services**

Add each image/build, isolated service database URL, Redis, object store, Mock Provider and local message adapter. `scripts/local-stack.ps1 up` creates buckets, applies every migration, seeds one superadmin, one user, one published Mock model and test recharge package; it prints credentials only for local mode. `down` preserves volumes; `reset` requires typed confirmation and deletes only the explicit local Compose project volumes.

- [ ] **Step 3: Verify and commit**

Run: `pwsh scripts/local-stack.ps1 up && corepack pnpm exec playwright test tests/e2e/stack-health.spec.ts`

Expected: all components healthy.

```powershell
git add infra/local scripts/local-stack.ps1 tests/e2e/stack-health.spec.ts
git commit -m "feat(integration): run the complete platform locally"
```

### Task 5: Verify the commercial user journey

**Files:**
- Create: `tests/e2e/user-commercial-flow.spec.ts`
- Create: `tests/e2e/user-failure-refund.spec.ts`

- [ ] **Step 1: Add success flow**

Playwright performs SMS login, model discovery, asset upload, professional quote, task submit, SSE updates, result preview/download, exact wallet settlement, order list, message and ticket. Capture task ID and verify one reserve plus one settlement with balanced entries. A second flow changes phone after dual verification, revokes another device, closes the account, verifies all sessions are revoked and confirms financial/ledger facts remain retained while public profile data is anonymized through the user-closed event consumers.

- [ ] **Step 2: Add failure/refund/cancel flows**

Run Mock Provider failed/timeout/rate-limit/callback-lost/callback-duplicate/callback-out-of-order scenarios. Assert full refund for provider failure, no duplicate effect, cancel visibility from capability, and no automatic failover after ambiguous acceptance.

- [ ] **Step 3: Verify and commit**

Run: `corepack pnpm exec playwright test tests/e2e/user-commercial-flow.spec.ts tests/e2e/user-failure-refund.spec.ts`

Expected: PASS.

```powershell
git add tests/e2e/user-commercial-flow.spec.ts tests/e2e/user-failure-refund.spec.ts
git commit -m "test(e2e): verify user generation and refund journeys"
```

### Task 6: Verify administrative and financial controls

**Files:**
- Create: `tests/e2e/admin-operations.spec.ts`
- Create: `tests/e2e/finance-integrity.spec.ts`

- [ ] **Step 1: Add admin flow**

Verify MFA, custom role, permission denial, provider metadata/credential masking, capability draft/publish/rollback, pricing/margin rejection, route simulation, task repair, content publication and ticket handling.

- [ ] **Step 2: Add finance integrity flow**

Send 100 concurrent duplicate task requests, payment callbacks and provider callbacks. Assert one task/order effect and ledger invariant. Create point adjustment as admin A, prove self-approval fails, approve as admin B, and verify append-only audit. Inject a snapshot mismatch and prove wallet blocks/P0 triggers.

- [ ] **Step 3: Verify and commit**

Run: `corepack pnpm exec playwright test tests/e2e/admin-operations.spec.ts tests/e2e/finance-integrity.spec.ts`

Expected: PASS and reconciliation difference count is zero after cleanup.

```powershell
git add tests/e2e/admin-operations.spec.ts tests/e2e/finance-integrity.spec.ts
git commit -m "test(e2e): verify admin and financial controls"
```

### Task 7: Run load and endurance tests

**Files:**
- Create: `tests/load/platform.js`
- Create: `tests/load/task-workers.js`
- Create: `docs/reports/performance.md`

- [ ] **Step 1: Implement k6 workload**

Model 10,000 registered accounts, active login/catalog/wallet/task queries, payment bursts and 200 concurrent asynchronous tasks. Thresholds: ordinary API p95 `<500ms`, task acceptance p95 `<2s`, platform unexpected error `<0.5%`, no wallet mismatch. Separate provider generation latency from platform latency.

- [ ] **Step 2: Prove scaling**

In staging, record starting/peak API pods, Worker pods and nodes. Create queue lag to trigger KEDA, request load to trigger HPA and unschedulable pods to trigger Auto Mode. Assert scale-out occurs before SLO breach and scale-in does not terminate in-flight tasks.

- [ ] **Step 3: Run endurance**

Run 24 hours at representative load. Track heap, handles, DB connections, queue lag, stuck tasks and ledger totals. Any monotonic leak or permanent task blocks completion.

- [ ] **Step 4: Commit report**

Run: `k6 run tests/load/platform.js && k6 run tests/load/task-workers.js`

Expected: thresholds pass.

```powershell
git add tests/load docs/reports/performance.md
git commit -m "test(load): verify capacity and autoscaling"
```

### Task 8: Run chaos and recovery exercises

**Files:**
- Create: `tests/chaos/kill-pods.ps1`
- Create: `tests/chaos/provider-failures.ps1`
- Create: `tests/chaos/restore-verification.ps1`
- Create: `docs/reports/chaos-recovery.md`

- [ ] **Step 1: Exercise runtime failures**

Kill Gateway/API/Worker pods during active tasks; pause a RocketMQ consumer; restart Redis; inject provider 429/5xx/auth/zero-balance; simulate OSS timeout and delayed/duplicate payment callbacks. Verify self-healing, bounded retry, circuit, no duplicate purchase and correct refund.

- [ ] **Step 2: Exercise database/asset recovery**

Restore RDS to an isolated environment from point-in-time backup, apply secrets, rebuild read models and compare ledger/task/payment totals. Restore a soft-deleted OSS fixture. Measure RPO and RTO; require RPO ≤5 minutes and RTO ≤60 minutes for transactional data.

- [ ] **Step 3: Exercise rollback**

Deploy a deliberately failing canary with a backward-compatible migration, observe health gate rollback, then verify old application and database compatibility.

- [ ] **Step 4: Commit evidence**

```powershell
git add tests/chaos docs/reports/chaos-recovery.md
git commit -m "test(chaos): verify failure recovery and rollback"
```

### Task 9: Run security and privacy gates

**Files:**
- Create: `docs/reports/security.md`
- Create: `tests/e2e/security-boundaries.spec.ts`

- [ ] **Step 1: Scan source, secrets, dependencies, IaC and images**

Run Semgrep, Gitleaks, `pnpm audit --prod`, Trivy filesystem/config/image scans and Terraform/Helm policy tests. High/critical findings block completion; record lower findings and owners.

- [ ] **Step 2: Test security boundaries**

Test IDOR across user/task/asset/ticket, admin permission/data scope, CSRF/CORS/CSP, SSRF provider result URLs, upload MIME/magic/size, credential DOM/log redaction, JWT audience, refresh reuse, SMS/payment/task rate limit and webhook signatures.

- [ ] **Step 3: Verify and commit**

Run: `corepack pnpm exec playwright test tests/e2e/security-boundaries.spec.ts`

Expected: PASS and no high/critical scan finding.

```powershell
git add tests/e2e/security-boundaries.spec.ts docs/reports/security.md
git commit -m "test(security): verify platform trust boundaries"
```

### Task 10: Produce the Go/No-Go report

**Files:**
- Create: `docs/reports/go-no-go.md`
- Create: `docs/reports/traceability-matrix.md`

- [ ] **Step 1: Map every design requirement to evidence**

Create a traceability table covering every section of the approved design, owning service/UI, tests, dashboard/alert, Runbook and result. A missing row is a failed gate.

- [ ] **Step 2: Evaluate launch blockers**

Mark GO only when P0/P1 defects are zero, finance difference zero, SLO/load/chaos/security/recovery pass, cloud prerequisites are ready and at least one real provider adapter passes conformance. If real provider documents/keys have not yet been supplied, platform-core status can be PASS but production launch result must be `NO-GO: REAL_PROVIDER_NOT_VALIDATED`.

- [ ] **Step 3: Run final verification**

```powershell
corepack pnpm verify
corepack pnpm exec playwright test
terraform -chdir=infra/terraform test
helm lint infra/helm/platform-service
git status --short
```

Expected: all commands pass and Git status is empty.

- [ ] **Step 4: Commit reports**

```powershell
git add docs/reports/go-no-go.md docs/reports/traceability-matrix.md
git commit -m "docs: publish launch readiness evidence"
```

## WS20 completion gate

Invoke `verification-before-completion`. Do not claim production-ready if `go-no-go.md` contains any NO-GO condition. If only the real-provider prerequisite remains, hand back a verified platform core plus the Provider SDK conformance command and request the first supplier documentation.
