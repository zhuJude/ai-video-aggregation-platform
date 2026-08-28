# WS12 Wallet and Payment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现不可变复式点数账本、并发安全的冻结/结算/释放、充值套餐、微信支付适配、回调幂等、渠道对账、退款、发票流程和双人复核。

**Architecture:** `wallet-service` 是唯一可改变点数余额的服务，以平衡分录为事实来源；`payment-service` 拥有现金订单并在支付确认后使用唯一业务键请求钱包入账。跨服务通过命令和 Outbox 事件协作，不共享表。

**Tech Stack:** NestJS、Prisma/PostgreSQL、BIGINT、Serializable transactions、RocketMQ Outbox/Inbox、WeChat Pay v3 port、Vitest、fast-check、Testcontainers。

---

## 文件所有权

只修改 `services/wallet-service/**`、`services/payment-service/**`、`docs/runbooks/wallet-payment.md`。

### Task 1: Create the balanced ledger

**Files:**
- Create: `services/wallet-service/prisma/schema.prisma`
- Create: `services/wallet-service/src/domain/ledger.ts`
- Test: `services/wallet-service/test/ledger.property.test.ts`

- [ ] **Step 1: Write failing balance properties**

```ts
import fc from 'fast-check';
it('requires each transaction to balance', () => {
  fc.assert(fc.property(fc.bigInt({ min: 1n, max: 1_000_000n }), (points) => {
    const tx = reserveEntries('user-1', points);
    expect(tx.reduce((sum, entry) => sum + entry.delta, 0n)).toBe(0n);
  }));
});
it('rejects zero and negative commands', () => expect(() => reserveEntries('user-1', 0n)).toThrow('INVALID_POINTS'));
```

- [ ] **Step 2: Run and verify failure**

Run: `corepack pnpm --filter @repo/wallet-service test -- ledger.property.test.ts`

Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement account movements**

```ts
export type AccountKind = 'USER_AVAILABLE' | 'USER_FROZEN' | 'PLATFORM_LIABILITY' | 'PLATFORM_CONSUMED' | 'ADJUSTMENT';
export interface EntryDraft { account: AccountKind; ownerId: string; delta: bigint }
function positive(points: bigint): void { if (points <= 0n) throw Object.assign(new Error('INVALID_POINTS'), { code: 'INVALID_POINTS' }); }
export function reserveEntries(userId: string, points: bigint): EntryDraft[] {
  positive(points);
  return [
    { account: 'USER_AVAILABLE', ownerId: userId, delta: -points },
    { account: 'USER_FROZEN', ownerId: userId, delta: points },
  ];
}
export function settleEntries(userId: string, points: bigint): EntryDraft[] {
  positive(points);
  return [
    { account: 'USER_FROZEN', ownerId: userId, delta: -points },
    { account: 'PLATFORM_CONSUMED', ownerId: 'platform', delta: points },
  ];
}
export function releaseEntries(userId: string, points: bigint): EntryDraft[] {
  positive(points);
  return [
    { account: 'USER_FROZEN', ownerId: userId, delta: -points },
    { account: 'USER_AVAILABLE', ownerId: userId, delta: points },
  ];
}
```

Create Prisma models `WalletAccount`, `LedgerTransaction`, `LedgerEntry`, `BalanceSnapshot`, `OutboxEvent`, `InboxMessage`, and `ReconciliationRun`. `LedgerTransaction.businessKey` is unique. `LedgerEntry.delta` and balances use `BigInt`.

- [ ] **Step 4: Run and commit**

Run: `corepack pnpm --filter @repo/wallet-service test -- ledger.property.test.ts`

Expected: PASS.

```powershell
git add services/wallet-service
git commit -m "feat(wallet): add balanced immutable ledger"
```

### Task 2: Implement concurrent reserve, settle and release

**Files:**
- Create: `services/wallet-service/src/application/wallet.service.ts`
- Test: `services/wallet-service/test/wallet.integration.test.ts`

- [ ] **Step 1: Write failing concurrency tests**

