# Supporting services runbook

This runbook covers `asset-service`, `operations-service`, and `notification-service`. Production changes require an incident or change record, two-person review for privacy-impacting actions, and a captured UTC timeline. Never paste credentials, phone numbers, object keys, ticket bodies, or raw event payloads into tickets or chat.

## Start and stop

Local prerequisites are PostgreSQL plus private/VPC endpoints for OSS, KMS, SMS, and RocketMQ. Inject secret references through the process environment or ACK Secret Manager; do not place secret values in a command line.

```powershell
corepack pnpm --filter @repo/asset-service prisma:migrate:deploy
corepack pnpm --filter @repo/operations-service prisma:migrate:deploy
corepack pnpm --filter @repo/notification-service prisma:migrate:deploy
corepack pnpm --filter @repo/asset-service start
corepack pnpm --filter @repo/operations-service start
corepack pnpm --filter @repo/notification-service start
```

Use `Ctrl+C` locally; each process stops polling, drains in-flight work, disconnects from RocketMQ/OSS/PostgreSQL, and closes HTTP. In ACK, use the deployment lifecycle so the termination grace period remains effective:

```powershell
kubectl -n ai-video rollout restart deployment/asset-service deployment/operations-service deployment/notification-service
kubectl -n ai-video rollout status deployment/asset-service --timeout=5m
kubectl -n ai-video rollout status deployment/operations-service --timeout=5m
kubectl -n ai-video rollout status deployment/notification-service --timeout=5m
```

Validate `GET /health/live`, `GET /health/ready`, and `GET /metrics` on each pod before restoring traffic. Readiness failures are non-2xx `ApiError` responses with a trace ID and never disclose dependency configuration.

## SLO and alerts

Platform API availability target is 99.9%; supporting API p95 is below 500 ms and unexpected errors stay below 0.5%. Metadata RPO is 5 minutes and RTO is 60 minutes. Page P1 when readiness is continuously false for 5 minutes, a worker makes no progress for 10 minutes, consumer lag exceeds 120 seconds for 10 minutes, or a deletion/import queue grows for 15 minutes. Page P0 on suspected privacy exposure or a private bucket becoming public. P2 covers isolated SMS/provider degradation and growing operator queues.

Close an alert only after health is stable for 15 minutes, queue depth is decreasing, oldest-work age is under its threshold, and the incident timeline contains the corrective action and follow-up owner.

## Metrics

Scrape `GET /metrics`. Alert and dashboard on:

- `support_asset_upload_completion_failures_total`, `support_asset_import_bytes_total`, `support_asset_import_errors_total`, `support_asset_pending_imports`, and `support_asset_pending_deletions`.
- `support_operations_cms_publications_total`, `support_operations_ticket_backlog`, and `support_operations_pending_compensations`.
- `support_notification_sms_retries_total`, `support_notification_retry_queue`, `support_notification_operator_queue`, and `support_notification_consumer_lag_seconds`.

Labels are bounded enums only. Object keys, phone numbers, user IDs, ticket IDs, notification IDs, and raw provider errors are forbidden labels.

## OSS/KMS/RAM credential rotation

Prerequisite: approved change, two operators, a new KMS alias/version or RAM role, and ACK projected OIDC (`ACK_OIDC_PROVIDER_ARN`, `ACK_ROLE_ARN`, `ACK_OIDC_TOKEN_FILE`). Never export key material. Pause: canary one service at a time. Diagnose: `kubectl -n ai-video describe pod -l app=asset-service` and `kubectl -n ai-video describe pod -l app=notification-service`, inspecting only SDK error classes. Expected: STS issues short-lived sessions and readiness remains 200. Recovery: update only KMS/role references, run `kubectl -n ai-video rollout restart deployment/asset-service`, verify private upload/download plus provider MAC, then separately run `kubectl -n ai-video rollout restart deployment/notification-service` and verify SMS sign lookup. Verify: decrypt a sampled historical wrapped notification DEK through the application read path, without exporting plaintext, and check both rollout statuses. Rollback/closure: restore each service's prior reference independently, restart that canary, prove historical wrapped DEKs still decrypt, retain the old key for 24 hours, then revoke it.

## Stuck provider import

