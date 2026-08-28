# WS13 Generation and Provider Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现生成任务状态机、报价/冻结 Saga、Outbox/Inbox、供应商 Worker、Mock Provider、回调/轮询、重试熔断、安全故障切换和最终结算编排。

**Architecture:** `generation-service` 拥有用户任务与状态，`provider-runtime` 拥有外部执行；二者通过 RocketMQ 事件解耦。Mock Provider 提供所有成功和失败模式，真实适配器通过冻结 Provider SDK 接入。

**Tech Stack:** NestJS、Prisma/PostgreSQL、RocketMQ client、ioredis、Provider SDK、Vitest、Testcontainers、MSW。

---

## 文件所有权

只修改 `services/generation-service/**`、`services/provider-runtime/**`、`providers/mock-provider/**`、`docs/runbooks/generation-provider.md`。

### Task 1: Implement the task state machine

**Files:**
- Create: `services/generation-service/src/domain/task-state-machine.ts`
- Create: `services/generation-service/prisma/schema.prisma`
- Test: `services/generation-service/test/task-state-machine.test.ts`

- [ ] **Step 1: Write failing transition tests**

```ts
import { transition } from '../src/domain/task-state-machine.js';
it('permits the success path', () => {
  expect(transition('RUNNING', 'SUCCEEDED')).toBe('SUCCEEDED');
  expect(transition('SUCCEEDED', 'SETTLED')).toBe('SETTLED');
});
it('rejects a terminal regression', () => expect(() => transition('SETTLED', 'RUNNING')).toThrow('ILLEGAL_TASK_TRANSITION'));
```

- [ ] **Step 2: Implement explicit transitions**

```ts
import type { z } from 'zod';
import { TaskStatusSchema } from '@repo/contracts/generation';
type TaskStatus = z.infer<typeof TaskStatusSchema>;
const allowed: Record<TaskStatus, readonly TaskStatus[]> = {
  QUOTED: ['RESERVED'], RESERVED: ['QUEUED', 'REFUNDED'], QUEUED: ['SUBMITTING', 'CANCELED', 'EXPIRED'],
  SUBMITTING: ['RUNNING', 'FAILED'], RUNNING: ['SUCCEEDED', 'FAILED', 'CANCELED', 'EXPIRED'],
  SUCCEEDED: ['SETTLED'], FAILED: ['REFUNDED'], CANCELED: ['REFUNDED', 'SETTLED'], EXPIRED: ['REFUNDED'],
  SETTLED: [], REFUNDED: [],
};
export function transition(current: TaskStatus, next: TaskStatus): TaskStatus {
  if (!allowed[current].includes(next)) throw Object.assign(new Error('ILLEGAL_TASK_TRANSITION'), { code: 'ILLEGAL_TASK_TRANSITION', current, next });
  return next;
}
```

Create models `GenerationTask`, `TaskTransition`, `TaskIdempotency`, `OutboxEvent`, `InboxMessage`, and `TaskRepairCase`. Store quote, capability, pricing and parameters snapshots as JSON plus SHA-256; use integer `version` for optimistic locking.

- [ ] **Step 3: Run and commit**

Run: `corepack pnpm --filter @repo/generation-service test -- task-state-machine.test.ts`

Expected: PASS.

```powershell
git add services/generation-service
git commit -m "feat(generation): add explicit task state machine"
```

### Task 2: Implement idempotent task creation Saga

**Files:**
- Create: `services/generation-service/src/application/create-task.service.ts`
- Test: `services/generation-service/test/create-task.integration.test.ts`

- [ ] **Step 1: Write failing duplicate and compensation tests**

```ts
it('returns one task for repeated idempotency keys', async () => {
  const [a, b] = await Promise.all([service.execute(command, 'idem-1'), service.execute(command, 'idem-1')]);
  expect(a.taskId).toBe(b.taskId);
  expect(wallet.reserve).toHaveBeenCalledTimes(1);
});
it('releases frozen points when task persistence cannot complete', async () => {
  repository.failNextInsert = true;
  await expect(service.execute(command, 'idem-2')).rejects.toBeDefined();
  expect(wallet.release).toHaveBeenCalledWith(expect.objectContaining({ businessKey: expect.stringContaining(':release') }));
});
```

- [ ] **Step 2: Implement the Saga**

Validate the frozen Quote through routing internal API, reserve `quotedPoints` with business key `task:<taskId>:reserve`, create task and Outbox event transactionally, then return `202 Accepted`. Persist idempotency key before external calls with `IN_PROGRESS`; contenders poll the same row. If task persistence exhausts retries, release with `task:<taskId>:create-compensation`.