```ts
it('allows only one of two concurrent reservations that exceed the balance together', async () => {
  await seedBalance(userId, 100n);
  const results = await Promise.allSettled([
    service.reserve({ businessKey: 'task:a:reserve', userId, points: 80n }),
    service.reserve({ businessKey: 'task:b:reserve', userId, points: 80n }),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(await balance(userId)).toEqual({ available: 20n, frozen: 80n });
});
it('returns the original result for a repeated business key', async () => {
  const first = await service.reserve(command);
  const second = await service.reserve(command);
  expect(second.transactionId).toBe(first.transactionId);
});
```

- [ ] **Step 2: Implement serializable ledger posting**

Use a Prisma interactive transaction with PostgreSQL `Serializable` isolation. Lock the two user account rows in stable account-kind order, check available/frozen constraints, insert the unique ledger transaction and entries, update balance snapshots, assert total delta is zero, and insert Outbox event in one commit. Retry serialization failures at most three times with jitter. A unique-key conflict loads and returns the existing transaction.

- [ ] **Step 3: Add command endpoints**

Implement authenticated internal endpoints `POST /internal/wallet/credit`, `/reserve`, `/settle`, `/release`, `/adjustments/:id/approve` and user endpoints `GET /v1/wallet`, `GET /v1/wallet/transactions`. All point values cross HTTP as decimal strings.

- [ ] **Step 4: Verify and commit**

Run: `corepack pnpm --filter @repo/wallet-service test && corepack pnpm --filter @repo/wallet-service typecheck`

Expected: concurrency and idempotency tests pass.

```powershell
git add services/wallet-service
git commit -m "feat(wallet): add concurrent idempotent wallet commands"
```

### Task 3: Add reconciliation and dual approval

**Files:**
- Create: `services/wallet-service/src/application/reconciliation.job.ts`
- Create: `services/wallet-service/src/application/adjustment.service.ts`
- Test: `services/wallet-service/test/reconciliation.test.ts`

- [ ] **Step 1: Write failing mismatch and approval tests**

```ts
it('detects a balance snapshot that differs from entries', async () => {
  await corruptSnapshot(userId, { available: 999n });
  const report = await job.run();
  expect(report.mismatches).toContainEqual(expect.objectContaining({ userId, account: 'USER_AVAILABLE' }));
});
it('prevents the requester from approving their own adjustment', async () => {
  const request = await adjustments.request({ userId, points: 100n, requestedBy: 'admin-a', reason: 'service compensation' });
  await expect(adjustments.approve(request.id, 'admin-a')).rejects.toMatchObject({ code: 'DUAL_APPROVAL_REQUIRED' });
});
```

- [ ] **Step 2: Implement reconciliation and repair workflow**

Recalculate each account from immutable entries and compare to snapshots. Do not auto-edit an unexplained mismatch: publish P0 `wallet.ledger-mismatch.v1`, block affected wallet commands, and create a reconciliation record. Implement an audited repair command that writes a compensating transaction after two distinct authorized admins approve.

- [ ] **Step 3: Verify and commit**

Run: `corepack pnpm --filter @repo/wallet-service test -- reconciliation.test.ts`

Expected: PASS.

```powershell
git add services/wallet-service
git commit -m "feat(wallet): add reconciliation and dual approval"
```

### Task 4: Create payment orders and a gateway port

**Files:**
- Create: `services/payment-service/prisma/schema.prisma`
- Create: `services/payment-service/src/ports/payment-gateway.ts`
- Create: `services/payment-service/src/application/order.service.ts`
- Create: `services/payment-service/src/adapters/wechat-pay-v3.gateway.ts`
- Test: `services/payment-service/test/order.test.ts`
- Test: `services/payment-service/test/wechat-pay-v3.gateway.test.ts`

- [ ] **Step 1: Write failing amount-integrity tests**

```ts
it('uses the server-side package amount and ignores client supplied points', async () => {
  const order = await service.create({ userId, packageId: 'pkg-100' });
  expect(order).toMatchObject({ amountMinor: 1000n, points: 10_000n, currency: 'CNY' });
});
```

- [ ] **Step 2: Implement gateway port and order creation**

