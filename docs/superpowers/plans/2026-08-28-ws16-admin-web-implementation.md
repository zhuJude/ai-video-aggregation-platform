# WS16 Admin Web Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现完整运营管理后台，包括经营看板、用户、供应商/密钥、模型 Schema、定价/路由、任务、财务/对账/发票、内容/工单、RBAC/审计和系统运行视图。

**Architecture:** 独立 Next.js 管理应用和独立管理员会话。菜单、路由和操作都受权限点控制；高风险操作使用确认/双人复核；复杂配置采用草稿—校验—差异—发布—回滚流程。

**Tech Stack:** Next.js 16、React 19、TypeScript、AJV、Vitest/Testing Library、Playwright、MSW、`@repo/ui`。

---

## 文件所有权

只修改 `apps/admin-web/**`、`docs/product/admin-web.md`。不得修改 `packages/ui`。

## 一级导航

```text
总览 / 用户 / 供应商 / 模型能力 / 定价路由 / 任务 / 财务 / 内容运营 / 工单 / 后台权限 / 审计 / 系统运行
```

### Task 1: Build permission-aware shell and MFA login

**Files:**
- Create: `apps/admin-web/package.json`
- Create: `apps/admin-web/app/layout.tsx`
- Create: `apps/admin-web/app/login/page.tsx`
- Create: `apps/admin-web/components/admin-shell.tsx`
- Test: `apps/admin-web/test/admin-shell.test.tsx`

- [ ] **Step 1: Write failing permission test**

```tsx
it('hides finance navigation without finance permission', () => {
  render(<AdminShell subject={{ permissions: ['users:read'], dataScope: 'ALL' }}>{null}</AdminShell>);
  expect(screen.queryByRole('link', { name: '财务' })).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: '用户' })).toBeVisible();
});
```

- [ ] **Step 2: Implement shell and MFA flow**

Use separate admin brand/domain treatment, dense but readable navigation, command search, breadcrumbs and environment badge. Password step never reveals account existence; TOTP step accepts six digits and shows lockout/cooldown. Route middleware enforces authentication, while every server action independently checks its permission.

- [ ] **Step 3: Verify and commit**

Run: `corepack pnpm --filter @repo/admin-web test -- admin-shell.test.tsx`

Expected: PASS.

```powershell
git add apps/admin-web
git commit -m "feat(admin-web): add MFA and permission-aware shell"
```

### Task 2: Implement overview and user operations

**Files:**
- Create: `apps/admin-web/app/(secure)/overview/page.tsx`
- Create: `apps/admin-web/app/(secure)/users/page.tsx`
- Create: `apps/admin-web/app/(secure)/users/[id]/page.tsx`
- Test: `apps/admin-web/test/users.test.tsx`

- [ ] **Step 1: Write failing data-scope and adjustment tests**

```tsx
it('does not render wallet adjustment without permission', () => {
  render(<UserDetail user={user} permissions={['users:read']} />);
  expect(screen.queryByRole('button', { name: '调整点数' })).not.toBeInTheDocument();
});
it('requires reason and a second approver', async () => {
  render(<AdjustmentDialog userId={user.id} />);
  await userEvent.click(screen.getByRole('button', { name: '提交申请' }));
  expect(screen.getByText('请填写调整原因')).toBeVisible();
});
```

- [ ] **Step 2: Implement views**

Overview shows source timestamps and partial-data warnings. User search is server-side with cursor pagination, exact phone lookup only for authorized roles, default masked phone, CSV export audit and no bulk point edit. Detail shows account/session, tasks, wallet, orders, tickets and audit tabs. Adjustment is a request, never a direct balance edit.

- [ ] **Step 3: Verify and commit**

Run: `corepack pnpm --filter @repo/admin-web test -- users.test.tsx`

Expected: PASS.

```powershell
git add apps/admin-web
git commit -m "feat(admin-web): add overview and user operations"
```

### Task 3: Implement provider and credential management

**Files:**
- Create: `apps/admin-web/app/(secure)/providers/page.tsx`
- Create: `apps/admin-web/app/(secure)/providers/[id]/page.tsx`
- Test: `apps/admin-web/test/providers.test.tsx`

- [ ] **Step 1: Write failing secret-redaction test**

