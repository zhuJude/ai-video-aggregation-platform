# WS17 Reporting and Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现事件驱动经营报表、成本/毛利模型、供应商与任务指标，以及统一日志、指标、链路、告警规则和 Runbook。

**Architecture:** `reporting-service` 只消费领域事件并维护可重建读模型，不查询其他服务数据库。`packages/observability` 提供低基数指标、结构化日志和 OpenTelemetry 初始化；生产导出到 SLS/ARMS，本地导出到 stdout/OTLP Collector。

**Tech Stack:** NestJS、Prisma/PostgreSQL、RocketMQ、OpenTelemetry、Pino、prom-client、Vitest、Grafana-compatible dashboard JSON、SLS/ARMS。

---

## 文件所有权

只修改 `services/reporting-service/**`、`packages/observability/**`、`docs/runbooks/observability.md`。

### Task 1: Build low-cardinality observability primitives

**Files:**
- Create: `packages/observability/package.json`
- Create: `packages/observability/src/logger.ts`
- Create: `packages/observability/src/metrics.ts`
- Create: `packages/observability/src/tracing.ts`
- Test: `packages/observability/test/redaction.test.ts`

- [ ] **Step 1: Write failing redaction tests**

```ts
it('redacts secrets, phone numbers and callback signatures', () => {
  const output = captureLog({ authorization: 'Bearer secret', phone: '13800138000', signature: 'wx-signature', taskId: 'task-1' });
  expect(output).not.toContain('secret');
  expect(output).not.toContain('13800138000');
  expect(output).not.toContain('wx-signature');
  expect(output).toContain('task-1');
});
```

- [ ] **Step 2: Implement logging**

Create Pino logger with recursive redaction paths for authorization/cookie/token/secret/signature/phone/payment ciphertext and configurable sampling for successful high-volume requests. Always retain errors, financial events and audit references. Emit UTC timestamp, service, environment, version, Trace ID, correlation ID and standard error code.

- [ ] **Step 3: Implement metrics and traces**

Expose helpers for HTTP RED, message lag/retry/dead-letter, provider latency/status, task state/Saga lag, wallet reconciliation and business counters. Reject dynamic labels named userId/taskId/orderId/objectKey/phone. Initialize OpenTelemetry before app imports; propagate W3C trace context through HTTP and RocketMQ headers.

- [ ] **Step 4: Verify and commit**

Run: `corepack pnpm --filter @repo/observability test && corepack pnpm --filter @repo/observability typecheck`

Expected: PASS.

```powershell
git add packages/observability
git commit -m "feat(observability): add safe logs metrics and traces"
```

### Task 2: Create idempotent reporting projections

**Files:**
- Create: `services/reporting-service/prisma/schema.prisma`
- Create: `services/reporting-service/src/application/projector.ts`
- Test: `services/reporting-service/test/projector.integration.test.ts`

- [ ] **Step 1: Write failing replay test**

```ts
it('does not double count a replayed payment and task event', async () => {
  await projector.handle(paymentPaid); await projector.handle(paymentPaid);
  await projector.handle(taskSettled); await projector.handle(taskSettled);
  expect(await dailyMetric('2026-08-28')).toMatchObject({ rechargePoints: 10000n, consumedPoints: 1200n, successfulTasks: 1 });
});
```

- [ ] **Step 2: Implement schemas and projector**

Create `ProcessedEvent`, `DailyBusinessMetric`, `ProviderDailyMetric`, `ModelDailyMetric`, `UserSegmentMetric`, `RealtimeCounter`, and `ProjectionCheckpoint`. Process each event in one transaction with unique event ID. Use compensating events to subtract prior contribution; never edit source events. Store money/points as BigInt and ratios as numerator/denominator pairs.

- [ ] **Step 3: Add projection rebuild**

Implement an admin-only command that builds into versioned shadow tables from retained events, validates totals, then atomically switches the active projection version. Existing dashboard reads continue during rebuild.

- [ ] **Step 4: Verify and commit**

Run: `corepack pnpm --filter @repo/reporting-service test -- projector.integration.test.ts`

