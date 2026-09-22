# Identity and IAM production runbook

## Ownership and security boundary

Identity serves end-user phone authentication and sessions on the user domain. IAM serves administrator password + MFA authentication and custom RBAC on a separate administrator domain. Their JWT issuers, audiences, cookies, session tables, Redis prefixes and KMS key references must remain separate. Never copy a secret, OTP, TOTP seed, recovery code, refresh token, phone, email, IP address, user agent or access token into logs, metrics, alerts or audit `before`/`after` fields.

Alibaba Cloud integrations accept only versioned KMS references and RAM/OIDC workload identity. Static AccessKey environment variables are rejected at startup. The official Aliyun SMS/KMS SDK and both services' production cloud adapters are a WS20 approval/wiring item. Until WS20 supplies `IdentityBootstrapOptions.cloudFactory` and `IamBootstrapOptions.cloudFactory`, both services deliberately report cloud readiness down and cloud-dependent authentication returns the expected HTTP 503. This is a full production-launch blocker, not only an SMS limitation. Do not bypass pnpm `strictDepBuilds` or change root `allowBuilds`.

The Identity factory supplies the Aliyun SMS client/config resolver, challenge/privacy HMAC providers, user JWT issuer and verification-key provider. The IAM factory supplies KMS encrypt/decrypt, HMAC, asymmetric sign-and-verify, the recovery pepper keyring, admin access verifier and bootstrap-proof authorizer. Every port must use the parsed RAM role or OIDC identity and immutable KMS references; none accepts static access keys or raw deployment secrets. Both factories must return an idempotent `close()` that disposes SDK clients exactly once. Health methods must enforce an SDK hard timeout, honor `AbortSignal`, and settle within the configured abort grace; merely accepting a signal without cancelling the SDK request is noncompliant.

## Local isolated verification

These placeholders show topology only. Substitute ephemeral local-test credentials outside source control and use dedicated test databases:

```sh
docker run --rm -d --name identity-iam-test-pg -e POSTGRES_USER=<test-user> -e POSTGRES_PASSWORD=<ephemeral-test-password> -e POSTGRES_DB=postgres -p 127.0.0.1:55438:5432 postgres:17-alpine
docker exec identity-iam-test-pg createdb -U <test-user> identity_test
docker exec identity-iam-test-pg createdb -U <test-user> iam_test
docker run --rm -d --name identity-iam-test-redis -p 127.0.0.1:56381:6379 redis:7-alpine
export IDENTITY_TEST_DATABASE_URL='postgresql://<test-user>:<ephemeral-test-password>@127.0.0.1:55438/identity_test'
export IAM_TEST_DATABASE_URL='postgresql://<test-user>:<ephemeral-test-password>@127.0.0.1:55438/iam_test'
export IDENTITY_TEST_REDIS_URL='redis://127.0.0.1:56381/15'
export IAM_TEST_REDIS_URL='redis://127.0.0.1:56381/15'
corepack pnpm --filter @repo/identity-service test:coverage
corepack pnpm --filter @repo/iam-service test:coverage
docker stop identity-iam-test-pg identity-iam-test-redis
```

Tests reject unsafe database names and use exact fixture cleanup. Never use `FLUSHDB`, `FLUSHALL`, broad key scans, truncation or full-table deletes.

Build both images from the repository root so each Dockerfile-specific allowlist applies and the shared TypeScript base config is available:

```sh
docker build -f services/identity-service/Dockerfile .
docker build -f services/iam-service/Dockerfile .
```

Each service carries an isolated, auditable `services/*/pnpm-lock.yaml`, generated with `pnpm install --lockfile-only --ignore-workspace`. The image build performs a frozen, script-free install with `--ignore-workspace`; strict dependency-build failure is disabled only for that script-free step. It then explicitly rebuilds only the service-local `allowBuilds` dependencies (`@prisma/engines`, Prisma, esbuild and IAM Argon2) before compilation and production pruning. This keeps native lifecycle execution explicit without weakening the root policy or rewriting the repository lock. `Dockerfile.dockerignore` defaults to excluding the root context and permits only `tsconfig.base.json` plus that service's manifest, local lock, build allowlist, source, Prisma schema/migrations and build scripts. Final deny rules exclude Git metadata, environment files, tests, coverage, local modules and secret-like files even when nested below an allowed source directory.

## Start and migrate

Run migrations once per release, before shifting traffic:

```sh
corepack pnpm --filter @repo/identity-service prisma:migrate
corepack pnpm --filter @repo/iam-service prisma:migrate
corepack pnpm --filter @repo/identity-service start:prod
corepack pnpm --filter @repo/iam-service start:prod
```

Required Identity variables (values are supplied by the secret/config platform; only references belong in deployment manifests):