Prerequisite: read-only DB access and provider authorization record. Pause: `kubectl -n ai-video set env deployment/asset-service ASSET_WORKERS_ENABLED=false` and wait for rollout; HTTP stays ready because worker pause is intentional. Diagnose: `psql "$env:DATABASE_URL" -c "SELECT status, count(*) FROM \"ResultImport\" GROUP BY status"` and inspect `support_asset_pending_imports`; check allowlisted DNS/TLS and OSS throttling without fetching a new URL. Expected: one durable reservation and no AVAILABLE asset before integrity verification. Recovery: request the provider to redeliver the original authorized callback/event; idempotency resumes the same reservation. Verify: pending imports decrease, the asset is AVAILABLE, and its outbox event is published once. Rollback/closure: keep the record failed if authorization expired; resume with `kubectl -n ai-video set env deployment/asset-service ASSET_WORKERS_ENABLED=true` and attach redacted evidence.

## SSRF or supplier import incident

Prerequisite: security incident ID, egress-policy owner, and immutable audit storage. Pause: disable provider-result ingress at the gateway and set `ASSET_WORKERS_ENABLED=false`; do not scale the API to zero. Diagnose: review DNS-pin/redirect decisions and KMS callback-key audit events; never curl the suspicious URL. Expected: private, loopback, link-local and non-HTTPS targets are rejected before copy. Recovery: block the supplier host at egress, revoke its callback KMS reference, rotate it, and deploy the corrected allowlist. Verify: SSRF, redirect, MIME, size and checksum suites pass and no private address was contacted. Rollback/closure: leave the supplier disabled if evidence is incomplete; otherwise resume one canary, then set `ASSET_WORKERS_ENABLED=true`.

## Orphan scan

Prerequisite: restricted workstation, read-only DB role, OSS inventory read permission, and configured `OSSUTIL_CONFIG`, `OSS_BUCKET`, `OSS_INVENTORY_ID`, `OSS_INVENTORY_RULE_XML`, `OSS_INVENTORY_DEST_BUCKET`, `OSS_INVENTORY_DEST_PREFIX`, and `OSS_INVENTORY_OUTPUT`. Pause: keep deletion workers paused with `ASSET_WORKERS_ENABLED=false`. Diagnose: reservation recovery runs every worker interval. Inspect the native inventory rule using the official positional syntax `ossutil inventory --method list "oss://$env:OSS_BUCKET" --config-file "$env:OSSUTIL_CONFIG"` and `ossutil inventory --method get "oss://$env:OSS_BUCKET" "$env:OSS_INVENTORY_ID" --local_xml_file "$env:OSS_INVENTORY_RULE_XML" --config-file "$env:OSSUTIL_CONFIG"`. Confirm the reviewed ID/destination, `Weekly` schedule, CSV format, enabled state, and native `SSE-OSS` destination encryption; OSS inventory does not provide a daily schedule or KMS destination encryption. An independent daily comparison job only consumes the newest completed native report: list reports with `ossutil ls "oss://$env:OSS_INVENTORY_DEST_BUCKET/$env:OSS_INVENTORY_DEST_PREFIX/" --config-file "$env:OSSUTIL_CONFIG"`, select the newest completed run, then download its exact `manifest.json` and every referenced CSV using `ossutil cp "oss://$env:OSS_INVENTORY_DEST_BUCKET/$env:OSS_INVENTORY_DEST_PREFIX/$env:OSS_INVENTORY_RUN/manifest.json" "$env:OSS_INVENTORY_OUTPUT/manifest.json" --config-file "$env:OSSUTIL_CONFIG"` and corresponding `ossutil cp` commands for the manifest entries. Parse with `$manifest = Get-Content -Raw "$env:OSS_INVENTORY_OUTPUT/manifest.json" | ConvertFrom-Json`; require nonempty `$manifest.creationTimestamp`, reject future or older-than-eight-days completion time, and verify every CSV checksum before comparing keys to `Asset`, `ResultImport`, and `AssetDeletion`. Expected: DB scans repair stuck reservations, the weekly SSE-OSS report is complete, and the daily consumer never treats a stale or partial report as current. Recovery: quarantine candidates and wait seven days plus second review. Verify: each candidate has no AVAILABLE asset or active import/deletion reference. Rollback/closure: restore a quarantined object if a reference appears; otherwise delete only the reviewed exact keys and resume workers.

## Private object permissions

