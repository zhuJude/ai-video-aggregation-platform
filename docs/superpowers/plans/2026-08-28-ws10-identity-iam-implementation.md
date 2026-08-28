# WS10 Identity and IAM Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现用户手机号登录、会话/设备、后台管理员 MFA、自定义 RBAC、数据范围和不可删除审计日志。

**Architecture:** `identity-service` 只拥有终端用户身份，`iam-service` 只拥有后台管理员与授权。两个服务使用独立 Prisma schema/database，通过 Gateway 传递已验证主体；验证码和会话撤销使用 Redis，但数据库保存可审计事实。

**Tech Stack:** NestJS 12、Fastify 5、Prisma Client 7.10、PostgreSQL、ioredis 6、jose 6、otplib 13、argon2 0.45、Vitest、Testcontainers。

---

## 文件所有权

只修改 `services/identity-service/**`、`services/iam-service/**`、`docs/runbooks/identity-iam.md`。不得修改共享契约或 `pnpm-lock.yaml`。

### Task 1: Create identity persistence and phone value object

**Files:**
- Create: `services/identity-service/package.json`
- Create: `services/identity-service/prisma/schema.prisma`
- Create: `services/identity-service/src/domain/phone.ts`
- Test: `services/identity-service/test/phone.test.ts`

- [ ] **Step 1: Write the failing phone test**

```ts
import { describe, expect, it } from 'vitest';
import { Phone } from '../src/domain/phone.js';
describe('Phone', () => {
  it('normalizes a mainland number', () => expect(Phone.parse('13800138000').e164).toBe('+8613800138000'));
  it('rejects malformed numbers', () => expect(() => Phone.parse('123')).toThrow('INVALID_PHONE'));
});
```

- [ ] **Step 2: Run and verify failure**

Run: `corepack pnpm --filter @repo/identity-service test -- phone.test.ts`

Expected: FAIL because the service and `Phone` do not exist.

- [ ] **Step 3: Implement the value object and schema**

```ts
// services/identity-service/src/domain/phone.ts
export class Phone {
  private constructor(readonly e164: string) {}
  static parse(input: string): Phone {
    const digits = input.replace(/[\s-]/g, '');
    if (!/^1\d{10}$/.test(digits)) throw Object.assign(new Error('INVALID_PHONE'), { code: 'INVALID_PHONE' });
    return new Phone(`+86${digits}`);
  }
  masked(): string { return `${this.e164.slice(0, 5)}****${this.e164.slice(-4)}`; }
}
```

```prisma
// services/identity-service/prisma/schema.prisma
generator client { provider = "prisma-client-js" output = "../src/generated/prisma" }
datasource db { provider = "postgresql" url = env("IDENTITY_DATABASE_URL") }
model User {
  id          String   @id @db.Uuid
  phoneE164   String   @unique @map("phone_e164")
  nickname    String
  status      String   @default("ACTIVE")
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")
  sessions    Session[]
  @@map("users")
}
model Session {
  id               String   @id @db.Uuid
  userId           String   @db.Uuid @map("user_id")
  refreshTokenHash String   @unique @map("refresh_token_hash")
  deviceName       String   @map("device_name")
  expiresAt        DateTime @map("expires_at")
  revokedAt        DateTime? @map("revoked_at")
  createdAt        DateTime @default(now()) @map("created_at")
  user             User     @relation(fields: [userId], references: [id])
  @@index([userId, revokedAt])
  @@map("sessions")
}
```

- [ ] **Step 4: Add the service manifest and verify**

Create `services/identity-service/package.json` with name `@repo/identity-service`, NestJS/Prisma/jose/ioredis dependencies, and scripts `build`, `dev`, `lint`, `typecheck`, `test`, `test:coverage`, `prisma:generate`, `prisma:migrate`.

Run: `corepack pnpm install --lockfile=false && corepack pnpm --filter @repo/identity-service prisma:generate && corepack pnpm --filter @repo/identity-service test -- phone.test.ts`