```ts
export interface PaymentGateway {
  createNativeOrder(input: { orderNo: string; amountMinor: bigint; description: string; notifyUrl: string }): Promise<{ prepayId: string; expiresAt: Date }>;
  verifyCallback(headers: Record<string, string>, body: string): Promise<{ transactionId: string; orderNo: string; amountMinor: bigint; paidAt: Date }>;
  closeOrder(orderNo: string): Promise<void>;
  refund(input: { orderNo: string; refundNo: string; amountMinor: bigint; reason: string }): Promise<{ refundId: string }>;
  downloadBill(date: string): Promise<NodeJS.ReadableStream>;
}
```

Create models `RechargePackageSnapshot`, `PaymentOrder`, `PaymentCallback`, `RefundOrder`, `InvoiceApplication`, `ChannelReconciliation`, `OutboxEvent`, and `InboxMessage`. Order amount and point package are copied into immutable snapshots before calling the gateway.

- [ ] **Step 3: Add local fake gateway**

The fake gateway only starts when `PAYMENT_GATEWAY=fake` and `APP_ENV!=production`; it signs callbacks with a local test key and exposes no production route.

- [ ] **Step 4: Implement WeChat Pay API v3 request signing and callback decryption**

```ts
// services/payment-service/src/adapters/wechat-pay-v3.gateway.ts
import { createDecipheriv, createSign, createVerify, randomBytes } from 'node:crypto';

export function signWechatRequest(input: { method: string; canonicalUrl: string; timestamp: string; nonce: string; body: string; privateKeyPem: string }): string {
  const message = `${input.method}\n${input.canonicalUrl}\n${input.timestamp}\n${input.nonce}\n${input.body}\n`;
  return createSign('RSA-SHA256').update(message).end().sign(input.privateKeyPem, 'base64');
}

export function verifyWechatCallback(input: { timestamp: string; nonce: string; rawBody: string; signature: string; publicKeyPem: string }): boolean {
  const message = `${input.timestamp}\n${input.nonce}\n${input.rawBody}\n`;
  return createVerify('RSA-SHA256').update(message).end().verify(input.publicKeyPem, input.signature, 'base64');
}

export function decryptWechatResource(input: { apiV3Key: string; nonce: string; associatedData: string; ciphertext: string }): string {
  const encrypted = Buffer.from(input.ciphertext, 'base64');
  const authTag = encrypted.subarray(encrypted.length - 16);
  const data = encrypted.subarray(0, encrypted.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(input.apiV3Key), Buffer.from(input.nonce));
  decipher.setAuthTag(authTag);
  decipher.setAAD(Buffer.from(input.associatedData));
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

export function createNonce(): string { return randomBytes(16).toString('hex'); }
```

`WechatPayV3Gateway` uses `POST /v3/pay/transactions/native`, query by merchant order number, close, refund and bill download endpoints. Build the `Authorization` header with merchant ID, certificate serial, nonce, timestamp and signature. Select the callback verification key strictly by `Wechatpay-Serial`; reject unknown serials, timestamp skew over five minutes, invalid probe signatures and invalid AES-GCM tags. Validate the raw body before JSON reserialization. Load merchant private key, APIv3 key and WeChat public keys from KMS only.

- [ ] **Step 5: Test cryptography, run and commit**

Generate RSA fixtures in the test, assert a mutated body fails signature verification, assert AES-GCM tampering throws, and assert the production adapter refuses missing merchant/KMS configuration.

Run: `corepack pnpm --filter @repo/payment-service test -- order.test.ts wechat-pay-v3.gateway.test.ts`

Expected: PASS.

```powershell
git add services/payment-service
git commit -m "feat(payment): add immutable recharge orders"
```

### Task 5: Implement callback idempotency and wallet credit Saga

**Files:**
- Create: `services/payment-service/src/application/payment-callback.service.ts`
- Test: `services/payment-service/test/callback.integration.test.ts`

- [ ] **Step 1: Write failing duplicate callback test**

