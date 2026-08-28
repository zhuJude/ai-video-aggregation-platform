# WS14 Assets, Operations and Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 OSS 素材/作品、直传和结果转存、生命周期、充值套餐/CMS/帮助/工单，以及站内信和短信发送。

**Architecture:** 三个服务分别拥有资产、运营内容和通知记录。大文件直连对象存储，业务服务只处理短时凭证和元数据；通知由领域事件触发并具备独立重试，不阻塞生成与支付主流程。

**Tech Stack:** NestJS、Prisma/PostgreSQL、S3-compatible local port/Alibaba OSS production port、Redis、RocketMQ、Vitest、MSW。

---

## 文件所有权

只修改 `services/asset-service/**`、`services/operations-service/**`、`services/notification-service/**`、`docs/runbooks/supporting-services.md`。

### Task 1: Implement secure upload sessions

**Files:**
- Create: `services/asset-service/prisma/schema.prisma`
- Create: `services/asset-service/src/application/upload-session.service.ts`
- Create: `services/asset-service/src/ports/object-store.ts`
- Create: `services/asset-service/src/adapters/aliyun-oss.object-store.ts`
- Test: `services/asset-service/test/upload-session.test.ts`

- [ ] **Step 1: Write failing ownership and file-policy tests**

```ts
it('rejects an executable disguised as an image', async () => {
  await expect(service.complete(sessionId, { mimeType: 'image/png', magic: '4d5a', sizeBytes: 200n })).rejects.toMatchObject({ code: 'INVALID_FILE_SIGNATURE' });
});
it('uses a random owner-scoped key', async () => {
  const session = await service.create({ ownerId, kind: 'UPLOAD', fileName: '../../secret.png', mimeType: 'image/png', sizeBytes: 200n });
  expect(session.objectKey).toMatch(new RegExp(`^uploads/${ownerId}/[a-f0-9-]+$`));
});
```

- [ ] **Step 2: Define object-store port and persistence**

```ts
export interface ObjectStore {
  createUpload(input: { objectKey: string; contentType: string; maxBytes: bigint; expiresInSeconds: number }): Promise<{ url: string; headers: Record<string, string> }>;
  head(objectKey: string): Promise<{ contentType: string; sizeBytes: bigint; checksum?: string }>;
  createDownload(objectKey: string, expiresInSeconds: number): Promise<string>;
  delete(objectKey: string): Promise<void>;
  copyFromUrl(input: { sourceUrl: string; destinationKey: string; maxBytes: bigint; allowedHosts: string[] }): Promise<{ sizeBytes: bigint; contentType: string; checksum?: string }>;
}
```

Create models `Asset`, `UploadSession`, `AssetDeletion`, `OutboxEvent`. Upload sessions expire in 15 minutes and are one-use. Store original filename only as display metadata; object key is server-generated UUID.

- [ ] **Step 3: Implement create/complete flows**

Allow configured image/video MIME and size policies. Completion calls `head`, validates size, MIME and signature metadata, then changes `PENDING` to `AVAILABLE` exactly once. Return only temporary signed URLs.

Implement `AliyunOssObjectStore` with `ali-oss@6.23.0`, RAM role credentials, private Bucket, STS-limited multipart upload policy and CDN-authenticated download URL. The upload policy restricts exact object prefix, content length range, content type and 15-minute expiration. Reject configuration that enables public-read ACL in any non-local environment.

- [ ] **Step 4: Verify and commit**

Run: `corepack pnpm --filter @repo/asset-service test -- upload-session.test.ts`

Expected: PASS.

```powershell
git add services/asset-service
git commit -m "feat(asset): add secure direct upload sessions"
```

### Task 2: Import provider results and manage lifecycle

**Files:**
- Create: `services/asset-service/src/application/result-import.service.ts`
- Create: `services/asset-service/src/application/lifecycle.job.ts`
- Test: `services/asset-service/test/result-import.test.ts`

- [ ] **Step 1: Write failing SSRF and durability tests**

```ts
it('rejects a result URL outside provider allowlists', async () => {
  await expect(service.import({ sourceUrl: 'http://169.254.169.254/latest/meta-data', allowedHosts: ['cdn.provider.cn'] })).rejects.toMatchObject({ code: 'RESULT_URL_NOT_ALLOWED' });
});
it('publishes imported only after the destination is verified', async () => {
  await service.import(validInput);
  expect(store.head).toHaveBeenCalledBefore(events.publish as never);
});
```

- [ ] **Step 2: Implement streaming import**

Resolve DNS and reject private/link-local/loopback addresses, enforce HTTPS and exact allowlisted host, cap redirects at two, stream with byte limit, validate type/checksum, write a result asset, verify destination with `head`, then publish `asset.imported.v1`. Never load the full video in memory or local disk.

- [ ] **Step 3: Implement deletion/lifecycle**

User deletion marks `DELETED` and schedules physical delete after seven days. Temporary uploads expire after 24 hours; failed task temporary files after seven days. Physical delete is idempotent and records completion. Available assets are never deleted solely because an event is replayed.

- [ ] **Step 4: Verify and commit**

Run: `corepack pnpm --filter @repo/asset-service test`

Expected: PASS.

```powershell
git add services/asset-service
git commit -m "feat(asset): import results and enforce lifecycle"
```

### Task 3: Implement recharge packages and CMS publication

**Files:**
- Create: `services/operations-service/prisma/schema.prisma`
- Create: `services/operations-service/src/application/publication.service.ts`
- Test: `services/operations-service/test/publication.test.ts`

- [ ] **Step 1: Write failing publication tests**