Expected: PASS.

```powershell
git add services/reporting-service
git commit -m "feat(reporting): add replay-safe business projections"
```

### Task 3: Implement reporting APIs and exports

**Files:**
- Create: `services/reporting-service/src/http/reports.controller.ts`
- Create: `services/reporting-service/src/application/export.service.ts`
- Test: `services/reporting-service/test/reports-api.test.ts`

- [ ] **Step 1: Write failing precision and freshness tests**

```ts
it('returns point totals as strings with freshness metadata', async () => {
  const response = await app.inject({ method: 'GET', url: '/internal/reports/overview?from=2026-08-01&to=2026-08-28' });
  expect(response.json()).toMatchObject({ totals: { consumedPoints: expect.any(String) }, freshness: { projectedThrough: expect.any(String), lagSeconds: expect.any(Number) } });
});
```

- [ ] **Step 2: Implement APIs**

Provide overview, revenue/cost/margin, provider/model, task success/duration, user acquisition/retention and alert-summary endpoints. Validate maximum date range, use server-side grouping, return explicit timezone `Asia/Shanghai` for business-day grouping and include projection freshness. CSV export is asynchronous, permission-checked, audited and stored as a short-lived private asset.

- [ ] **Step 3: Verify and commit**

Run: `corepack pnpm --filter @repo/reporting-service test -- reports-api.test.ts`

Expected: PASS.

```powershell
git add services/reporting-service
git commit -m "feat(reporting): add business report APIs and exports"
```

### Task 4: Add dashboards and alert rules

**Files:**
- Create: `packages/observability/dashboards/platform-overview.json`
- Create: `packages/observability/dashboards/provider-health.json`
- Create: `packages/observability/dashboards/finance-integrity.json`
- Create: `packages/observability/alerts/rules.yaml`
- Test: `packages/observability/test/alerts.test.ts`

- [ ] **Step 1: Write failing required-alert test**

```ts
it.each(['WalletLedgerMismatch', 'DuplicatePaymentEffect', 'CoreApiUnavailable', 'PaymentFailureSpike', 'QueueStalled', 'ProviderBalanceLow'])('defines %s', async (name) => {
  expect(await loadRuleNames()).toContain(name);
});
```

- [ ] **Step 2: Implement dashboards and rules**

Overview covers availability, latency, task funnel and queue lag. Provider dashboard compares health/latency/error/circuit/balance/cost. Finance dashboard shows payments, ledger, reconciliation and refund backlog. P0 rules have no auto-resolve without a healthy confirmation window; every rule includes severity, owner, Runbook URL and dedup key.

- [ ] **Step 3: Verify and commit**

Run: `corepack pnpm --filter @repo/observability test`

Expected: PASS.

```powershell
git add packages/observability
git commit -m "feat(observability): add production dashboards and alerts"
```

### Task 5: Add production runtime and Runbook

**Files:**
- Create: `services/reporting-service/Dockerfile`
- Create: `docs/runbooks/observability.md`

- [ ] **Step 1: Add health/metrics/image**

Readiness checks database, RocketMQ consumer and projection lag below configured hard limit. Use non-root image. Export projection lag, rebuild status, event errors and report query latency.

- [ ] **Step 2: Write Runbook**

Document missing telemetry, high-cardinality prevention, projection lag, event poison message, rebuild, dashboard deployment, alert testing, P0/P1 routing and log access approval. Include exact read-only queries to compare report totals to source event counts.

- [ ] **Step 3: Verify and commit**

Run: `corepack pnpm --filter @repo/reporting-service test:coverage && corepack pnpm --filter @repo/reporting-service build`

Expected: PASS.

```powershell
git add services/reporting-service docs/runbooks/observability.md
git commit -m "chore(reporting): add production runtime and observability runbook"
```

## WS17 completion gate

Run: `corepack pnpm --filter @repo/observability test && corepack pnpm --filter @repo/reporting-service test && git status --short`

Expected: pass, clean branch, lockfile/shared contracts unchanged.
