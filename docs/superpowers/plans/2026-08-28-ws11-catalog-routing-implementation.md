# WS11 Catalog, Pricing and Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现供应商/模型目录、动态能力版本、成本与销售定价、报价快照、智能路由、利润保护和配置发布回滚。

**Architecture:** `catalog-service` 拥有供应商、模型和能力版本；`quote-routing-service` 拥有成本、售价、路由规则和十分钟报价。配置发布后不可变，路由只读取已发布快照并保存完整决策解释。

**Tech Stack:** NestJS、Prisma/PostgreSQL、Zod/AJV、BigInt、Vitest、fast-check、RocketMQ 事件端口。

---

## 文件所有权

只修改 `services/catalog-service/**`、`services/quote-routing-service/**`、`docs/runbooks/catalog-routing.md`。

### Task 1: Persist versioned providers, models and capabilities

**Files:**
- Create: `services/catalog-service/prisma/schema.prisma`
- Create: `services/catalog-service/src/domain/capability-publication.ts`
- Test: `services/catalog-service/test/capability-publication.test.ts`

- [ ] **Step 1: Write failing immutability tests**

```ts
it('publishes a new immutable version instead of editing the active version', () => {
  const draft = createDraft({ version: 1, jsonSchema: { type: 'object' } });
  const published = publish(draft, 'admin-1');
  expect(published.status).toBe('PUBLISHED');
  expect(() => editPublished(published, {})).toThrow('CAPABILITY_VERSION_IMMUTABLE');
});
```

- [ ] **Step 2: Run and verify failure**

Run: `corepack pnpm --filter @repo/catalog-service test -- capability-publication.test.ts`

Expected: FAIL because the service does not exist.

- [ ] **Step 3: Create schema and domain rules**

Create Prisma models `Provider`, `ProviderCredentialRef`, `Model`, `CapabilityVersion`, `CapabilityPublication`, and `OutboxEvent`. Unique keys are `(providerId, code)` for models and `(modelId, version)` for capabilities. Published rows have `publishedAt`, `publishedBy`, content SHA-256 and cannot be updated by repository methods.

```ts
export function assertEditable(status: 'DRAFT' | 'PUBLISHED' | 'RETIRED'): void {
  if (status !== 'DRAFT') throw Object.assign(new Error('CAPABILITY_VERSION_IMMUTABLE'), { code: 'CAPABILITY_VERSION_IMMUTABLE' });
}
```

- [ ] **Step 4: Validate with Canonical Capability Schema**

Before publication, parse the document with `CapabilityDocumentSchema`, compile `jsonSchema` with AJV, verify every UI field and `costDimensions` entry exists in JSON Schema properties, then write publication and `catalog.capability-published.v1` Outbox event in one transaction.