```ts
it('keeps a purchased package snapshot stable after later package edits', async () => {
  const version = await service.publishPackage({ name: '100元套餐', amountMinor: 10_000n, points: 100_000n, bonusPoints: 5_000n });
  await service.createDraftFrom(version.id, { bonusPoints: 10_000n });
  expect((await service.getPublished(version.id)).bonusPoints).toBe(5_000n);
});
```

- [ ] **Step 2: Create immutable publication models**

Create `RechargePackageVersion`, `ContentEntry`, `ContentVersion`, `BannerPlacement`, `HelpCategory`, `Ticket`, `TicketMessage`, `Feedback`, `FeatureFlagVersion`, `PublicSystemSettingVersion`, `OutboxEvent`. Published content/package/setting versions are immutable; edits create drafts and publication uses optimistic version checks. Secrets are never stored here; system settings only hold KMS secret reference IDs and non-secret public configuration.

- [ ] **Step 3: Add admin/public APIs and commit**

Admin APIs cover draft/preview/publish/retire/reorder. Public APIs return active packages, banners, announcements and help content. Sanitize rich text with an allowlist and reject scripts, event handlers and external iframes.

Run: `corepack pnpm --filter @repo/operations-service test`

Expected: PASS.

```powershell
git add services/operations-service
git commit -m "feat(operations): add versioned packages and CMS"
```

### Task 4: Implement ticket workflow

**Files:**
- Create: `services/operations-service/src/application/ticket.service.ts`
- Test: `services/operations-service/test/ticket.test.ts`

- [ ] **Step 1: Write failing authorization/state tests**

```ts
it('does not allow one user to read another user ticket', async () => {
  await expect(service.get(ticketId, otherUserId)).rejects.toMatchObject({ code: 'TICKET_NOT_FOUND' });
});
it('requires an agent reply before resolving an open ticket', async () => {
  await expect(service.resolve(ticketId, adminId)).rejects.toMatchObject({ code: 'TICKET_REPLY_REQUIRED' });
});
```

- [ ] **Step 2: Implement workflow**

State flow is `OPEN -> IN_PROGRESS -> RESOLVED -> CLOSED`, with reopen from RESOLVED to IN_PROGRESS within seven days. User messages are public; admin notes are a separate table and never returned to users. Attachments must be assets owned by the ticket user or uploaded under an authorized support session.

- [ ] **Step 3: Verify and commit**

Run: `corepack pnpm --filter @repo/operations-service test -- ticket.test.ts`

Expected: PASS.

```powershell
git add services/operations-service
git commit -m "feat(operations): add secure support tickets"
```

### Task 5: Implement in-app and SMS notifications

**Files:**
- Create: `services/notification-service/prisma/schema.prisma`
- Create: `services/notification-service/src/application/notification.consumer.ts`
- Create: `services/notification-service/src/ports/sms-sender.ts`
- Create: `services/notification-service/src/adapters/aliyun-sms.sender.ts`
- Test: `services/notification-service/test/notification.test.ts`

- [ ] **Step 1: Write failing deduplication and redaction tests**

```ts
it('sends one notification for a replayed event', async () => {
  await consumer.handle(event); await consumer.handle(event);
  expect(sender.send).toHaveBeenCalledTimes(1);
});
it('rejects template variables not declared by the template', async () => {
  await expect(service.render('task-success', { taskId: '1', secret: 'leak' })).rejects.toMatchObject({ code: 'UNKNOWN_TEMPLATE_VARIABLE' });
});
```

- [ ] **Step 2: Implement delivery**

Create `NotificationTemplateVersion`, `Notification`, `DeliveryAttempt`, `InboxMessage`. Consume task/payment/ticket/low-balance events. Render only declared variables, store in-app payload, and send SMS through a port. Production `AliyunSmsSender` uses `@alicloud/dysmsapi20170525@4.6.0`, RAM role credentials and approved sign/template codes; it records Alibaba request ID and receipt status without storing the full phone in logs. Retry transient SMS failures with capped backoff; permanent template/phone failures go to operator queue. User can mark read and paginate by cursor.

- [ ] **Step 3: Verify and commit**

Run: `corepack pnpm --filter @repo/notification-service test`

Expected: PASS.

```powershell
git add services/notification-service
git commit -m "feat(notification): add idempotent in-app and SMS delivery"
```

### Task 6: Add production runtimes and runbook

**Files:**
- Create: `services/asset-service/Dockerfile`
- Create: `services/operations-service/Dockerfile`
- Create: `services/notification-service/Dockerfile`
- Create: `docs/runbooks/supporting-services.md`

- [ ] **Step 1: Add health and metrics**

Readiness checks database and required object-store/SMS configuration. Metrics cover upload completion failures, import bytes/errors, pending deletions, CMS publication, ticket backlog and SMS retries without object keys, phone numbers or user IDs as labels.

- [ ] **Step 2: Add images and runbook**

Use non-root images. Document OSS/KMS credential rotation, stuck import, orphan scan, accidental delete restore, CMS rollback, ticket privacy incident, SMS outage and notification replay.

- [ ] **Step 3: Verify and commit**

Run: `corepack pnpm --filter @repo/asset-service test && corepack pnpm --filter @repo/operations-service test && corepack pnpm --filter @repo/notification-service test`

Expected: PASS.

```powershell
git add services/asset-service services/operations-service services/notification-service docs/runbooks/supporting-services.md
git commit -m "chore(support): add production runtimes and runbook"
```

## WS14 completion gate

Run: `corepack pnpm --filter @repo/asset-service build && corepack pnpm --filter @repo/operations-service build && corepack pnpm --filter @repo/notification-service build && git status --short`

Expected: builds pass, branch is clean, lockfile/shared contracts unchanged.
