# WS09 Edge Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现用户端和管理后台的统一 API 入口，包括 Trace、身份验证、RBAC 透传、限流、幂等头、BFF 聚合、SSE 代理、稳定错误和 OpenAPI。

**Architecture:** Gateway 不拥有领域数据，只验证访问令牌、执行边缘策略并调用内部服务。用户域和管理员域使用不同 issuer/audience/cookie；所有内部请求携带签名主体、Trace 和 Correlation 元数据。

**Tech Stack:** NestJS 12、Fastify 5、jose 6、ioredis 6、OpenAPI 3.1、Pino、Prometheus、Vitest。

---

## 文件所有权

只修改 `services/edge-gateway/**`、`docs/runbooks/edge-gateway.md`。

### Task 1: Bootstrap Gateway and stable errors

**Files:**
- Create: `services/edge-gateway/package.json`
- Create: `services/edge-gateway/src/app.ts`
- Create: `services/edge-gateway/src/http/error-handler.ts`
- Test: `services/edge-gateway/test/errors.test.ts`

- [ ] **Step 1: Write failing error test**

```ts
it('returns a stable redacted error with trace id', async () => {
  const response = await app.inject({ method: 'GET', url: '/test/error', headers: { 'x-trace-id': 'a'.repeat(32) } });
  expect(response.json()).toEqual({ code: 'INTERNAL_ERROR', message: '系统暂时不可用', retryable: true, traceId: 'a'.repeat(32) });
});
```

- [ ] **Step 2: Implement app and handler**

Create a Fastify-backed Nest app, register `traceMiddleware`, set a global error handler using `toApiError`, add CORS allowlists per environment, HSTS/CSP/security headers and a one-MiB default JSON body limit. Never reflect an upstream stack or URL in a public error.

- [ ] **Step 3: Verify and commit**

Run: `corepack pnpm --filter @repo/edge-gateway test -- errors.test.ts`

Expected: PASS.

```powershell
git add services/edge-gateway
git commit -m "feat(gateway): add secure API foundation"
```

### Task 2: Verify user and administrator tokens

**Files:**
- Create: `services/edge-gateway/src/auth/token-verifier.ts`
- Create: `services/edge-gateway/src/auth/subject.ts`
- Test: `services/edge-gateway/test/token-verifier.test.ts`

- [ ] **Step 1: Write failing audience-separation test**

```ts
it('does not accept a user token on an admin route', async () => {
  const token = await sign({ sub: userId, aud: 'user-web', iss: 'identity-service' });
  await expect(verifier.verifyAdmin(token)).rejects.toMatchObject({ code: 'INVALID_ADMIN_TOKEN' });
});
```

- [ ] **Step 2: Implement verification**

Use pinned public keys loaded from KMS/config and `jose.jwtVerify`. User tokens require `iss=identity-service`, `aud=user-web`, `sub`, `sid`. Admin tokens require `iss=iam-service`, `aud=admin-web`, `sub`, `sid`, `permissions[]`, `dataScope`. Reject `alg=none`, unknown `kid`, expired and clock-skewed tokens. Forward a short-lived internal subject assertion signed by the Gateway rather than the original browser token.

- [ ] **Step 3: Verify and commit**

Run: `corepack pnpm --filter @repo/edge-gateway test -- token-verifier.test.ts`

Expected: PASS.

```powershell
git add services/edge-gateway
git commit -m "feat(gateway): separate user and admin authentication"
```

### Task 3: Add rate limits and idempotency enforcement

**Files:**
- Create: `services/edge-gateway/src/limits/rate-limiter.ts`
- Create: `services/edge-gateway/src/http/idempotency.guard.ts`
- Test: `services/edge-gateway/test/rate-limit.test.ts`

- [ ] **Step 1: Write failing route-policy tests**

```ts
it('limits SMS requests more strictly than read APIs', async () => {
  for (let i = 0; i < 5; i++) await requestSms();
  expect((await requestSms()).statusCode).toBe(429);
  expect((await listModels()).statusCode).toBe(200);
});
it('requires idempotency-key for task and payment creation', async () => {
  expect((await app.inject({ method: 'POST', url: '/v1/tasks', payload: {} })).statusCode).toBe(400);
});
```

- [ ] **Step 2: Implement Redis Lua limits**

Key by route policy plus hashed phone/IP/user/device, use atomic sliding windows, return `Retry-After`, and fail closed for SMS/payment/task writes if Redis is unavailable. Read-only catalog endpoints may fail open with a warning metric. Require 16–128 printable characters for `idempotency-key` on task, recharge, refund and point-adjustment commands.

- [ ] **Step 3: Verify and commit**