```tsx
it('never places a full credential in the DOM', () => {
  const { container } = render(<CredentialPanel credential={{ masked: 'sk_****7d2a', rotatedAt: '2026-08-28T00:00:00Z' }} />);
  expect(container.textContent).not.toContain('sk_live_full_secret');
  expect(screen.getByText('sk_****7d2a')).toBeVisible();
});
```

- [ ] **Step 2: Implement provider operations**

Show health, latency, rate limits, circuit state, balance, discount and maintenance window. Credential form accepts a replacement secret once, sends it directly to protected API, clears the field immediately and only renders masked metadata afterward. Rotation, disable, health probe and circuit reset require explicit permission and reason.

- [ ] **Step 3: Verify and commit**

Run: `corepack pnpm --filter @repo/admin-web test -- providers.test.tsx`

Expected: PASS.

```powershell
git add apps/admin-web
git commit -m "feat(admin-web): add secure provider operations"
```

### Task 4: Implement model capability editor and publication

**Files:**
- Create: `apps/admin-web/app/(secure)/models/page.tsx`
- Create: `apps/admin-web/app/(secure)/models/[id]/capabilities/page.tsx`
- Create: `apps/admin-web/components/capabilities/schema-editor.tsx`
- Test: `apps/admin-web/test/schema-editor.test.tsx`

- [ ] **Step 1: Write failing validation/diff tests**

```tsx
it('blocks publication when UI fields are absent from JSON Schema', async () => {
  render(<SchemaEditor initial={invalidCapability} />);
  await user.click(screen.getByRole('button', { name: '校验' }));
  expect(screen.getByRole('alert')).toHaveTextContent('UI 字段 motion 不存在');
  expect(screen.getByRole('button', { name: '发布' })).toBeDisabled();
});
```

- [ ] **Step 2: Implement safe editor**

Provide structured field builder plus raw JSON advanced mode, live user-form preview, AJV validation, cost-dimension checks, version diff and rollback. Published versions are read-only. Publish dialog shows affected model, field additions/removals, pricing impact and requires typed model code.

- [ ] **Step 3: Verify and commit**

Run: `corepack pnpm --filter @repo/admin-web test -- schema-editor.test.tsx`

Expected: PASS.

```powershell
git add apps/admin-web
git commit -m "feat(admin-web): add versioned capability editor"
```

### Task 5: Implement pricing, routing and task operations

**Files:**
- Create: `apps/admin-web/app/(secure)/pricing/page.tsx`
- Create: `apps/admin-web/app/(secure)/routing/page.tsx`
- Create: `apps/admin-web/app/(secure)/tasks/page.tsx`
- Create: `apps/admin-web/app/(secure)/tasks/[id]/page.tsx`
- Test: `apps/admin-web/test/task-operations.test.tsx`

- [ ] **Step 1: Write failing loss and retry-confirmation tests**

```tsx
it('blocks a sale rule below minimum margin', async () => {
  render(<PricingEditor costPoints="1000" minimumMarginBps={2000} />);
  await user.type(screen.getByLabelText('销售点数'), '1100');
  expect(screen.getByRole('alert')).toHaveTextContent('低于最低毛利率');
});
it('shows duplicate-purchase risk before provider retry', async () => {
  render(<TaskActions task={ambiguousAcceptedTask} />);
  expect(screen.getByRole('button', { name: '重试供应商' })).toBeDisabled();
});
```

- [ ] **Step 2: Implement pricing/routing**

Use BigInt point formatting, versioned draft/publication, effective-time preview, route simulation with candidate/exclusion/score explanation and margin-risk table. Never calculate authoritative price only in the browser.

- [ ] **Step 3: Implement task operations**

Display public and permission-protected raw tabs, state timeline, queue/attempt/circuit data and financial effects. Retry, switch, cancel, refund and repair buttons appear only when API returns allowed operations. Each action requires reason, impact preview and idempotency key.

- [ ] **Step 4: Verify and commit**

Run: `corepack pnpm --filter @repo/admin-web test -- task-operations.test.tsx`

Expected: PASS.

```powershell
git add apps/admin-web
git commit -m "feat(admin-web): add pricing routing and task operations"
```

### Task 6: Implement finance, reconciliation and invoices

**Files:**
- Create: `apps/admin-web/app/(secure)/finance/orders/page.tsx`
- Create: `apps/admin-web/app/(secure)/finance/ledger/page.tsx`
- Create: `apps/admin-web/app/(secure)/finance/reconciliation/page.tsx`
- Create: `apps/admin-web/app/(secure)/finance/invoices/page.tsx`
- Test: `apps/admin-web/test/finance.test.tsx`

