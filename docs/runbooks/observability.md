# Reporting and Observability Runbook

## Service start and ownership

- Owner: Data Platform; finance-integrity escalation: Finance Platform.
- Start locally: `corepack pnpm --filter @repo/reporting-service build` then `node services/reporting-service/dist/src/main.js`.
- Required configuration: `DATABASE_URL`, `ROCKETMQ_CONSUMER_HEALTH_URL`, `REPORTING_ASSET_SERVICE_URL`, `REPORTING_AUDIT_SERVICE_URL`, `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, and `PROJECTION_HARD_LAG_SECONDS`.
- Credentials are KMS/Secret Manager references mounted at runtime. Never paste tokens, keys, callback signatures, verification codes, or phone numbers into commands, tickets, dashboards, or logs.
- `/health/live` proves that the process can serve traffic. `/health/ready` additionally requires PostgreSQL, the RocketMQ consumer, and projection lag below the configured hard limit. `/metrics` is private-cluster only.

## Missing telemetry

1. Confirm the Pod is ready and `/metrics` responds inside the VPC.
2. Check Collector target health, then OTLP endpoint reachability and certificate validity.
3. Compare `up{service="reporting-service"}` with Pod count. A missing target must not be interpreted as zero traffic.
4. Verify `OTEL_SERVICE_NAME`, `SERVICE_VERSION`, and `DEPLOYMENT_ENVIRONMENT`; do not print the environment wholesale because it contains secret references.
5. If export is failing, keep local structured error logs enabled, open a P2 incident, and restore Collector delivery before closing it.

## High-cardinality prevention

Metric labels may describe only bounded dimensions such as service, route template, status class, topic, consumer, provider, model family, state, currency, and error code. Labels named `userId`, `taskId`, `orderId`, `objectKey`, `phone`, Trace ID, or correlation ID are prohibited. Do not put raw URL paths, object names, prompts, or exception messages into labels.

Before deploying a new metric:

1. Run `corepack pnpm --filter @repo/observability test`.
2. Inspect `count by (__name__)({service="reporting-service"})` and compare series growth with the previous release.
3. Reject the release if a bounded workload creates unbounded series. Roll back the metric definition and delete no historical evidence until the incident owner approves retention cleanup.

## Projection lag

Alert: `ReportingProjectionLagHigh`. Check `reporting_service_projection_lag_seconds{consumer="reporting"}`, RocketMQ consumer lag, database latency, and dead-letter rate.

1. Stop export workers first if report queries are saturating PostgreSQL.
2. Confirm the consumer lease is held by exactly one active instance per partition.
3. Scale consumers only when event ordering and partition ownership remain valid.
4. If lag exceeds the readiness hard limit, keep the Pod out of service; do not serve stale finance totals as current.
5. Close the alert only after lag stays below 60 seconds for 15 minutes and source reconciliation returns zero difference.

## Poison event

Alert: `ReportingProjectionError`. Locate the event by event ID from the dead-letter metadata, then use Trace ID for authorized logs. Never copy the full payload into chat or a ticket.

1. Validate the envelope against the current and previous compatible schema versions.
2. Determine whether the defect is malformed source data, an unsupported compatible version, or projector code.
3. Record an incident and quarantine the message. Do not repeatedly replay it.
4. After a tested fix, replay once with the same event ID. `ProcessedEvent` uniqueness must prevent a second effect.
5. Run the read-only reconciliation queries below before acknowledging recovery.

## Projection rebuild

The admin-only rebuild command must read retained events in source order, write a new version, reconcile it, and atomically switch the active version. Existing dashboards continue to read the old active version during the build.

1. Confirm retained-event coverage spans the requested rebuild window.
2. Start the command through the restricted operations job with `reports:rebuild`; record the change ticket and operator.
3. Watch `reporting_service_projection_rebuild_status{status="RUNNING"}` and projection errors.
4. Require exact equality for recharge points, recharge amount, consumed points, recognized revenue, provider cost, successful tasks, and failed tasks.
5. If validation fails, the shadow version is marked failed and must not become active.
6. After activation, keep the previous version for 24 hours for rollback and then remove it under an approved retention job.

## Dashboard deployment

Dashboards live in `packages/observability/dashboards`. Import them through the environment's reviewed Grafana/SLS provisioning pipeline; never edit production dashboards by hand. Validate JSON, datasource mapping, bounded template variables, and the `Asia/Shanghai` business timezone. Attach a screenshot and provisioning revision to the change ticket.

## Alert testing

Rules live in `packages/observability/alerts/rules.yaml`.

1. Run `corepack pnpm --filter @repo/observability test`.
2. Use the staging rule evaluator to inject one synthetic series per rule.
3. Confirm severity, owner, dedup key, notification route, Runbook link, and closure behavior.
4. P0 alerts require a healthy confirmation window and must not auto-resolve on one good scrape.
5. Remove synthetic series and confirm the alert closes only after its configured window.

## P0/P1 routing

- P0: page Platform SRE and the named domain owner immediately; send telephone/SMS escalation after five minutes without acknowledgement. Finance P0 also pages Finance Platform. Declare an incident channel and freeze related writes when duplicate financial effects are possible.
- P1: page Platform SRE and the named owner; acknowledgement target is ten minutes. Escalate to P0 if customer-wide impact or financial integrity risk appears.
- P2: route to the domain operations queue and on-call notification. P3 enters planned maintenance.
- Every acknowledgement records incident ID, owner, start time, current impact, mitigation, and explicit closure evidence.

## Log access approval

Production logs require an incident/change ticket and approval from the service owner. Finance or authentication investigations also require the corresponding domain owner. Use least-privilege, time-limited SLS roles; all searches are audited. Search by Trace ID, correlation ID, standard error code, or bounded time window. Access to raw provider payloads or user assets is not granted by ordinary log access.

## Read-only reconciliation queries

Run these in a read-only transaction against the reporting database. They compare the active projection with the exact source-event contributions retained in `ProcessedEvent`. A non-zero difference blocks finance reporting and release.

```sql
BEGIN TRANSACTION READ ONLY;