Run: `corepack pnpm --filter @repo/edge-gateway test -- rate-limit.test.ts`

Expected: PASS.

```powershell
git add services/edge-gateway
git commit -m "feat(gateway): add distributed limits and idempotency guards"
```

### Task 4: Add typed service clients and BFF routes

**Files:**
- Create: `services/edge-gateway/src/clients/service-client.ts`
- Create: `services/edge-gateway/src/routes/user.routes.ts`
- Create: `services/edge-gateway/src/routes/admin.routes.ts`
- Test: `services/edge-gateway/test/bff.test.ts`

- [ ] **Step 1: Write failing timeout and permission tests**

```ts
it('maps an upstream timeout to retryable SERVICE_TIMEOUT', async () => {
  upstream.delayMs = 3000;
  const response = await app.inject({ method: 'GET', url: '/v1/models' });
  expect(response.json()).toMatchObject({ code: 'SERVICE_TIMEOUT', retryable: true });
});
it('blocks an admin route without its permission', async () => {
  expect((await adminRequest('/admin/v1/wallet/adjustments', ['users:read'])).statusCode).toBe(403);
});
```

- [ ] **Step 2: Implement clients**

Use `undici` with service-specific base URL, connect timeout 500 ms, headers timeout 2 s for ordinary APIs, no automatic retry for writes, one retry for idempotent reads, and circuit breakers. Forward Trace/Correlation and signed subject assertions. Define route tables mapping each external route to an internal service and required permission.

- [ ] **Step 3: Add BFF aggregation**

User dashboard aggregates wallet, recent tasks and messages with partial-result markers. Admin overview aggregates reporting and active alerts. A failed noncritical card does not fail the entire page; wallet/payment/generation command failures remain hard failures.

- [ ] **Step 4: Verify and commit**

Run: `corepack pnpm --filter @repo/edge-gateway test`

Expected: PASS.

```powershell
git add services/edge-gateway
git commit -m "feat(gateway): add typed BFF service routing"
```

### Task 5: Proxy SSE safely

**Files:**
- Create: `services/edge-gateway/src/routes/task-events.route.ts`
- Test: `services/edge-gateway/test/task-events.test.ts`

- [ ] **Step 1: Write failing ownership and reconnect tests**

```ts
it('rejects a task event stream owned by another user', async () => {
  expect((await streamTask(otherUsersTask)).statusCode).toBe(404);
});
it('forwards Last-Event-ID on reconnect', async () => {
  await streamTask(ownTask, { 'last-event-id': '42' });
  expect(upstream.lastHeaders['last-event-id']).toBe('42');
});
```

- [ ] **Step 2: Implement SSE proxy**

Verify task ownership before opening the stream. Forward `Last-Event-ID`, disable response buffering, emit a heartbeat every 15 seconds, cap each user at five active streams, close idle streams after two minutes and instruct the client to reconnect. Never cache SSE responses.

- [ ] **Step 3: Verify and commit**

Run: `corepack pnpm --filter @repo/edge-gateway test -- task-events.test.ts`

Expected: PASS.

```powershell
git add services/edge-gateway
git commit -m "feat(gateway): add authorized task event streams"
```

### Task 6: Add OpenAPI, production runtime and runbook

**Files:**
- Create: `services/edge-gateway/src/main.ts`
- Create: `services/edge-gateway/Dockerfile`
- Create: `docs/runbooks/edge-gateway.md`
- Test: `services/edge-gateway/test/openapi.test.ts`

- [ ] **Step 1: Test contract completeness**

Assert `/openapi.json` uses 3.1, documents stable error responses, security schemes, idempotency headers and SSE routes. Snapshot the operation IDs consumed by frontend API generation.

- [ ] **Step 2: Add health/metrics/image/runbook**

Readiness checks Redis, signing keys and required service DNS. Metrics cover route latency/error, auth denial, rate limit, circuit state, upstream timeout and active SSE streams without high-cardinality labels. Use a non-root multi-stage image. Runbook covers signing-key rotation, Redis outage, upstream circuit, SSE saturation, WAF/ALB headers and rollback.

- [ ] **Step 3: Verify and commit**

Run: `corepack pnpm --filter @repo/edge-gateway test:coverage && corepack pnpm --filter @repo/edge-gateway build`

Expected: PASS.

```powershell
git add services/edge-gateway docs/runbooks/edge-gateway.md
git commit -m "chore(gateway): add OpenAPI production runtime and runbook"
```

## WS09 completion gate

Run: `corepack pnpm --filter @repo/edge-gateway typecheck && corepack pnpm --filter @repo/edge-gateway test && git status --short`

Expected: clean branch, no lockfile/shared-contract changes.