Run: `corepack pnpm --filter @repo/catalog-service test`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add services/catalog-service
git commit -m "feat(catalog): add immutable capability versions"
```

### Task 2: Implement catalog administration and public queries

**Files:**
- Create: `services/catalog-service/src/http/admin-catalog.controller.ts`
- Create: `services/catalog-service/src/http/public-models.controller.ts`
- Test: `services/catalog-service/test/catalog-api.e2e.test.ts`

- [ ] **Step 1: Write failing visibility tests**

```ts
it('never exposes disabled models to the public endpoint', async () => {
  await seedModel({ code: 'hidden', status: 'DISABLED' });
  const response = await app.inject({ method: 'GET', url: '/v1/models' });
  expect(response.json().items).not.toEqual(expect.arrayContaining([expect.objectContaining({ code: 'hidden' })]));
});
```

- [ ] **Step 2: Implement endpoints**

Admin endpoints manage providers, models, draft capabilities, publication, retirement, ordering and maintenance windows. Public endpoints return only ACTIVE models and published capability versions, with provider credential references and raw provider model IDs removed.

- [ ] **Step 3: Verify and commit**

Run: `corepack pnpm --filter @repo/catalog-service test && corepack pnpm --filter @repo/catalog-service typecheck`

Expected: PASS.

```powershell
git add services/catalog-service
git commit -m "feat(catalog): add admin and public catalog APIs"
```

### Task 3: Implement integer pricing formulas

**Files:**
- Create: `services/quote-routing-service/src/domain/pricing.ts`
- Create: `services/quote-routing-service/prisma/schema.prisma`
- Test: `services/quote-routing-service/test/pricing.property.test.ts`

- [ ] **Step 1: Write failing property tests**

```ts
import fc from 'fast-check';
it('never produces a negative or floating point price', () => {
  fc.assert(fc.property(fc.bigInt({ min: 0n, max: 1_000_000n }), fc.integer({ min: 0, max: 5000 }), (base, marginBps) => {
    const price = priceWithMargin(base, marginBps);
    expect(price >= 0n).toBe(true);
    expect(typeof price).toBe('bigint');
  }));
});
```

- [ ] **Step 2: Implement ceiling pricing**

```ts
export function priceWithMargin(costPoints: bigint, marginBasisPoints: number): bigint {
  if (costPoints < 0n || marginBasisPoints < 0) throw new Error('INVALID_PRICING_INPUT');
  const numerator = costPoints * BigInt(10_000 + marginBasisPoints);
  return (numerator + 9_999n) / 10_000n;
}
```

Create models `CostRuleVersion`, `SalePriceRuleVersion`, `RoutePolicyVersion`, `Quote`, `RouteDecision`, and `OutboxEvent`. Store points as `BigInt`, parameters hash as fixed 64-char string, and versions as immutable positive integers.

- [ ] **Step 3: Run and commit**

Run: `corepack pnpm --filter @repo/quote-routing-service test -- pricing.property.test.ts`

Expected: PASS.

```powershell
git add services/quote-routing-service
git commit -m "feat(routing): add integer pricing rules"
```

### Task 4: Implement deterministic smart routing

**Files:**
- Create: `services/quote-routing-service/src/domain/route-selector.ts`
- Test: `services/quote-routing-service/test/route-selector.test.ts`

- [ ] **Step 1: Write failing eligibility and tie-break tests**

```ts
it('filters unhealthy and below-margin candidates before scoring', () => {
  const result = selectRoute(candidates, { quality: 40, speed: 30, price: 30, minimumMarginBps: 2000 });
  expect(result.selected.modelId).toBe('healthy-profitable');
  expect(result.excluded).toEqual(expect.arrayContaining([expect.objectContaining({ modelId: 'down', reason: 'UNHEALTHY' })]));
});
it('uses model id as stable final tie breaker', () => {
  expect(selectRoute(equalCandidates, weights).selected.modelId).toBe('model-a');
});
```

- [ ] **Step 2: Implement route selection**

Normalize quality, speed and price scores to integers 0–10000. Exclude capability mismatch, non-ACTIVE, maintenance, circuit-open, quota-exhausted, provider-balance-low and margin-below-minimum candidates. Calculate weighted integer score and sort by score descending, configured priority ascending, then model ID ascending. Return selected candidate plus every exclusion and score component.

- [ ] **Step 3: Run and commit**

Run: `corepack pnpm --filter @repo/quote-routing-service test -- route-selector.test.ts`

Expected: PASS.

```powershell
git add services/quote-routing-service
git commit -m "feat(routing): add explainable smart routing"
```

### Task 5: Implement quotes and professional-mode rules

**Files:**
- Create: `services/quote-routing-service/src/application/quote.service.ts`
- Create: `services/quote-routing-service/src/http/quotes.controller.ts`
- Test: `services/quote-routing-service/test/quote.test.ts`

- [ ] **Step 1: Write failing expiry and hash tests**

```ts
it('rejects a changed parameter set and an expired quote', async () => {
  const quote = await service.create(input, now);
  await expect(service.assertUsable(quote.id, { ...input.parameters, duration: 10 }, now)).rejects.toMatchObject({ code: 'QUOTE_PARAMETERS_CHANGED' });
  await expect(service.assertUsable(quote.id, input.parameters, new Date(now.getTime() + 600_001))).rejects.toMatchObject({ code: 'QUOTE_EXPIRED' });
});
```

- [ ] **Step 2: Implement canonical JSON hashing and ten-minute expiry**

Sort object keys recursively, preserve array order, serialize UTF-8 and SHA-256. The Quote stores user ID, selected/candidate IDs, capability version, quoted points, cost estimate, price/routing versions, parameter hash and `expiresAt=createdAt+10m`. Professional mode selects the requested model exactly; failover is false unless explicitly supplied in the quote request.

- [ ] **Step 3: Add APIs and verify**

Implement `POST /v1/quotes`, `GET /v1/quotes/:id`, admin price/routing version APIs, publish/rollback and route simulation endpoints. Simulation never writes a Quote.

Run: `corepack pnpm --filter @repo/quote-routing-service test && corepack pnpm --filter @repo/quote-routing-service typecheck`

Expected: PASS.

- [ ] **Step 4: Commit**

```powershell
git add services/quote-routing-service
git commit -m "feat(routing): add immutable task quotes"
```

### Task 6: Add health snapshots, margin protection and runbook

**Files:**
- Create: `services/quote-routing-service/src/application/provider-health.consumer.ts`
- Create: `services/quote-routing-service/src/application/margin-guard.job.ts`
- Create: `docs/runbooks/catalog-routing.md`
- Create: `services/catalog-service/Dockerfile`
- Create: `services/quote-routing-service/Dockerfile`

- [ ] **Step 1: Write a failing loss-protection test**

```ts
it('disables a model when published provider cost makes every sale rule unprofitable', async () => {
  await job.run();
  expect(catalog.disableModel).toHaveBeenCalledWith(modelId, 'MARGIN_BELOW_MINIMUM');
});
```

- [ ] **Step 2: Implement health and cost consumers**

Consume versioned provider health/balance events with Inbox deduplication. Store only the latest monotonic snapshot. Margin guard recalculates ACTIVE models when cost versions change, publishes `routing.margin-risk-detected.v1`, and requests catalog disablement through its authenticated internal API.

- [ ] **Step 3: Add production entrypoints and runbook**

Expose liveness/readiness/metrics. Add non-root multi-stage Dockerfiles. Runbook covers broken Schema publication, accidental model disablement, price rollback, provider balance alert, route simulation and route-decision audit.

- [ ] **Step 4: Verify and commit**

Run: `corepack pnpm --filter @repo/catalog-service test:coverage && corepack pnpm --filter @repo/quote-routing-service test:coverage`

Expected: PASS.

```powershell
git add services/catalog-service services/quote-routing-service docs/runbooks/catalog-routing.md
git commit -m "chore(routing): add health guards and runbook"
```

## WS11 completion gate

Run: `corepack pnpm --filter @repo/catalog-service build && corepack pnpm --filter @repo/quote-routing-service build && git status --short`

Expected: builds pass, Git is clean, shared contracts and lockfile are unchanged.