WITH active AS (
  SELECT "version" FROM "ProjectionVersion" WHERE "active" = TRUE
), source_totals AS (
  SELECT
    COALESCE(SUM(("contribution"->>'rechargePoints')::BIGINT), 0) AS recharge_points,
    COALESCE(SUM(("contribution"->>'rechargeAmountMinor')::BIGINT), 0) AS recharge_amount_minor,
    COALESCE(SUM(("contribution"->>'consumedPoints')::BIGINT), 0) AS consumed_points,
    COALESCE(SUM(("contribution"->>'revenueMinor')::BIGINT), 0) AS revenue_minor,
    COALESCE(SUM(("contribution"->>'providerCostMinor')::BIGINT), 0) AS provider_cost_minor,
    COALESCE(SUM(("contribution"->>'successfulTasks')::BIGINT), 0) AS successful_tasks,
    COALESCE(SUM(("contribution"->>'failedTasks')::BIGINT), 0) AS failed_tasks
  FROM "ProcessedEvent" p JOIN active a ON a."version" = p."projectionVersion"
), projected_totals AS (
  SELECT
    COALESCE(SUM("rechargePoints"), 0) AS recharge_points,
    COALESCE(SUM("rechargeAmountMinor"), 0) AS recharge_amount_minor,
    COALESCE(SUM("consumedPoints"), 0) AS consumed_points,
    COALESCE(SUM("revenueMinor"), 0) AS revenue_minor,
    COALESCE(SUM("providerCostMinor"), 0) AS provider_cost_minor,
    COALESCE(SUM("successfulTasks"), 0) AS successful_tasks,
    COALESCE(SUM("failedTasks"), 0) AS failed_tasks
  FROM "DailyBusinessMetric" d JOIN active a ON a."version" = d."projectionVersion"
)
SELECT
  p.recharge_points - s.recharge_points AS recharge_points_difference,
  p.recharge_amount_minor - s.recharge_amount_minor AS recharge_amount_difference,
  p.consumed_points - s.consumed_points AS consumed_points_difference,
  p.revenue_minor - s.revenue_minor AS revenue_difference,
  p.provider_cost_minor - s.provider_cost_minor AS provider_cost_difference,
  p.successful_tasks - s.successful_tasks AS successful_task_difference,
  p.failed_tasks - s.failed_tasks AS failed_task_difference
FROM projected_totals p CROSS JOIN source_totals s;

WITH active AS (
  SELECT "version" FROM "ProjectionVersion" WHERE "active" = TRUE
)
SELECT "eventType", COUNT(*) AS source_event_count
FROM "ProcessedEvent" p JOIN active a ON a."version" = p."projectionVersion"
GROUP BY "eventType" ORDER BY "eventType";

COMMIT;
```

All seven difference columns must be zero. If they are not, preserve the query output, stop report exports, and follow Projection rebuild. Do not edit aggregate rows manually.

## Named alert procedures

### WalletLedgerMismatch

Freeze wallet-affecting administrative actions and report exports, page Finance Platform, run wallet-service canonical reconciliation, then the read-only reporting reconciliation. Never "balance" by editing a report row.

### DuplicatePaymentEffect

Disable the affected payment consumer partition, preserve event IDs and idempotency keys, and page Payments plus Finance Platform. Confirm the wallet ledger before replaying anything.

### CoreApiUnavailable

Check ALB, ready Pod count, dependency health, and the last deployment. Roll back when the error budget burn began with the release.

### PaymentFailureSpike

Separate business declines from channel or platform errors. Do not retry non-idempotent payment commands without the original business key.

### QueueStalled

Check partition ownership, oldest message age, database locks, retries, and dead letters. Scale only after confirming ordering safety.

### ProviderBalanceLow

Notify Provider Operations, verify the provider portal through approved access, and route new work away from the provider if the configured threshold is crossed.

### MarginBelowGuardrail

Compare recognized revenue and provider cost source events, then confirm current pricing. Stop loss-making model routes through the pricing service; do not change report data.

## Rollback

Roll back the application to the previous signed image. Database changes are forward compatible; do not reverse the migration during an incident. If a new projection is wrong, atomically mark the prior validated `ProjectionVersion` active in a reviewed transaction, then restart report readers. Re-run readiness and all reconciliation differences before reopening exports or closing the incident.