Prerequisite: P0 incident and OSS policy owner. Pause: detach public CDN origin routing and set `ASSET_WORKERS_ENABLED=false`. Diagnose: run `ossutil api get-bucket-acl --bucket "$env:OSS_BUCKET" --config-file "$env:OSSUTIL_CONFIG"`, `ossutil api get-bucket-policy --bucket "$env:OSS_BUCKET" --config-file "$env:OSSUTIL_CONFIG"`, and `ossutil api get-bucket-public-access-block --bucket "$env:OSS_BUCKET" --config-file "$env:OSSUTIL_CONFIG"`; optionally retain the separate account-level PublicAccessBlock check. Inspect OSS access logs. Expected: ACL is private, bucket PublicAccessBlock is enabled, and policy explicitly denies anonymous list/read/write. Recovery: restore reviewed bucket/RAM policy and rotate affected sessions. Verify: `curl.exe -sS -o NUL -w "%{http_code}" "https://$env:OSS_BUCKET.$env:OSS_ENDPOINT/"` returns 403 and a service-generated short-lived signed URL returns 200. Rollback/closure: do not reopen on ambiguous exposure; preserve logs, document affected interval, then resume workers and CDN.

## Accidental deletion and final deletion

Prerequisite: authenticated owner request or approved incident restore. Pause: set `ASSET_WORKERS_ENABLED=false` before investigating early deletion. Diagnose: query `AssetDeletion` due/attempt/deleted timestamps and OSS version history. Expected: seven-day soft deletion is reversible; final deletion is idempotent only after due time. Recovery: before due time call the authenticated `POST /v1/assets/{id}/restore`; for early physical deletion restore the exact OSS version, validate checksum/MIME, then restore metadata. Verify: signed owner download works and cross-owner access remains 404. Rollback/closure: if final retention elapsed, use approved backup recovery only; never delete a prefix, then resume workers.

## CMS version rollback

Prerequisite: admin identity, last-known-good immutable version, and expected revision. Pause: set `OPERATIONS_WORKERS_ENABLED=false` only if outbox publication must stop. Diagnose: compare preview and public reads plus `support_operations_cms_publications_total`. Expected: the rollback endpoint atomically creates a new PUBLISHED content version; history is immutable. Recovery: call the authenticated `/admin/v1/content-entries/{id}/rollback` exactly once and do not call publish afterward. Verify: the returned version is PUBLISHED, packages, banners, announcements and help endpoints match the approved snapshot, and outbox backlog drains. Rollback/closure: retire the new bad version or roll back the application image; set `OPERATIONS_WORKERS_ENABLED=true`.

## Ticket privacy incident

Prerequisite: privacy incident owner and two-person access to protected audit data. Pause: restrict ticket routes at the gateway and set `OPERATIONS_WORKERS_ENABLED=false`. Diagnose: correlate principals, attachment reservations and audit events inside the protected console; never paste bodies, phones or object keys into the incident. Expected: cross-user reads are indistinguishable 404 and service calls use projected workload identity. Recovery: revoke sessions/signed URLs, release incorrect reservations, fix scope, and notify required stakeholders. Verify: owner/admin matrices pass and unauthorized ticket/attachment access remains 404. Rollback/closure: keep routes restricted if the population is unknown; preserve evidence, resume workers, and record the privacy decision.

## SMS outage

Prerequisite: Alibaba SMS status access and current sign/template allowlist. Pause: `kubectl -n ai-video set env deployment/notification-service NOTIFICATION_WORKERS_ENABLED=false`; in-app API remains available. Diagnose: check `/health/ready`, consumer lag, STS/KMS readiness, sign lookup, retry/operator gauges and provider rate limits. Expected: transient sends remain durable and permanent failures enter operator review without exposing phones. Recovery: correct provider/configuration, then set low `CONSUMER_MAX_IN_FLIGHT` and `NOTIFICATION_WORKERS_ENABLED=true`. Verify: receipts reconcile, lag/retry queues decline, and no duplicate delivery spike occurs. Rollback/closure: pause workers again on throttling; keep in-app delivery active and close after 15 stable minutes.

## UNKNOWN_ACCEPTANCE and receipt reconciliation

