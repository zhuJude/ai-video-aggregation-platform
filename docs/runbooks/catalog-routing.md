# Catalog and Routing Runbook

## Scope and ownership

This runbook covers `catalog-service` and `quote-routing-service`: provider/model catalog,
capability publication, price and route rule versions, quotes, provider health snapshots,
margin protection and route-decision audit. Catalog data and routing data remain in separate
PostgreSQL databases; operators must not repair an incident with cross-database updates.

## Start and verify

Required configuration:

- `catalog-service`: `DATABASE_URL`, `INTERNAL_SERVICE_TOKEN`, optional `PORT` (default `3001`).
- `quote-routing-service`: `DATABASE_URL`, catalog internal base URL/token supplied through the
  deployment secret references, optional `PORT` (default `3002`).
- Secrets must be KMS/Secret Manager references. Never place provider credentials or internal
  service tokens in a capability document, routing rule, image, log or command history.

Apply the service's Prisma migrations to its own empty database before the first deployment.
For an upgrade, run migrations before shifting traffic; the migrations are additive. Start each
service and verify:

```powershell
Invoke-RestMethod http://localhost:3001/health/live
Invoke-RestMethod http://localhost:3001/health/ready
Invoke-WebRequest http://localhost:3001/metrics
Invoke-RestMethod http://localhost:3002/health/live
Invoke-RestMethod http://localhost:3002/health/ready
Invoke-WebRequest http://localhost:3002/metrics
```

Readiness must be healthy before traffic is enabled. Container processes run as UID/GID `10001`
and must not require writes to the image filesystem.

## Broken capability Schema publication

Symptoms: publication returns `CAPABILITY_DOCUMENT_INVALID`,
`CAPABILITY_JSON_SCHEMA_INVALID` or `CAPABILITY_FIELD_REFERENCE_INVALID`; dynamic forms or quotes
cannot use the draft.

1. Keep the last published capability active. Never edit its row or document.
2. Validate the draft with `CapabilityDocumentSchema`, AJV Draft 2020-12, every
   `uiSchema.order`/group field, and every `costDimensions` reference.
3. Correct the draft or create the next version, publish it, and confirm the
   `catalog.capability-published.v1` Outbox event was emitted once.
4. Simulate a quote against the new version before activating its model.
5. If a bad version was published, retire its publication and repoint the model to a known-good
   immutable version. Record actor, reason, version IDs and content hashes in the incident.

Close when public queries return only the intended published version and a form/quote smoke test
passes.

## Accidental model disablement

Symptoms: an expected model disappears from `/v1/models`; the audit reason is
`MARGIN_BELOW_MINIMUM` or an operator change.

1. Check provider health, circuit state, quota and balance before re-enabling anything.
2. Inspect the cost rule, all effective sale rules and configured minimum margin. Use integer
   points and basis points only.
3. Correct and publish a new cost/sale rule version, or rollback as described below. Do not mutate
   the version that caused the incident.
4. Run route simulation and verify the candidate is eligible and profitable.
5. Re-enable the model through the authenticated catalog administration command, then confirm the
   public catalog and metrics.

Never bypass the margin guard just to restore traffic. Close when the model is profitable, visible
and selected only under the intended policy.

## Price or route rollback

Published rules are immutable. A rollback creates a new monotonically increasing published
version whose payload copies the selected known-good version.

1. Identify the bad version and quote IDs created from it.
2. Call the relevant admin rollback endpoint with the target version, a new UUID v7, effective
   time and authorized administrator identity.
3. Run route simulation with representative parameters twice; selected model, integer price,
   score components and exclusions must match.
4. Confirm new quotes reference the new version. Existing quotes retain their original snapshots
   until expiry and must never be repriced silently.
5. Watch quote failures, margin-risk events and provider traffic for at least one quote TTL
   (ten minutes).

## Provider health or balance alert

Symptoms: provider excluded as `UNHEALTHY`, `PROVIDER_BALANCE_LOW`, `QUOTA_EXHAUSTED` or
`CIRCUIT_OPEN`.

1. Locate the latest `provider.health-updated.v1`/`provider.balance-updated.v1` sequence and Inbox
   message ID. Duplicate or lower sequences are expected to be ignored.
2. Confirm the provider dashboard independently; do not manually advance a snapshot without
   evidence.
3. Refill balance, restore credentials/quota or resolve the provider outage.
4. Wait for a higher-sequence healthy snapshot. Run route simulation before restoring priority.
5. If events stop, inspect RocketMQ consumer lag and dead letters; replay is safe because Inbox
   deduplication is mandatory.

Close when a newer healthy snapshot is stored, route simulation includes the provider, and no
balance/circuit alert remains.

## Route simulation and decision audit

Simulation is read-only and must not create a Quote. Supply the exact capability version,
parameters, candidates, integer costs/prices, health snapshot and policy version. Save the response
with the incident: every candidate must appear in either `scored` or `excluded`; selected output is
ordered by score descending, configured priority ascending, then model ID ascending.

For an actual Quote, retrieve its immutable snapshot and verify user ID, selected/candidate model
IDs, capability version, decimal-string points, cost estimate, price/route versions, parameter
SHA-256, creation/expiry, score components, exclusions and professional-mode failover consent.
Changed parameters or a quote at/after expiry must be rejected.

## Alerts and escalation

- P0: negative/overflowing quote, nondeterministic repeat quote, leaked credential reference or
  unauthorized model disablement. Stop quote traffic and page security/finance immediately.
- P1: all routes unavailable, widespread invalid publication, or margin guard unable to disable a
  loss-making model. Disable affected models and respond within ten minutes.
- P2: one provider unhealthy/balance-low or consumer lag. Allow deterministic fallback and notify
  operations.
- P3: low-margin trend or route-quality degradation. Schedule rule review.

Every alert closes only with affected IDs/versions, root cause, recovery evidence and an owner.

## Application rollback

Stop traffic shift, redeploy the previous signed image, and keep additive migrations in place.
Verify liveness/readiness/metrics, public catalog filtering, a smart simulation, a professional
simulation with failover disabled, and quote retrieval. Do not roll back by deleting published
versions, quotes, decisions, Inbox rows or Outbox rows. If the previous image cannot read an
additive schema, halt and use the forward-fix procedure instead of destructive database rollback.