- [ ] **Step 1: Write failing precision and repair tests**

```tsx
it('does not lose precision for ledger totals', () => {
  render(<LedgerTotals debit="9007199254740993" credit="9007199254740993" />);
  expect(screen.getAllByText('9,007,199,254,740,993')).toHaveLength(2);
});
it('does not expose repair action to a single approver', () => {
  render(<ReconciliationCase item={mismatch} permissions={['finance:read']} />);
  expect(screen.queryByRole('button', { name: '创建补偿分录' })).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Implement finance workflows**

Orders and refunds have immutable timeline. Ledger search displays transactions/entries but offers no edit. Reconciliation groups platform-only/channel-only/amount/status differences and links Runbook. Invoice status transitions require permission and record certificate/attachment metadata, not tax secrets.

- [ ] **Step 3: Verify and commit**

Run: `corepack pnpm --filter @repo/admin-web test -- finance.test.tsx`

Expected: PASS.

```powershell
git add apps/admin-web
git commit -m "feat(admin-web): add finance and reconciliation console"
```

### Task 7: Implement content, tickets, RBAC, audit and system views

**Files:**
- Create: `apps/admin-web/app/(secure)/content/page.tsx`
- Create: `apps/admin-web/app/(secure)/tickets/page.tsx`
- Create: `apps/admin-web/app/(secure)/iam/page.tsx`
- Create: `apps/admin-web/app/(secure)/audit/page.tsx`
- Create: `apps/admin-web/app/(secure)/system/page.tsx`
- Test: `apps/admin-web/test/rbac.test.tsx`

- [ ] **Step 1: Write failing self-escalation test**

```tsx
it('prevents an admin from granting a permission they do not possess', async () => {
  render(<RoleEditor actorPermissions={['users:read']} role={role} />);
  expect(screen.getByLabelText('wallet:adjust')).toBeDisabled();
});
```

- [ ] **Step 2: Implement modules**

Content uses draft/preview/publish/rollback. Tickets separate public replies and internal notes. RBAC uses permission matrix, role diff and impacted-admin preview; prevent deleting last superadmin and self-escalation. Audit filters by actor/action/resource/Trace/time and exports with audit. System view shows service health, queues, releases and observability links; it edits versioned feature flags, public callback/domain settings and KMS secret references through permissioned publish/rollback flows. Secret values remain write-only and never return to the DOM.

- [ ] **Step 3: Verify and commit**

Run: `corepack pnpm --filter @repo/admin-web test -- rbac.test.tsx`

Expected: PASS.

```powershell
git add apps/admin-web
git commit -m "feat(admin-web): add operations IAM audit and system views"
```

### Task 8: Add E2E, accessibility, image and docs

**Files:**
- Create: `apps/admin-web/e2e/operations.spec.ts`
- Create: `apps/admin-web/e2e/financial-controls.spec.ts`
- Create: `apps/admin-web/Dockerfile`
- Create: `docs/product/admin-web.md`

- [ ] **Step 1: Add Playwright operations flow**

Test MFA login, create provider metadata, draft/publish model capability, publish pricing, simulate route, inspect a task, create point adjustment, approve as a second admin, reconcile an order, publish an announcement and resolve a ticket.

- [ ] **Step 2: Add financial/RBAC negative flow**

Assert self-approval, missing permissions, duplicate publish, raw-secret rendering, direct ledger edit and last-superadmin deletion are impossible. Run axe on overview, user detail, provider, Schema editor, task detail, finance and RBAC at 1280px and keyboard-only.

- [ ] **Step 3: Add image/docs and verify**

Use Next standalone/non-root image. Document every route, permission key, high-risk confirmation, empty/error/loading state and acceptance screenshot.

Run: `corepack pnpm --filter @repo/admin-web test && corepack pnpm --filter @repo/admin-web build && corepack pnpm --filter @repo/admin-web exec playwright test`

Expected: PASS.

```powershell
git add apps/admin-web docs/product/admin-web.md
git commit -m "test(admin-web): verify production operations console"
```

## WS16 completion gate

Run: `corepack pnpm --filter @repo/admin-web lint && corepack pnpm --filter @repo/admin-web typecheck && corepack pnpm --filter @repo/admin-web test && corepack pnpm --filter @repo/admin-web build && git status --short`

Expected: all pass, clean branch, no lockfile/shared UI/contract changes.