- [ ] **Step 3: Add user endpoints and commit**

Implement `POST /v1/tasks`, `GET /v1/tasks`, `GET /v1/tasks/:id`, `POST /v1/tasks/:id/cancel`, `POST /v1/tasks/:id/retry` and `GET /v1/tasks/:id/events` SSE. Enforce ownership and stable cursor pagination.

Run: `corepack pnpm --filter @repo/generation-service test`

Expected: PASS.

```powershell
git add services/generation-service
git commit -m "feat(generation): add idempotent task creation Saga"
```

### Task 3: Build the deterministic Mock Provider

**Files:**
- Create: `providers/mock-provider/package.json`
- Create: `providers/mock-provider/src/server.ts`
- Test: `providers/mock-provider/test/scenarios.test.ts`

- [ ] **Step 1: Write failing scenario tests**

```ts
it.each(['success', 'failed', 'timeout', 'rate-limit', 'server-error', 'callback-lost', 'callback-duplicate', 'callback-out-of-order'])('supports %s', async (scenario) => {
  const response = await client.create({ scenario, idempotencyKey: `case-${scenario}` });
  expect(response.scenario).toBe(scenario);
});
```

- [ ] **Step 2: Implement the server**

Expose `POST /tasks`, `GET /tasks/:id`, `POST /tasks/:id/cancel`, `GET /balance`. A request header `x-mock-scenario` selects a deterministic scenario. Store idempotency keys and return the same provider task ID. Sign callbacks with HMAC-SHA256 and sequence numbers. Duplicate/out-of-order scenarios emit controlled event sequences without randomness.

- [ ] **Step 3: Run and commit**

Run: `corepack pnpm --filter @repo/mock-provider test`

Expected: all scenario tests pass.

```powershell
git add providers/mock-provider
git commit -m "test(provider): add deterministic mock provider"
```

### Task 4: Implement provider execution and retry policy

**Files:**
- Create: `services/provider-runtime/prisma/schema.prisma`
- Create: `services/provider-runtime/src/application/execution.service.ts`
- Create: `services/provider-runtime/src/domain/retry-policy.ts`
- Test: `services/provider-runtime/test/retry-policy.test.ts`

- [ ] **Step 1: Write failing retry tests**

```ts
it.each([[429, true], [500, true], [503, true], [400, false], [401, false]])('classifies %i retryable=%s', (status, expected) => {
  expect(classifyHttpFailure(status).retryable).toBe(expected);
});
it('caps exponential backoff', () => expect(backoffMs(20, 0)).toBeLessThanOrEqual(300_000));
```

- [ ] **Step 2: Implement policy**

```ts
export function classifyHttpFailure(status: number): { retryable: boolean; code: string } {
  if (status === 429) return { retryable: true, code: 'PROVIDER_RATE_LIMITED' };
  if (status >= 500) return { retryable: true, code: 'PROVIDER_UNAVAILABLE' };
  if (status === 401 || status === 403) return { retryable: false, code: 'PROVIDER_AUTH_FAILED' };
  return { retryable: false, code: 'PROVIDER_REJECTED' };
}
export function backoffMs(attempt: number, jitter: number): number {
  return Math.min(300_000, 1_000 * 2 ** Math.min(attempt, 8)) + Math.max(0, Math.min(jitter, 1_000));
}
```

Create models `ProviderExecution`, `ProviderAttempt`, `CallbackInbox`, `CircuitState`, `OutboxEvent`. Consume `generation.task-queued.v1`; write execution and attempt before calling adapter; use task ID as adapter idempotency key. ACK a message only after durable state and follow-up event are committed.

- [ ] **Step 3: Verify and commit**

Run: `corepack pnpm --filter @repo/provider-runtime test`

Expected: PASS.

```powershell
git add services/provider-runtime
git commit -m "feat(provider): add durable execution and retry policy"
```

### Task 5: Implement callback, polling and circuit breaker

**Files:**
- Create: `services/provider-runtime/src/http/provider-callback.controller.ts`
- Create: `services/provider-runtime/src/application/polling.consumer.ts`
- Create: `services/provider-runtime/src/domain/circuit-breaker.ts`
- Test: `services/provider-runtime/test/callback.integration.test.ts`

- [ ] **Step 1: Write failing duplicate/out-of-order tests**