- `IDENTITY_DATABASE_URL`, `IDENTITY_REDIS_URL`, optional `IDENTITY_HOST`, `IDENTITY_PORT`
- `IDENTITY_SMS_CHALLENGE_KMS_KEY_REF`, `IDENTITY_PRIVACY_KMS_KEY_REF`, optional overlap list `IDENTITY_PREVIOUS_PRIVACY_KMS_KEY_REFS`
- `IDENTITY_JWT_SIGNING_KMS_KEY_REF`
- `IDENTITY_SMS_SIGN_NAME_KMS_REF`, `IDENTITY_SMS_TEMPLATE_KMS_REF`, `IDENTITY_SMS_ROLE_KMS_REF`, `IDENTITY_SMS_CREDENTIAL_KIND` (`ecs_ram_role` or `oidc_role_arn`)
- optional `IDENTITY_READINESS_TIMEOUT_MS`, `IDENTITY_READINESS_ABORT_GRACE_MS`, `IDENTITY_EVENT_LOOP_STALL_MS`
- optional business limits `IDENTITY_DATABASE_OPERATION_TIMEOUT_MS`, `IDENTITY_REDIS_OPERATION_TIMEOUT_MS` (defaults 5000 ms; valid 100–60000 ms). Do not copy the readiness timeout into these values.

Required IAM variables:

- `IAM_DATABASE_URL`, `IAM_REDIS_URL`, optional `IAM_HOST`, `IAM_PORT`
- `IAM_JWT_SIGNING_KMS_KEY_REF`, optional `IAM_PREVIOUS_JWT_SIGNING_KMS_KEY_REFS`
- `IAM_TOTP_KMS_KEY_REF`, optional `IAM_PREVIOUS_TOTP_KMS_KEY_REFS`
- `IAM_LOGIN_HMAC_KMS_KEY_REF`, optional `IAM_PREVIOUS_LOGIN_HMAC_KMS_KEY_REFS`
- `IAM_RECOVERY_PEPPER_KMS_KEY_REF`, optional `IAM_PREVIOUS_RECOVERY_PEPPER_KMS_KEY_REFS`
- `IAM_BOOTSTRAP_PROOF_KMS_REF`, `IAM_DUMMY_PASSWORD_HASH`
- `IAM_KMS_IDENTITY_MODE`; for ECS RAM role, `IAM_KMS_ECS_RAM_ROLE_NAME`; for OIDC, `IAM_KMS_OIDC_ROLE_ARN`, `IAM_KMS_OIDC_PROVIDER_ARN`, `IAM_KMS_OIDC_CLIENT_ID`
- optional `IAM_READINESS_TIMEOUT_MS`, `IAM_READINESS_ABORT_GRACE_MS`, `IAM_EVENT_LOOP_STALL_MS`
- optional business limits `IAM_DATABASE_OPERATION_TIMEOUT_MS`, `IAM_REDIS_OPERATION_TIMEOUT_MS` (defaults 5000 ms; valid 100–60000 ms). Do not copy the readiness timeout into these values.
- optional `IAM_PENDING_CLEANUP_INTERVAL_MS` in milliseconds (1000–3600000 ms; for example `60000`), `IAM_PENDING_CLEANUP_BATCH_SIZE` (1–500)

The URLs and resolved secret material must be injected from the deployment secret store, never committed. Apply least-privilege RAM policy: encryption/decryption only for the TOTP keyring, HMAC only for identifier/pepper references, asymmetric sign+verify only for the admin JWT key, and read-only config resolution for SMS references.

## Probes and metrics

- `GET /healthz` is process liveness. It returns 503 when the event-loop watchdog observes a stall beyond the configured threshold. Do not use it to decide whether a migration or dependency is ready.
- `GET /readyz` is traffic readiness. It checks PostgreSQL, Redis/Tair, every current and retained KMS reference, IAM pending cleanup, and Identity SMS. PostgreSQL and Redis probes use clients separate from business traffic. Cached single-flight probes share one bounded operation across concurrent callers and send an abort signal on timeout. A cooperative adapter settles within abort grace and can recover on the next probe cycle. A noncooperative adapter remains in the same occupied slot, reports stable `adapter_stuck`, increments the fixed-cardinality stuck metric and is never duplicated. Responses expose only `up`, `down`, `timeout`, or `adapter_stuck`.
- `GET /metrics` emits Prometheus text. Identity exports login successes/failures, `identity_sms_rate_limit_rejections_total`, `identity_readiness_adapter_stuck_total`, and active sessions; only planned rate-limit/attempt-lock codes increment the SMS counter. IAM exports login successes/failures, true MFA rejections, authorization denials, cleanup failures/cleaned count/health, `iam_readiness_adapter_stuck_total`, and active sessions. No metric has PII or high-cardinality labels.

