# WS00 Foundation and Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立可供所有并行窗口使用的 monorepo、共享契约、动态能力规范、Provider SDK、服务启动包、测试底座和本地依赖。

**Architecture:** 根目录只保存构建和质量配置；共享包都有单一职责并可独立构建。领域契约使用 Zod 作为运行时校验和 TypeScript 类型来源，点数/金额不使用浮点数，事件统一使用带版本的信封。

**Tech Stack:** pnpm 11、Turbo 2、TypeScript 7、Vitest 4、NestJS 12、Zod 4、AJV 8、React 19、Docker Compose、PostgreSQL 17、Redis 8、RocketMQ 5、MinIO。

---

## 文件地图

```text
package.json                         根脚本和固定工具版本
pnpm-workspace.yaml                  workspace 和依赖 catalog
turbo.json                           build/test/lint/typecheck 图
tsconfig.base.json                   严格 TypeScript 基线
eslint.config.mjs                    lint 基线
.prettierrc.json                     格式基线
scripts/verify-workspace.test.ts     根结构冒烟测试
packages/contracts/                  所有冻结 API/事件契约
packages/capability-schema/          JSON Schema + UI Schema 校验
packages/provider-sdk/               供应商适配器接口和准入测试函数
packages/service-kit/                NestJS 启动、错误、Trace 和健康检查
packages/testkit/                    测试 ID、时钟、消息和 HTTP fixture
packages/ui/                         两个前端共用的无业务 UI 原语
infra/local/compose.yaml             本地 PostgreSQL/Redis/RocketMQ/MinIO/Mailpit
.github/workflows/ci.yml             基础 CI
```

### Task 1: Bootstrap the workspace

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `turbo.json`
- Create: `tsconfig.base.json`
- Create: `eslint.config.mjs`
- Create: `.prettierrc.json`
- Create: `scripts/verify-workspace.test.ts`

- [ ] **Step 1: Write the failing workspace test**

```ts
// scripts/verify-workspace.test.ts
import { access } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const required = [
  'pnpm-workspace.yaml',
  'turbo.json',
  'tsconfig.base.json',
  'packages/contracts/package.json',
  'packages/service-kit/package.json',
] as const;

describe('workspace', () => {
  it.each(required)('contains %s', async (path) => {
    await expect(access(path)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test and verify the missing files fail**

Run: `corepack pnpm dlx vitest@4.1.11 run scripts/verify-workspace.test.ts`

Expected: FAIL because `pnpm-workspace.yaml` and packages do not exist.

- [ ] **Step 3: Create the root configuration**

```json
// package.json
{
  "name": "ai-video-aggregation-platform",
  "private": true,
  "packageManager": "pnpm@11.24.0",
  "engines": { "node": ">=24 <25" },
  "scripts": {
    "build": "turbo run build",
    "dev": "turbo run dev --parallel",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "lint": "turbo run lint",
    "typecheck": "turbo run typecheck",
    "test": "turbo run test",
    "test:coverage": "turbo run test:coverage",
    "verify": "pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build"
  },
  "devDependencies": {
    "@eslint/js": "10.9.1",
    "@types/node": "24.10.1",
    "eslint": "10.9.1",
    "prettier": "3.9.6",
    "tsx": "4.23.12",
    "turbo": "2.10.12",
    "typescript": "7.0.2",
    "typescript-eslint": "8.56.0",
    "vitest": "4.1.11"
  }
}
```

```yaml
# pnpm-workspace.yaml
packages:
  - apps/*
  - services/*
  - packages/*
  - providers/*

onlyBuiltDependencies:
  - '@prisma/client'
  - '@prisma/engines'
  - argon2
  - esbuild
  - prisma
```

```json
// turbo.json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**", ".next/**"] },
    "dev": { "cache": false, "persistent": true },
    "lint": { "dependsOn": ["^build"], "outputs": [] },
    "typecheck": { "dependsOn": ["^build"], "outputs": [] },
    "test": { "dependsOn": ["^build"], "outputs": ["coverage/**"] },
    "test:coverage": { "dependsOn": ["^build"], "outputs": ["coverage/**"] }
  }
}
```

```json
// tsconfig.base.json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "useUnknownInCatchVariables": true,
    "noImplicitOverride": true,
    "verbatimModuleSyntax": true,
    "declaration": true,
    "sourceMap": true,
    "skipLibCheck": true
  }
}
```

```js
// eslint.config.mjs
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/.next/**', '**/coverage/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
);
```

```json
// .prettierrc.json
{ "singleQuote": true, "trailingComma": "all", "printWidth": 100 }
```

- [ ] **Step 4: Add temporary package manifests needed by the smoke test**

```json
// packages/contracts/package.json
{
  "name": "@repo/contracts",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "lint": "eslint src test",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "test:coverage": "vitest run --coverage"
  },
  "dependencies": { "zod": "4.4.3" }
}
```

```json
// packages/service-kit/package.json
{
  "name": "@repo/service-kit",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "lint": "eslint src test",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "test:coverage": "vitest run --coverage"
  }
}
```

- [ ] **Step 5: Install and rerun the smoke test**

Run: `corepack pnpm install && corepack pnpm dlx vitest@4.1.11 run scripts/verify-workspace.test.ts`

Expected: PASS with 5 tests.

- [ ] **Step 6: Commit**

```powershell
git add package.json pnpm-workspace.yaml turbo.json tsconfig.base.json eslint.config.mjs .prettierrc.json scripts packages/contracts/package.json packages/service-kit/package.json pnpm-lock.yaml
git commit -m "chore: bootstrap TypeScript workspace"
```

### Task 2: Define common API and event contracts

**Files:**
- Create: `packages/contracts/tsconfig.json`
- Create: `packages/contracts/src/common/error.ts`
- Create: `packages/contracts/src/common/headers.ts`
- Create: `packages/contracts/src/common/event-envelope.ts`
- Create: `packages/contracts/src/common/scalars.ts`
- Create: `packages/contracts/src/common/index.ts`
- Test: `packages/contracts/test/common.test.ts`

- [ ] **Step 1: Write failing scalar and envelope tests**

```ts
// packages/contracts/test/common.test.ts
import { describe, expect, it } from 'vitest';
import { EventEnvelopeSchema, PointsStringSchema, UuidSchema } from '../src/common/index.js';