Expected: PASS with 2 tests.

- [ ] **Step 5: Commit**

```powershell
git add services/identity-service
git commit -m "feat(identity): add user persistence and phone validation"
```

### Task 2: Implement SMS challenges with rate limits

**Files:**
- Create: `services/identity-service/src/application/sms-challenge.service.ts`
- Create: `services/identity-service/src/ports/sms-sender.ts`
- Create: `services/identity-service/src/adapters/aliyun-sms.sender.ts`
- Test: `services/identity-service/test/sms-challenge.test.ts`

- [ ] **Step 1: Write failing expiry and attempt tests**

```ts
import { describe, expect, it } from 'vitest';
import { SmsChallengeService } from '../src/application/sms-challenge.service.js';
class MemoryStore { data = new Map<string, { code: string; attempts: number; expiresAt: number }>(); }
describe('SmsChallengeService', () => {
  it('accepts once and deletes the challenge', async () => {
    const store = new MemoryStore();
    const service = new SmsChallengeService(store, () => 1000);
    await service.issue('+8613800138000', '123456');
    await expect(service.verify('+8613800138000', '123456')).resolves.toBe(true);
    await expect(service.verify('+8613800138000', '123456')).resolves.toBe(false);
  });
  it('locks after five bad attempts', async () => {
    const store = new MemoryStore();
    const service = new SmsChallengeService(store, () => 1000);
    await service.issue('+8613800138000', '123456');
    for (let i = 0; i < 5; i++) await service.verify('+8613800138000', '000000');
    await expect(service.verify('+8613800138000', '123456')).rejects.toMatchObject({ code: 'SMS_CHALLENGE_LOCKED' });
  });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `corepack pnpm --filter @repo/identity-service test -- sms-challenge.test.ts`

Expected: FAIL because `SmsChallengeService` does not exist.

- [ ] **Step 3: Implement single-use challenges**

```ts
export interface ChallengeStore {
  data: Map<string, { code: string; attempts: number; expiresAt: number }>;
}
export class SmsChallengeService {
  constructor(private readonly store: ChallengeStore, private readonly now: () => number = Date.now) {}
  async issue(phone: string, code: string): Promise<void> {
    const current = this.store.data.get(phone);
    if (current && current.expiresAt - 240_000 > this.now()) throw Object.assign(new Error('SMS_RATE_LIMITED'), { code: 'SMS_RATE_LIMITED' });
    this.store.data.set(phone, { code, attempts: 0, expiresAt: this.now() + 300_000 });
  }
  async verify(phone: string, code: string): Promise<boolean> {
    const item = this.store.data.get(phone);
    if (!item || item.expiresAt <= this.now()) { this.store.data.delete(phone); return false; }
    if (item.attempts >= 5) throw Object.assign(new Error('SMS_CHALLENGE_LOCKED'), { code: 'SMS_CHALLENGE_LOCKED' });
    if (item.code !== code) { item.attempts += 1; return false; }
    this.store.data.delete(phone); return true;
  }
}
```

- [ ] **Step 4: Add Redis and SMS sender adapters**

Implement `RedisChallengeStore` using keys `sms:challenge:<sha256(phone)>` with a five-minute TTL and atomic Lua verification. Define `SmsSender` as `sendCode(phoneE164: string, code: string): Promise<void>`. `AliyunSmsSender` uses `@alicloud/dysmsapi20170525@4.6.0`, a RAM role rather than embedded access keys, configured sign/template names, and sends only the declared `code` template variable. Convert `+86` E.164 to the eleven-digit domestic number only at the adapter boundary. A `LoggingSmsSender` is enabled only when `APP_ENV=local` and logs only the phone hash and template key.

Run: `corepack pnpm --filter @repo/identity-service test`

Expected: PASS, including an integration test against Redis when `REDIS_URL` is set.

- [ ] **Step 5: Commit**

```powershell
git add services/identity-service
git commit -m "feat(identity): add rate-limited SMS challenges"
```

### Task 3: Implement user sessions and refresh rotation

**Files:**
- Create: `services/identity-service/src/application/session.service.ts`
- Create: `services/identity-service/src/http/auth.controller.ts`
- Test: `services/identity-service/test/session.test.ts`

- [ ] **Step 1: Write the failing refresh reuse test**

```ts
it('revokes the token family when a consumed refresh token is reused', async () => {
  const first = await service.create(userId, 'Chrome');
  const rotated = await service.rotate(first.refreshToken);
  await expect(service.rotate(first.refreshToken)).rejects.toMatchObject({ code: 'REFRESH_REUSE_DETECTED' });
  await expect(service.rotate(rotated.refreshToken)).rejects.toMatchObject({ code: 'SESSION_REVOKED' });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `corepack pnpm --filter @repo/identity-service test -- session.test.ts`

Expected: FAIL because session rotation is not implemented.

- [ ] **Step 3: Implement access and refresh tokens**

Use `jose` to sign a 15-minute access token with claims `sub`, `sid`, `aud=user-web`, `iss=identity-service`. Generate a 32-byte random refresh token, store only SHA-256, rotate it transactionally, and mark the previous row consumed. On reuse, revoke all rows sharing the same `familyId`. Set the browser refresh cookie `HttpOnly; Secure; SameSite=Lax; Path=/auth/refresh`.

- [ ] **Step 4: Add HTTP endpoints and verify**

Implement:

```text
POST /v1/auth/sms/request
POST /v1/auth/sms/verify
POST /v1/auth/refresh
POST /v1/auth/logout
GET  /v1/sessions
DELETE /v1/sessions/:id
PATCH /v1/profile
POST /v1/phone-change/sms/request
POST /v1/phone-change/sms/verify
DELETE /v1/account
```

Changing phone requires verification of both the current and new phone and a uniqueness transaction. Account deletion requires a fresh SMS challenge, revokes every session, sets status `CLOSED`, and writes `identity.user-closed.v1` through Outbox so other domains can apply their approved retention/anonymization policy without deleting financial facts.

Run: `corepack pnpm --filter @repo/identity-service test && corepack pnpm --filter @repo/identity-service typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add services/identity-service
git commit -m "feat(identity): add rotating user sessions"
```

### Task 4: Implement administrator MFA

**Files:**
- Create: `services/iam-service/prisma/schema.prisma`
- Create: `services/iam-service/src/application/admin-auth.service.ts`
- Test: `services/iam-service/test/admin-auth.test.ts`

- [ ] **Step 1: Write failing MFA tests**

```ts
it('does not issue an admin session without a valid TOTP', async () => {
  const passwordStep = await service.verifyPassword('ops@example.com', 'correct-password');
  await expect(service.verifyTotp(passwordStep.challengeId, '000000')).rejects.toMatchObject({ code: 'INVALID_MFA' });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `corepack pnpm --filter @repo/iam-service test -- admin-auth.test.ts`

Expected: FAIL because `iam-service` does not exist.

- [ ] **Step 3: Implement admin persistence and authentication**

Create Prisma models `AdminUser`, `AdminSession`, `Role`, `Permission`, `AdminRole`, `RolePermission`, and append-only `AuditEvent`. Hash passwords with Argon2id. Encrypt TOTP secrets through a `SecretCipher` port; local implementation uses AES-256-GCM from a development key, production implementation reads KMS. Require password step then TOTP step before issuing a 10-minute admin access token and rotating refresh cookie.

- [ ] **Step 4: Run tests and commit**

Run: `corepack pnpm --filter @repo/iam-service test && corepack pnpm --filter @repo/iam-service typecheck`

Expected: PASS.

```powershell
git add services/iam-service
git commit -m "feat(iam): require MFA for administrators"
```

### Task 5: Implement RBAC, data scopes and audit

**Files:**
- Create: `services/iam-service/src/domain/authorization.ts`
- Create: `services/iam-service/src/application/audit.service.ts`
- Create: `services/iam-service/src/http/roles.controller.ts`
- Test: `services/iam-service/test/authorization.test.ts`

- [ ] **Step 1: Write failing authorization tests**

```ts
import { can } from '../src/domain/authorization.js';
it('requires both permission and matching data scope', () => {
  const subject = { permissions: ['users:read'], dataScope: 'OWN' as const, adminId: 'a1' };
  expect(can(subject, 'users:read', { ownerAdminId: 'a1' })).toBe(true);
  expect(can(subject, 'users:read', { ownerAdminId: 'a2' })).toBe(false);
  expect(can(subject, 'wallet:adjust', { ownerAdminId: 'a1' })).toBe(false);
});
```

- [ ] **Step 2: Run and verify failure**

Run: `corepack pnpm --filter @repo/iam-service test -- authorization.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement deterministic authorization**

```ts
type Scope = 'ALL' | 'OWN' | 'ASSIGNED';
interface Subject { permissions: string[]; dataScope: Scope; adminId: string }
interface Resource { ownerAdminId?: string; assignedAdminIds?: string[] }
export function can(subject: Subject, permission: string, resource: Resource): boolean {
  if (!subject.permissions.includes(permission)) return false;
  if (subject.dataScope === 'ALL') return true;
  if (subject.dataScope === 'OWN') return resource.ownerAdminId === subject.adminId;
  return resource.assignedAdminIds?.includes(subject.adminId) ?? false;
}
```

- [ ] **Step 4: Add role APIs and append-only audit**

Implement role CRUD with optimistic version checks, administrator assignment, permission listing and audit queries. `AuditService.append()` stores actor, action, resource, before/after redacted JSON, IP, user agent, Trace ID and timestamp. Do not expose update/delete for audit rows.

Run: `corepack pnpm --filter @repo/iam-service test`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add services/iam-service
git commit -m "feat(iam): add RBAC data scopes and audit log"
```

### Task 6: Add service entrypoints, health, metrics and runbook

**Files:**
- Create: `services/identity-service/src/main.ts`
- Create: `services/iam-service/src/main.ts`
- Create: `services/identity-service/Dockerfile`
- Create: `services/iam-service/Dockerfile`
- Create: `docs/runbooks/identity-iam.md`
- Test: `services/identity-service/test/health.e2e.test.ts`

- [ ] **Step 1: Write a failing health test**

```ts
it('reports not ready when PostgreSQL is unavailable', async () => {
  const response = await app.inject({ method: 'GET', url: '/readyz' });
  expect(response.statusCode).toBe(503);
});
```

- [ ] **Step 2: Implement `/healthz`, `/readyz`, `/metrics` and main entrypoints**

Readiness checks PostgreSQL, Redis and signing-key availability. Liveness only checks the event loop. Metrics include login success/failure, SMS rate-limit rejections, active sessions, MFA failures and authorization denials; phone numbers and user IDs are not metric labels.

- [ ] **Step 3: Add non-root Dockerfiles and runbook**

Dockerfiles use `node:24-alpine`, multi-stage build and `USER node`. The runbook documents local startup, required environment variables, key rotation, SMS outage, JWT rotation, administrator lockout, audit export and rollback.

- [ ] **Step 4: Verify and commit**

Run: `corepack pnpm --filter @repo/identity-service verify && corepack pnpm --filter @repo/iam-service verify`

Expected: both services pass tests, typecheck and build.

```powershell
git add services/identity-service services/iam-service docs/runbooks/identity-iam.md
git commit -m "chore(identity): add production entrypoints and runbook"
```

## WS10 completion gate

Run: `corepack pnpm --filter @repo/identity-service test:coverage && corepack pnpm --filter @repo/iam-service test:coverage && git status --short`

Expected: tests pass, domain coverage meets plan thresholds, Git status is empty, and `pnpm-lock.yaml` is not part of the branch diff.