If `adapter_stuck` appears, take the instance out of traffic. Confirm the WS20 adapter uses the SDK request timeout and abort/cancel API, then invoke its bounded `close()` during replacement. The current instance deliberately does not clear the occupied probe slot or create another request. If the adapter cannot settle, restart the instance after disposal timeout; do not claim next-cycle recovery for a noncooperative Promise.

After WS20 wiring, require `/readyz` 200, then smoke Identity SMS request → verify/login → refresh and IAM password → TOTP/recovery MFA → refresh → guarded RBAC allow/deny. Stop with SIGTERM and SIGINT in separate controlled tests, wait for the structured stopping event, and confirm cleanup, Redis and Prisma resources close before exit.

Alert on sustained readiness failure, SMS rejection rate, MFA failures, authorization denials, refresh-family reuse and pending-session cleanup failures. A liveness failure should restart the process; readiness failure should only remove it from traffic.

## Rotation procedures

Use overlap, observe, then retire. Never point a versioned reference at `latest`, `current` or another floating alias.

1. Create a new immutable KMS version and grant the workload access.
2. Put the new reference in the current variable and retain the old reference in the corresponding `PREVIOUS_*` list/keyring.
3. Deploy and require `/readyz` to prove both current and retained references usable.
4. Observe at least the maximum relevant lifetime (SMS OTP 5 minutes; admin access JWT 10 minutes; user access JWT 15 minutes; refresh/session lifetime 30 days where verification requires the old key).
5. Remove the old reference, redeploy, then revoke its RAM permission.

TOTP ciphertext embeds the controlled key version and decrypts using current+previous keyring. Recovery-code rows carry their pepper version and remain usable during overlap; regeneration invalidates all earlier recovery codes. Login identifier HMAC rotation must retain previous candidates so existing Redis lockout budgets are not split or reset. Redis keys use a stable non-PII cluster hash tag; verify all Lua keys map to one slot before enabling Tair/Redis Cluster. JWT verification must retain required old public keys until all issued access tokens expire. KMS signing responses are verified before JWT issuance.

## Incidents and recovery

Aliyun SMS outage: keep Identity running but not ready for SMS-dependent traffic, verify RAM/OIDC token acquisition, KMS config references, approved SDK version and provider status. Do not log phone/code or switch to static access keys. Existing valid sessions and non-SMS operations may be routed only if the gateway supports dependency-aware routing.

Redis/Tair outage: SMS issue/verify and administrator password admission fail closed. Do not replace atomic Lua paths with process memory in production. Confirm TLS/DNS, authentication, cluster slot compatibility and latency; restore Redis before re-enabling login traffic. Never flush a shared database during diagnosis.

KMS/JWT outage: readiness goes down. Do not issue unsigned/local production tokens. Pending MFA/refresh sessions cannot become active until KMS signing and verification succeeds; the reserved factor is released on failed signing so a recovery code can be retried. Even if an access token was signed during a disable race, session enforcement must reject it after the atomic disable transaction revokes all sessions.

Administrator lockout: an existing active protected super-admin may regenerate recovery codes after a verified TOTP. Recovery codes are shown once, stored only as versioned secure digests and consumed atomically. If every administrator is locked out, use the approved break-glass bootstrap proof reference with two-person authorization; never edit role/session tables manually. Export the relevant append-only audit range and incident trace IDs.

Last super-admin: disabling, demoting or revoking the last ACTIVE protected super-admin is rejected under database locks. A disabled former super-admin assignment can be removed. If protection fires unexpectedly, inspect active admin status and protected assignments; do not update the protected role or bypass `disableAdminAccess`.

Audit export: query the bounded, cursor-paginated IAM audit API and write the export to the approved immutable evidence store. Database triggers reject audit update/delete/truncate. Treat audit IP/UA and resource snapshots as restricted data even though secret fields are deeply redacted.

Pending cleanup: schedule `PrismaAdminAuthRepository.cleanupExpiredPendingSessions(now, boundedLimit)` in the operations worker (Task6 host integration) at a small bounded batch size until it returns zero. It targets expired PENDING rows only, releases factor reservations under the same locks and never performs a broad delete. Alert on cleanup observer failures and retry; do not hide compensation errors.

## Rollback

Application rollback is permitted only while the previous binary understands every applied forward-compatible migration and all current key versions. Keep migrations applied; never down-migrate or truncate identity/IAM tables. Restore the prior image, retain both old and new KMS references during the rollback window, verify `/healthz`, `/readyz`, `/metrics`, one user SMS flow, one administrator password→MFA flow, refresh rotation and an RBAC denial. If schema compatibility or key overlap cannot be proven, stop traffic and roll forward with a corrected build instead.