```ts
it('credits the wallet once for repeated valid callbacks', async () => {
  await Promise.all([service.handle(headers, body), service.handle(headers, body)]);
  expect(wallet.credit).toHaveBeenCalledTimes(1);
  expect(await orderStatus(orderNo)).toBe('PAID');
});
```

- [ ] **Step 2: Implement callback processing**

Verify signature before parsing business data. Compare merchant/order, `CNY`, exact amount and current order state. Store callback transaction ID under a unique constraint. Change `PENDING` to `PAID` and write `payment.paid.v1` Outbox in one transaction. A consumer calls wallet credit with business key `payment:<orderId>:credit`; repeated events return the original ledger transaction.

- [ ] **Step 3: Add active query recovery and commit**

For pending orders older than two minutes, query the payment gateway and feed confirmed results through the same callback state transition. Never directly mutate to PAID outside that path.

Run: `corepack pnpm --filter @repo/payment-service test`

Expected: PASS.

```powershell
git add services/payment-service
git commit -m "feat(payment): add idempotent payment settlement"
```

### Task 6: Implement refunds, channel reconciliation and invoices

**Files:**
- Create: `services/payment-service/src/application/refund.service.ts`
- Create: `services/payment-service/src/application/channel-reconciliation.job.ts`
- Create: `services/payment-service/src/application/invoice.service.ts`
- Test: `services/payment-service/test/channel-reconciliation.test.ts`

- [ ] **Step 1: Write failing reconciliation test**

```ts
it('reports a channel payment missing from the platform ledger', async () => {
  gateway.billRows = [{ orderNo: 'unexpected', transactionId: 'wx-1', amountMinor: 1000n }];
  const result = await job.run('2026-08-28');
  expect(result.differences).toContainEqual(expect.objectContaining({ kind: 'CHANNEL_ONLY', orderNo: 'unexpected' }));
});
```

- [ ] **Step 2: Implement the workflows**

Refunds require an authorized reason, unique refund number, gateway confirmation and a compensating wallet command; failed refunds remain retryable without duplicate wallet effects. Reconciliation parses the downloaded bill, compares order number/transaction ID/amount/status, stores differences and emits P0/P1 events according to monetary impact. Invoice applications validate paid order ownership and prevent an order amount from being invoiced twice; status flow is `APPLIED -> APPROVED -> ISSUED | REJECTED`.

- [ ] **Step 3: Verify and commit**

Run: `corepack pnpm --filter @repo/payment-service test && corepack pnpm --filter @repo/payment-service typecheck`

Expected: PASS.

```powershell
git add services/payment-service
git commit -m "feat(payment): add refunds reconciliation and invoices"
```

### Task 7: Add production entrypoints and runbook

**Files:**
- Create: `services/wallet-service/src/main.ts`
- Create: `services/payment-service/src/main.ts`
- Create: `services/wallet-service/Dockerfile`
- Create: `services/payment-service/Dockerfile`
- Create: `docs/runbooks/wallet-payment.md`

- [ ] **Step 1: Add liveness, readiness and metrics tests**

Test that readiness fails when PostgreSQL or the payment certificate is unavailable. Metrics include ledger postings, serializable retries, blocked wallets, payment callback failures, reconciliation differences and refund backlog; never label by user/order ID.

- [ ] **Step 2: Add non-root images and runbook**

Document payment certificate rotation, callback outage, blocked-wallet P0, channel reconciliation, manual repair, refund retry, restore and rollback. Add explicit command examples for read-only ledger verification.

- [ ] **Step 3: Verify and commit**

Run: `corepack pnpm --filter @repo/wallet-service test:coverage && corepack pnpm --filter @repo/payment-service test:coverage`

Expected: at least 95% domain-rule coverage and all tests pass.

```powershell
git add services/wallet-service services/payment-service docs/runbooks/wallet-payment.md
git commit -m "chore(finance): add production runtime and runbook"
```

## WS12 completion gate

Run: `corepack pnpm --filter @repo/wallet-service build && corepack pnpm --filter @repo/payment-service build && git status --short`

Expected: builds pass, Git is clean, lockfile/shared contracts unchanged.