```ts
it('applies the highest valid provider sequence once', async () => {
  await service.handle(callback('SUCCEEDED', 3));
  await service.handle(callback('RUNNING', 2));
  await service.handle(callback('SUCCEEDED', 3));
  expect(events.publish).toHaveBeenCalledTimes(1);
  expect(await executionState()).toBe('SUCCEEDED');
});
```

- [ ] **Step 2: Implement callback and polling**

Verify adapter signature before parsing, enforce unique provider event ID and monotonic sequence, normalize state, update execution and Outbox in one transaction. Schedule delayed polling when no callback is expected or callback deadline expires. Polls carry attempt number and stop at terminal state.

- [ ] **Step 3: Implement circuit breaker**

Open a provider/model circuit after 10 qualifying failures in a 60-second rolling window with at least 50% failure rate. Stay open 60 seconds, allow one half-open probe, then close on success or reopen on failure. Auth failure and zero balance open immediately and emit P1/P2 health events.

- [ ] **Step 4: Verify and commit**

Run: `corepack pnpm --filter @repo/provider-runtime test`

Expected: PASS.

```powershell
git add services/provider-runtime
git commit -m "feat(provider): add callback polling and circuit breaker"
```

### Task 6: Orchestrate success, failure, cancel and safe failover

**Files:**
- Create: `services/generation-service/src/application/provider-events.consumer.ts`
- Create: `services/generation-service/src/application/task-repair.job.ts`
- Test: `services/generation-service/test/provider-events.integration.test.ts`

- [ ] **Step 1: Write failing financial-effect tests**

```ts
it('settles only after the asset is durable', async () => {
  await consumer.onSucceeded(providerEvent);
  expect(asset.importResult).toHaveBeenCalledBefore(wallet.settle as never);
  expect(wallet.settle).toHaveBeenCalledWith(expect.objectContaining({ points: quotedPoints }));
});
it('fully releases points after provider failure', async () => {
  await consumer.onFailed(providerFailure);
  expect(wallet.release).toHaveBeenCalledWith(expect.objectContaining({ points: quotedPoints }));
});
```

- [ ] **Step 2: Implement terminal Sagas**

On success, request asset import, wait for `asset.imported.v1`, then settle and release any quote difference before marking `SETTLED`. On failure, transition to FAILED then release full frozen points and mark REFUNDED. Cancel before provider acceptance releases fully. After acceptance, call optional adapter cancellation and apply the task's stored cancellation rule.

- [ ] **Step 3: Implement safe failover and repair**

Failover only when routing authorized it, the original provider is confirmed unaccepted/unbilled, the substitute satisfies capability version, and substitute price does not exceed quote. Repair job scans stale statuses using status-specific deadlines, queries Provider Runtime, and creates an operator case when the outcome is ambiguous.

- [ ] **Step 4: Verify and commit**

Run: `corepack pnpm --filter @repo/generation-service test`

Expected: PASS.

```powershell
git add services/generation-service
git commit -m "feat(generation): add terminal settlement and repair Sagas"
```

### Task 7: Add metrics, production images and runbook

**Files:**
- Create: `services/generation-service/Dockerfile`
- Create: `services/provider-runtime/Dockerfile`
- Create: `providers/mock-provider/Dockerfile`
- Create: `docs/runbooks/generation-provider.md`

- [ ] **Step 1: Add runtime endpoints and metrics**

Expose liveness/readiness/metrics. Metrics cover task state totals, transition failures, queue age, provider latency/error/circuit, polling backlog, repair cases and financial Saga lag. Do not use task/user IDs as labels.

- [ ] **Step 2: Add non-root images and runbook**

Document callback verification, circuit recovery, dead-letter replay, ambiguous provider status, stuck task repair, safe failover, Mock Provider scenarios and rollback.

- [ ] **Step 3: Verify and commit**

Run: `corepack pnpm --filter @repo/generation-service test:coverage && corepack pnpm --filter @repo/provider-runtime test:coverage && corepack pnpm --filter @repo/mock-provider test`

Expected: PASS and generation domain rules meet 95% coverage.

```powershell
git add services/generation-service services/provider-runtime providers/mock-provider docs/runbooks/generation-provider.md
git commit -m "chore(generation): add production runtime and runbook"
```

## WS13 completion gate

Run: `corepack pnpm --filter @repo/generation-service build && corepack pnpm --filter @repo/provider-runtime build && corepack pnpm --filter @repo/mock-provider build && git status --short`

Expected: builds pass, branch is clean, lockfile/shared contracts unchanged.