describe('common contracts', () => {
  it('accepts integer points and rejects floating points', () => {
    expect(PointsStringSchema.parse('1200')).toBe('1200');
    expect(() => PointsStringSchema.parse('12.5')).toThrow();
  });

  it('requires event identity and trace metadata', () => {
    const event = EventEnvelopeSchema.parse({
      id: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a2',
      type: 'test.created.v1',
      version: 1,
      occurredAt: '2026-08-28T00:00:00.000Z',
      traceId: '3f6c12cc4fc74f7ca4a81e2f2c9d56ad',
      correlationId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a2',
      producer: 'test-service',
      data: { ok: true },
    });
    expect(UuidSchema.parse(event.id)).toBe(event.id);
  });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `corepack pnpm --filter @repo/contracts test`

Expected: FAIL because `src/common/index.ts` does not exist.

- [ ] **Step 3: Implement the common contracts**

```ts
// packages/contracts/src/common/scalars.ts
import { z } from 'zod';

export const UuidSchema = z.uuid();
export const UtcDateTimeSchema = z.iso.datetime({ offset: true });
export const PointsStringSchema = z.string().regex(/^(0|[1-9]\d*)$/);
export const MinorAmountSchema = z.string().regex(/^(0|[1-9]\d*)$/);
export const CurrencySchema = z.literal('CNY');

export type PointsString = z.infer<typeof PointsStringSchema>;
```

```ts
// packages/contracts/src/common/event-envelope.ts
import { z } from 'zod';
import { UtcDateTimeSchema, UuidSchema } from './scalars.js';

export const EventEnvelopeSchema = z.object({
  id: UuidSchema,
  type: z.string().regex(/^[a-z][a-z0-9.-]+\.v\d+$/),
  version: z.int().positive(),
  occurredAt: UtcDateTimeSchema,
  traceId: z.string().regex(/^[a-f0-9]{32}$/),
  correlationId: UuidSchema,
  causationId: UuidSchema.optional(),
  producer: z.string().min(1),
  data: z.unknown(),
});

export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;
```

```ts
// packages/contracts/src/common/error.ts
import { z } from 'zod';

export const ApiErrorSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]+$/),
  message: z.string().min(1),
  traceId: z.string().regex(/^[a-f0-9]{32}$/),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export type ApiError = z.infer<typeof ApiErrorSchema>;
```

```ts
// packages/contracts/src/common/headers.ts
export const HEADERS = {
  traceId: 'x-trace-id',
  correlationId: 'x-correlation-id',
  idempotencyKey: 'idempotency-key',
} as const;
```

```ts
// packages/contracts/src/common/index.ts
export * from './error.js';
export * from './event-envelope.js';
export * from './headers.js';
export * from './scalars.js';
```

```json
// packages/contracts/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "." },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 4: Run tests**

Run: `corepack pnpm --filter @repo/contracts test`

Expected: PASS with 2 tests.

- [ ] **Step 5: Commit**

```powershell
git add packages/contracts
git commit -m "feat: define common API and event contracts"
```

### Task 3: Freeze domain contracts

**Files:**
- Create: `packages/contracts/src/identity/index.ts`
- Create: `packages/contracts/src/iam/index.ts`
- Create: `packages/contracts/src/catalog/index.ts`
- Create: `packages/contracts/src/routing/index.ts`
- Create: `packages/contracts/src/wallet/index.ts`
- Create: `packages/contracts/src/payment/index.ts`
- Create: `packages/contracts/src/generation/index.ts`
- Create: `packages/contracts/src/provider/index.ts`
- Create: `packages/contracts/src/asset/index.ts`
- Create: `packages/contracts/src/operations/index.ts`
- Create: `packages/contracts/src/notification/index.ts`
- Create: `packages/contracts/src/reporting/index.ts`
- Test: `packages/contracts/test/domains.test.ts`

- [ ] **Step 1: Write failing contract tests**

```ts
// packages/contracts/test/domains.test.ts
import { describe, expect, it } from 'vitest';
import { CreateTaskCommandSchema, TaskStatusSchema } from '../src/generation/index.js';
import { LedgerCommandSchema } from '../src/wallet/index.js';

describe('domain contracts', () => {
  it('parses a task command with a pricing snapshot', () => {
    expect(
      CreateTaskCommandSchema.parse({
        userId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a2',
        quoteId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a3',
        capabilityVersionId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a4',
        parameters: { prompt: 'ocean at dusk' },
        quotedPoints: '1200',
      }).quotedPoints,
    ).toBe('1200');
    expect(TaskStatusSchema.parse('RUNNING')).toBe('RUNNING');
  });

  it('requires a unique business key for ledger commands', () => {
    expect(
      LedgerCommandSchema.parse({
        businessKey: 'task:0198:reserve',
        userId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a2',
        kind: 'RESERVE',
        points: '1200',
      }).kind,
    ).toBe('RESERVE');
  });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `corepack pnpm --filter @repo/contracts test`

Expected: FAIL because domain modules do not exist.

- [ ] **Step 3: Implement identity, IAM, catalog and routing contracts**

```ts
// packages/contracts/src/identity/index.ts
import { z } from 'zod';
import { UuidSchema } from '../common/index.js';

export const UserStatusSchema = z.enum(['ACTIVE', 'SUSPENDED', 'CLOSED']);
export const UserSummarySchema = z.object({
  id: UuidSchema,
  phoneMasked: z.string(),
  nickname: z.string().min(1).max(40),
  status: UserStatusSchema,
});
export const RequestSmsCodeSchema = z.object({ phone: z.string().regex(/^1\d{10}$/) });
export const VerifySmsCodeSchema = RequestSmsCodeSchema.extend({ code: z.string().regex(/^\d{6}$/) });
```

```ts
// packages/contracts/src/iam/index.ts
import { z } from 'zod';
import { UuidSchema } from '../common/index.js';

export const PermissionKeySchema = z.string().regex(/^[a-z]+:[a-z-]+$/);
export const RoleSchema = z.object({
  id: UuidSchema,
  name: z.string().min(2).max(40),
  permissions: z.array(PermissionKeySchema),
  dataScope: z.enum(['ALL', 'OWN', 'ASSIGNED']),
});
```

```ts
// packages/contracts/src/catalog/index.ts
import { z } from 'zod';
import { UuidSchema } from '../common/index.js';

export const GenerationModeSchema = z.enum([
  'TEXT_TO_VIDEO', 'IMAGE_TO_VIDEO', 'FIRST_LAST_FRAME', 'REFERENCE_VIDEO', 'EXTEND_VIDEO',
]);
export const ModelStatusSchema = z.enum(['DRAFT', 'ACTIVE', 'MAINTENANCE', 'DISABLED']);
export const ModelSummarySchema = z.object({
  id: UuidSchema,
  providerId: UuidSchema,
  code: z.string().min(1),
  displayName: z.string().min(1),
  modes: z.array(GenerationModeSchema).min(1),
  status: ModelStatusSchema,
  capabilityVersionId: UuidSchema,
});
```

```ts
// packages/contracts/src/routing/index.ts
import { z } from 'zod';
import { PointsStringSchema, UtcDateTimeSchema, UuidSchema } from '../common/index.js';

export const QuoteSchema = z.object({
  id: UuidSchema,
  userId: UuidSchema,
  modelId: UuidSchema.optional(),
  candidateModelIds: z.array(UuidSchema).default([]),
  capabilityVersionId: UuidSchema,
  quotedPoints: PointsStringSchema,
  pricingRuleVersion: z.int().positive(),
  expiresAt: UtcDateTimeSchema,
  parametersHash: z.string().regex(/^[a-f0-9]{64}$/),
});
```

- [ ] **Step 4: Implement wallet, payment, generation and provider contracts**

```ts
// packages/contracts/src/wallet/index.ts
import { z } from 'zod';
import { PointsStringSchema, UuidSchema } from '../common/index.js';

export const LedgerKindSchema = z.enum(['CREDIT', 'RESERVE', 'SETTLE', 'RELEASE', 'ADJUST']);
export const LedgerCommandSchema = z.object({
  businessKey: z.string().min(8).max(120),
  userId: UuidSchema,
  kind: LedgerKindSchema,
  points: PointsStringSchema,
  reason: z.string().max(240).optional(),
});
export const WalletBalanceSchema = z.object({
  userId: UuidSchema,
  available: PointsStringSchema,
  frozen: PointsStringSchema,
});
```

```ts
// packages/contracts/src/payment/index.ts
import { z } from 'zod';
import { CurrencySchema, MinorAmountSchema, PointsStringSchema, UuidSchema } from '../common/index.js';

export const PaymentStatusSchema = z.enum(['PENDING', 'PAID', 'CLOSED', 'REFUNDED', 'FAILED']);
export const RechargeOrderSchema = z.object({
  id: UuidSchema,
  userId: UuidSchema,
  amountMinor: MinorAmountSchema,
  currency: CurrencySchema,
  points: PointsStringSchema,
  status: PaymentStatusSchema,
});
```

```ts
// packages/contracts/src/generation/index.ts
import { z } from 'zod';
import { PointsStringSchema, UuidSchema } from '../common/index.js';

export const TaskStatusSchema = z.enum([
  'QUOTED', 'RESERVED', 'QUEUED', 'SUBMITTING', 'RUNNING',
  'SUCCEEDED', 'FAILED', 'CANCELED', 'EXPIRED', 'SETTLED', 'REFUNDED',
]);
export const CreateTaskCommandSchema = z.object({
  userId: UuidSchema,
  quoteId: UuidSchema,
  capabilityVersionId: UuidSchema,
  parameters: z.record(z.string(), z.unknown()),
  quotedPoints: PointsStringSchema,
});
```

```ts
// packages/contracts/src/provider/index.ts
import { z } from 'zod';
import { UuidSchema } from '../common/index.js';

export const ProviderTaskStateSchema = z.enum(['ACCEPTED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED']);
export const ProviderExecutionSchema = z.object({
  taskId: UuidSchema,
  providerId: UuidSchema,
  providerTaskId: z.string().min(1),
  state: ProviderTaskStateSchema,
  rawCode: z.string().optional(),
});
```

- [ ] **Step 5: Implement supporting and reporting contracts**

```ts
// packages/contracts/src/asset/index.ts
import { z } from 'zod';
import { UuidSchema } from '../common/index.js';
export const AssetKindSchema = z.enum(['UPLOAD', 'RESULT', 'THUMBNAIL']);
export const AssetSchema = z.object({ id: UuidSchema, ownerId: UuidSchema, kind: AssetKindSchema, objectKey: z.string().min(1), mimeType: z.string().min(3), sizeBytes: z.string().regex(/^\d+$/) });
```

```ts
// packages/contracts/src/operations/index.ts
import { z } from 'zod';
import { PointsStringSchema, UuidSchema } from '../common/index.js';
export const RechargePackageSchema = z.object({ id: UuidSchema, name: z.string().min(1), points: PointsStringSchema, bonusPoints: PointsStringSchema, active: z.boolean() });
export const TicketStatusSchema = z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED']);
```

```ts
// packages/contracts/src/notification/index.ts
import { z } from 'zod';
import { UuidSchema } from '../common/index.js';
export const NotificationChannelSchema = z.enum(['IN_APP', 'SMS']);
export const NotificationCommandSchema = z.object({ id: UuidSchema, userId: UuidSchema, templateKey: z.string().min(1), channel: NotificationChannelSchema, variables: z.record(z.string(), z.string()) });
```

```ts
// packages/contracts/src/reporting/index.ts
import { z } from 'zod';
import { PointsStringSchema } from '../common/index.js';
export const DailyBusinessMetricSchema = z.object({ date: z.iso.date(), rechargePoints: PointsStringSchema, consumedPoints: PointsStringSchema, providerCostMinor: z.string().regex(/^\d+$/), successfulTasks: z.int().nonnegative(), failedTasks: z.int().nonnegative() });
```

- [ ] **Step 6: Run the full contract tests**

Run: `corepack pnpm --filter @repo/contracts test && corepack pnpm --filter @repo/contracts typecheck`

Expected: PASS; TypeScript exits 0.

- [ ] **Step 7: Commit**

```powershell
git add packages/contracts
git commit -m "feat: freeze domain API contracts"
```

### Task 4: Implement the capability schema package

**Files:**
- Create: `packages/capability-schema/package.json`
- Create: `packages/capability-schema/tsconfig.json`
- Create: `packages/capability-schema/src/index.ts`
- Test: `packages/capability-schema/test/capability.test.ts`

- [ ] **Step 1: Write the failing conditional-field test**

```ts
// packages/capability-schema/test/capability.test.ts
import { describe, expect, it } from 'vitest';
import { CapabilityDocumentSchema } from '../src/index.js';

describe('CapabilityDocument', () => {
  it('validates a versioned image-to-video capability', () => {
    const value = CapabilityDocumentSchema.parse({
      schemaVersion: 1,
      mode: 'IMAGE_TO_VIDEO',
      jsonSchema: {
        type: 'object',
        required: ['image', 'duration'],
        properties: {
          image: { type: 'string', format: 'asset-id' },
          duration: { type: 'integer', enum: [5, 10] },
        },
      },
      uiSchema: { order: ['image', 'duration'], groups: [{ key: 'basic', title: '基础', fields: ['image', 'duration'] }] },
      costDimensions: ['duration'],
    });
    expect(value.costDimensions).toEqual(['duration']);
  });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `corepack pnpm --filter @repo/capability-schema test`

Expected: FAIL because the package does not exist.

- [ ] **Step 3: Implement the package**

```json
// packages/capability-schema/package.json
{
  "name": "@repo/capability-schema",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": { "build": "tsc -p tsconfig.json", "lint": "eslint src test", "typecheck": "tsc -p tsconfig.json --noEmit", "test": "vitest run", "test:coverage": "vitest run --coverage" },
  "dependencies": { "@repo/contracts": "workspace:*", "ajv": "8.20.0", "zod": "4.4.3" }
}
```

```ts
// packages/capability-schema/src/index.ts
import { z } from 'zod';
import { GenerationModeSchema } from '@repo/contracts/catalog';

const JsonSchemaSchema = z.record(z.string(), z.unknown()).refine((value) => value.type === 'object', 'root JSON Schema type must be object');
const UiGroupSchema = z.object({ key: z.string().min(1), title: z.string().min(1), fields: z.array(z.string()).min(1) });
export const CapabilityDocumentSchema = z.object({
  schemaVersion: z.int().positive(),
  mode: GenerationModeSchema,
  jsonSchema: JsonSchemaSchema,
  uiSchema: z.object({ order: z.array(z.string()), groups: z.array(UiGroupSchema) }),
  costDimensions: z.array(z.string()),
});
export type CapabilityDocument = z.infer<typeof CapabilityDocumentSchema>;
```

```json
// packages/capability-schema/tsconfig.json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "outDir": "dist", "rootDir": "." }, "include": ["src/**/*.ts", "test/**/*.ts"] }
```

- [ ] **Step 4: Run tests and commit**

Run: `corepack pnpm --filter @repo/capability-schema test && corepack pnpm --filter @repo/capability-schema typecheck`

Expected: PASS.

```powershell
git add packages/capability-schema
git commit -m "feat: add dynamic capability schema"
```

### Task 5: Implement Provider SDK and conformance harness

**Files:**
- Create: `packages/provider-sdk/package.json`
- Create: `packages/provider-sdk/tsconfig.json`
- Create: `packages/provider-sdk/src/index.ts`
- Create: `packages/provider-sdk/src/conformance.ts`
- Test: `packages/provider-sdk/test/conformance.test.ts`

- [ ] **Step 1: Write a failing fake-adapter conformance test**

```ts
// packages/provider-sdk/test/conformance.test.ts
import { describe, expect, it } from 'vitest';
import { runAdapterConformance, type VideoProviderAdapter } from '../src/index.js';

const adapter: VideoProviderAdapter = {
  code: 'fake',
  async validateConfiguration() { return { valid: true, issues: [] }; },
  async getHealth() { return { status: 'UP', latencyMs: 5 }; },
  async createTask(input) { return { providerTaskId: `p-${input.taskId}`, state: 'ACCEPTED' }; },
  async queryTask() { return { state: 'SUCCEEDED', resultUrls: ['https://example.invalid/result.mp4'] }; },
  async verifyCallback() { return { valid: true, payload: {} }; },
  async normalizeCallback() { return { state: 'SUCCEEDED', resultUrls: [] }; },
};

describe('provider conformance', () => {
  it('accepts a complete adapter', async () => {
    await expect(runAdapterConformance(adapter)).resolves.toEqual([]);
  });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `corepack pnpm --filter @repo/provider-sdk test`

Expected: FAIL because the package does not exist.

- [ ] **Step 3: Implement the adapter interface and harness**

```ts
// packages/provider-sdk/src/index.ts
export type ProviderState = 'ACCEPTED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED';
export interface CanonicalCreateTask { taskId: string; modelCode: string; parameters: Record<string, unknown>; idempotencyKey: string; }
export interface ProviderResult { state: ProviderState; resultUrls?: string[]; errorCode?: string; errorMessage?: string; }
export interface VideoProviderAdapter {
  readonly code: string;
  validateConfiguration(): Promise<{ valid: boolean; issues: string[] }>;
  getHealth(): Promise<{ status: 'UP' | 'DEGRADED' | 'DOWN'; latencyMs: number }>;
  createTask(input: CanonicalCreateTask): Promise<{ providerTaskId: string; state: ProviderState }>;
  queryTask(input: { providerTaskId: string }): Promise<ProviderResult>;
  cancelTask?(input: { providerTaskId: string }): Promise<ProviderResult>;
  verifyCallback(input: { headers: Record<string, string>; body: unknown }): Promise<{ valid: boolean; payload: unknown }>;
  normalizeCallback(input: { payload: unknown }): Promise<ProviderResult>;
  getBalance?(): Promise<{ unit: string; available: string }>;
}
export { runAdapterConformance } from './conformance.js';
```

```ts
// packages/provider-sdk/src/conformance.ts
import type { VideoProviderAdapter } from './index.js';

export async function runAdapterConformance(adapter: VideoProviderAdapter): Promise<string[]> {
  const issues: string[] = [];
  const configuration = await adapter.validateConfiguration();
  if (!configuration.valid) issues.push(...configuration.issues);
  const health = await adapter.getHealth();
  if (health.status === 'DOWN') issues.push('adapter health is DOWN');
  const created = await adapter.createTask({ taskId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a2', modelCode: 'test-model', parameters: { prompt: 'test' }, idempotencyKey: 'conformance-create-1' });
  if (!created.providerTaskId) issues.push('createTask returned no providerTaskId');
  const queried = await adapter.queryTask({ providerTaskId: created.providerTaskId });
  if (!queried.state) issues.push('queryTask returned no state');
  const callback = await adapter.verifyCallback({ headers: {}, body: {} });
  if (!callback.valid) issues.push('callback verification rejected conformance fixture');
  await adapter.normalizeCallback({ payload: callback.payload });
  return issues;
}
```

- [ ] **Step 4: Add package configuration, run and commit**

```json
// packages/provider-sdk/package.json
{
  "name": "@repo/provider-sdk",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "lint": "eslint src test",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "test:coverage": "vitest run --coverage"
  },
  "dependencies": {
    "@repo/contracts": "workspace:*",
    "zod": "4.4.3"
  }
}
```

```json
// packages/provider-sdk/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "." },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

Run: `corepack pnpm --filter @repo/provider-sdk test && corepack pnpm --filter @repo/provider-sdk typecheck`

Expected: PASS.

```powershell
git add packages/provider-sdk
git commit -m "feat: add provider adapter SDK and conformance harness"
```

### Task 6: Implement service-kit and testkit

**Files:**
- Create: `packages/service-kit/src/problem-details.filter.ts`
- Create: `packages/service-kit/src/trace.middleware.ts`
- Create: `packages/service-kit/src/index.ts`
- Create: `packages/testkit/src/fakes.ts`
- Test: `packages/service-kit/test/problem-details.test.ts`

- [ ] **Step 1: Write a failing error mapping test**

```ts
// packages/service-kit/test/problem-details.test.ts
import { describe, expect, it } from 'vitest';
import { toApiError } from '../src/index.js';

describe('toApiError', () => {
  it('does not leak unknown error messages', () => {
    expect(toApiError(new Error('database password=secret'), 'a'.repeat(32))).toEqual({
      code: 'INTERNAL_ERROR', message: '系统暂时不可用', retryable: true, traceId: 'a'.repeat(32),
    });
  });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `corepack pnpm --filter @repo/service-kit test`

Expected: FAIL because `toApiError` does not exist.

- [ ] **Step 3: Implement safe error mapping and trace middleware**

```ts
// packages/service-kit/src/problem-details.filter.ts
import type { ApiError } from '@repo/contracts/common';
export function toApiError(error: unknown, traceId: string): ApiError {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return { code: error.code, message: '请求无法完成', retryable: false, traceId };
  }
  return { code: 'INTERNAL_ERROR', message: '系统暂时不可用', retryable: true, traceId };
}
```

```ts
// packages/service-kit/src/trace.middleware.ts
import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { HEADERS } from '@repo/contracts/common';
export async function traceMiddleware(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const incoming = request.headers[HEADERS.traceId];
  const traceId = typeof incoming === 'string' && /^[a-f0-9]{32}$/.test(incoming) ? incoming : randomBytes(16).toString('hex');
  request.headers[HEADERS.traceId] = traceId;
  void reply.header(HEADERS.traceId, traceId);
}
```

```ts
// packages/service-kit/src/index.ts
export * from './problem-details.filter.js';
export * from './trace.middleware.js';
```

```ts
// packages/testkit/src/fakes.ts
export class FakeClock {
  constructor(private current: Date = new Date('2026-08-28T00:00:00.000Z')) {}
  now(): Date { return new Date(this.current); }
  advance(ms: number): void { this.current = new Date(this.current.getTime() + ms); }
}
export class InMemoryEventBus {
  readonly events: unknown[] = [];
  async publish(event: unknown): Promise<void> { this.events.push(structuredClone(event)); }
}
```

- [ ] **Step 4: Add package manifests, run tests and commit**

```json
// packages/service-kit/package.json
{
  "name": "@repo/service-kit",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "lint": "eslint src test",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "test:coverage": "vitest run --coverage"
  },
  "dependencies": {
    "@nestjs/common": "12.0.1",
    "@nestjs/core": "12.0.1",
    "@repo/contracts": "workspace:*",
    "fastify": "5.6.2",
    "reflect-metadata": "0.2.2",
    "rxjs": "7.8.2"
  }
}
```

```json
// packages/testkit/package.json
{
  "name": "@repo/testkit",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "lint": "eslint src test",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run --passWithNoTests",
    "test:coverage": "vitest run --coverage --passWithNoTests"
  }
}
```

```json
// packages/service-kit/tsconfig.json and packages/testkit/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "." },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

Run: `corepack pnpm --filter @repo/service-kit test && corepack pnpm --filter @repo/testkit typecheck`

Expected: PASS.

```powershell
git add packages/service-kit packages/testkit
git commit -m "feat: add service and test foundations"
```

### Task 7: Add shared UI primitives

**Files:**
- Create: `packages/ui/package.json`
- Create: `packages/ui/src/button.tsx`
- Create: `packages/ui/src/status-badge.tsx`
- Create: `packages/ui/src/index.ts`
- Test: `packages/ui/test/status-badge.test.tsx`

- [ ] **Step 1: Write the failing status badge test**

```tsx
// packages/ui/test/status-badge.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusBadge } from '../src/index.js';
describe('StatusBadge', () => {
  it('exposes semantic status text', () => {
    render(<StatusBadge tone="success">已完成</StatusBadge>);
    expect(screen.getByText('已完成')).toHaveAttribute('data-tone', 'success');
  });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `corepack pnpm --filter @repo/ui test`

Expected: FAIL because the package does not exist.

- [ ] **Step 3: Implement accessible primitives**

```tsx
// packages/ui/src/button.tsx
import type { ButtonHTMLAttributes, ReactNode } from 'react';
export function Button({ children, type = 'button', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) {
  return <button type={type} {...props}>{children}</button>;
}
```

```tsx
// packages/ui/src/status-badge.tsx
import type { ReactNode } from 'react';
export function StatusBadge({ tone, children }: { tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger'; children: ReactNode }) {
  return <span data-tone={tone}>{children}</span>;
}
```

```ts
// packages/ui/src/index.ts
export * from './button.js';
export * from './status-badge.js';
```

- [ ] **Step 4: Add package config, run and commit**

```json
// packages/ui/package.json
{
  "name": "@repo/ui",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "lint": "eslint src test",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run --environment jsdom",
    "test:coverage": "vitest run --coverage --environment jsdom"
  },
  "peerDependencies": { "react": "19.2.8", "react-dom": "19.2.8" },
  "devDependencies": {
    "@testing-library/jest-dom": "6.9.1",
    "@testing-library/react": "16.3.0",
    "@types/react": "19.2.14",
    "@types/react-dom": "19.2.3",
    "jsdom": "28.0.0",
    "react": "19.2.8",
    "react-dom": "19.2.8"
  }
}
```

```json
// packages/ui/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": ".",
    "jsx": "react-jsx",
    "lib": ["ES2023", "DOM", "DOM.Iterable"]
  },
  "include": ["src/**/*.ts", "src/**/*.tsx", "test/**/*.ts", "test/**/*.tsx"]
}
```

Run: `corepack pnpm --filter @repo/ui test && corepack pnpm --filter @repo/ui typecheck`

Expected: PASS.

```powershell
git add packages/ui
git commit -m "feat: add shared accessible UI primitives"
```

### Task 8: Add local infrastructure and CI

**Files:**
- Create: `infra/local/compose.yaml`
- Create: `infra/local/.env.example`
- Create: `.github/workflows/ci.yml`
- Test: `scripts/validate-compose.test.ts`

- [ ] **Step 1: Write the failing compose validation test**

```ts
// scripts/validate-compose.test.ts
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
describe('local compose', () => {
  it('contains postgres, redis, RocketMQ, minio and mailpit', async () => {
    const yaml = await readFile('infra/local/compose.yaml', 'utf8');
    for (const service of ['postgres:', 'redis:', 'rocketmq-namesrv:', 'rocketmq-broker:', 'minio:', 'mailpit:']) {
      expect(yaml).toContain(service);
    }
  });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `corepack pnpm dlx vitest@4.1.11 run scripts/validate-compose.test.ts`

Expected: FAIL because `compose.yaml` does not exist.

- [ ] **Step 3: Create local services**

```yaml
# infra/local/compose.yaml
services:
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: platform
      POSTGRES_PASSWORD: local-only-password
      POSTGRES_DB: platform
    ports: ['5432:5432']
    healthcheck: { test: ['CMD-SHELL', 'pg_isready -U platform'], interval: 5s, timeout: 3s, retries: 20 }
    volumes: [postgres-data:/var/lib/postgresql/data]
  redis:
    image: redis:8-alpine
    command: ['redis-server', '--appendonly', 'yes']
    ports: ['6379:6379']
    healthcheck: { test: ['CMD', 'redis-cli', 'ping'], interval: 5s, timeout: 3s, retries: 20 }
  rocketmq-namesrv:
    image: apache/rocketmq:5.3.2
    command: sh mqnamesrv
    ports: ['9876:9876']
  rocketmq-broker:
    image: apache/rocketmq:5.3.2
    command: sh mqbroker -n rocketmq-namesrv:9876 --enable-proxy
    environment: { NAMESRV_ADDR: rocketmq-namesrv:9876 }
    depends_on: [rocketmq-namesrv]
    ports: ['8081:8081', '10911:10911']
  minio:
    image: minio/minio:RELEASE.2026-07-15T18-52-09Z
    command: server /data --console-address :9001
    environment: { MINIO_ROOT_USER: localminio, MINIO_ROOT_PASSWORD: local-only-password }
    ports: ['9000:9000', '9001:9001']
    volumes: [minio-data:/data]
  mailpit:
    image: axllent/mailpit:v1.27
    ports: ['1025:1025', '8025:8025']
volumes:
  postgres-data: {}
  minio-data: {}
```

```dotenv
# infra/local/.env.example
DATABASE_URL=postgresql://platform:local-only-password@localhost:5432/platform
REDIS_URL=redis://localhost:6379
ROCKETMQ_ENDPOINT=localhost:8081
S3_ENDPOINT=http://localhost:9000
S3_ACCESS_KEY=localminio
S3_SECRET_KEY=local-only-password
```

- [ ] **Step 4: Create CI**

```yaml
# .github/workflows/ci.yml
name: ci
on:
  pull_request:
  push:
    branches: [main, codex/integration]
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: pnpm }
      - run: corepack enable
      - run: corepack pnpm install --frozen-lockfile
      - run: corepack pnpm verify
```

- [ ] **Step 5: Validate and commit**

Run: `docker compose -f infra/local/compose.yaml config --quiet && corepack pnpm dlx vitest@4.1.11 run scripts/validate-compose.test.ts && corepack pnpm verify`

Expected: all commands exit 0.

```powershell
git add infra/local .github/workflows/ci.yml scripts/validate-compose.test.ts
git commit -m "chore: add local infrastructure and CI"
```

## WS00 completion gate

Run:

```powershell
corepack pnpm verify
docker compose -f infra/local/compose.yaml config --quiet
git status --short
```

Expected: verification exits 0, Compose is valid, and Git status is empty. Merge WS00 into `codex/integration`, then create all Wave 1 branches from that merged commit.