Prerequisite: protected notification/attempt access. Pause: set `NOTIFICATION_WORKERS_ENABLED=false` for contradictory receipts. Diagnose: query counts by `providerReceiptStatus` only; inspect request ID, receipt and send date in the protected console. Expected: `UNKNOWN_ACCEPTANCE` is reconciled, never immediately resent; only `NOT_ACCEPTED` enables retry. Recovery: resume the real receipt worker to reach DELIVERED, FAILED or NOT_ACCEPTED. Verify: attempts do not increase before NOT_ACCEPTED and exhausted cases enter operator review. Rollback/closure: do not manually mark unsent after timeout; pause and escalate ambiguous records.

## Operator queue

Prerequisite: authorized operator and second approver for bulk work. Pause: use `NOTIFICATION_WORKERS_ENABLED=false` if automated reconciliation conflicts. Diagnose: oldest-first review of template version, redacted code and attempt timeline; expected queue rows contain no plaintext phone. Recovery: record delivered, confirmed NOT_ACCEPTED, or permanent failure through the operator workflow. Verify: queue depth decreases and `ProcessedEvent` idempotency rows are unchanged. Rollback/closure: reverse only an auditable operator transition; resume workers and record both approvers.

## Notification replay and DLQ

Prerequisite: RocketMQ admin access, incident approval, an immutable envelope file whose SHA-256 is recorded, and its original event ID/tag. Pause: set `NOTIFICATION_WORKERS_ENABLED=false`. Diagnose: `mqadmin queryMsgByKey -n "$env:ROCKETMQ_NAMESRV" -t "$env:ROCKETMQ_DLQ_TOPIC" -k "$env:EVENT_ID"`; inspect only metadata/redacted reason. Expected: malformed, unknown-version, or exhausted messages remain DLQ; supported tags are the six documented notification events. Recovery: after fixing code/config, run `mqadmin sendMessage -n "$env:ROCKETMQ_NAMESRV" -t "$env:ROCKETMQ_TOPIC" -k "$env:EVENT_ID" -c "$env:EVENT_TAG" -p "$(Get-Content -Raw -LiteralPath $env:ENVELOPE_FILE)"`; this preserves the envelope bytes and ID, and no repository replay task exists. Verify: re-hash the file, query by the same key, confirm `ProcessedEvent` prevents duplicates, and watch lag/retry/operator gauges. Rollback/closure: stop workers and leave the original DLQ message retained if validation fails; never edit payload in place.

## Database migration and rollback

Prerequisite: verified snapshot, migration review, and backward-compatible application image. Pause: stop writers/workers through gateway maintenance plus all three service worker switches. Diagnose: record `_prisma_migrations` and validate against an isolated restored database. Expected: migrations are additive and deploy before application rollout. Recovery: run:

```powershell
corepack pnpm --filter @repo/asset-service prisma:validate
corepack pnpm --filter @repo/asset-service prisma:migrate:deploy
corepack pnpm --filter @repo/operations-service prisma:validate
corepack pnpm --filter @repo/operations-service prisma:migrate:deploy
corepack pnpm --filter @repo/notification-service prisma:validate
corepack pnpm --filter @repo/notification-service prisma:migrate:deploy
```

Verify: all readiness probes return 200 and from-empty schema diff is empty. Rollback/closure: roll back to the prior immutable image while schemas remain compatible; never run destructive down SQL. Restore affected rows to quarantine, validate, apply an audited forward repair, then resume workers.

## Disaster recovery

Prerequisite: declared disaster, recovery commander, RDS/OSS/RocketMQ restore points, and KMS aliases. Pause: freeze gateway writes and set all worker switches false; capture RocketMQ offsets. Diagnose: determine last consistent DB snapshot and acknowledged offset. Expected: RPO at most five minutes and RTO at most 60 minutes. Recovery: restore three databases into isolation, validate migrations/row counts/outbox-inbox uniqueness/privacy/deletion/receipt state, restore only KMS/RAM references, then reconnect private OSS and RocketMQ. Verify: start APIs first, workers at concurrency one, validate private downloads, CMS, ticket isolation, idempotency and SMS reconciliation before traffic. Rollback/closure: return to the previous recovery point if invariants fail; record measured RPO/RTO and owners.

## Container reproducibility note

Task 6 cannot update the shared lockfile. Until WS20 adds these service importers and Alibaba SDKs to `pnpm-lock.yaml`, clean Docker builds deliberately use online `pnpm install --lockfile=false --ignore-scripts`, followed by explicit Prisma generation and build. After WS20, change all three Dockerfiles to frozen-lockfile installation and verify clean-context daemon builds.
