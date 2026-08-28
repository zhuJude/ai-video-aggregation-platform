# WS15 User Web Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现面向中国大陆付费用户的完整 Web 产品，包括官网、模型广场、手机号登录、智能/专业生成工作台、任务/作品、点数/订单/发票、消息、工单和安全设置。

**Architecture:** Next.js App Router 按公开区和登录工作区分组。服务端组件负责首屏和 SEO，交互表单/任务状态使用客户端组件；所有业务通过 Gateway API，动态表单由冻结 Capability Schema 驱动，任务状态使用 SSE 并轮询降级。

**Tech Stack:** Next.js 16、React 19、TypeScript 7、Zod/AJV、React Hook Form、Vitest/Testing Library、Playwright、MSW、`@repo/ui`。

---

## 文件所有权

只修改 `apps/user-web/**`、`docs/product/user-web.md`。不得修改 `packages/ui`。

## 路由地图

```text
/(marketing)              首页
/models                   模型广场
/models/[id]              模型详情
/pricing                  价格中心
/help                     帮助中心
/login                    手机号登录
/studio                   生成工作台
/tasks                    任务中心
/tasks/[id]               任务详情
/assets                   作品与素材
/wallet                   点数钱包
/orders                   充值订单
/invoices                 发票
/messages                 消息中心
/tickets                  工单
/settings/profile         资料
/settings/security        设备、会话、换绑、注销
```

### Task 1: Build the application shell and design tokens

**Files:**
- Create: `apps/user-web/package.json`
- Create: `apps/user-web/app/layout.tsx`
- Create: `apps/user-web/app/globals.css`
- Create: `apps/user-web/components/app-shell.tsx`
- Test: `apps/user-web/test/app-shell.test.tsx`

- [ ] **Step 1: Write failing navigation test**

```tsx
it('shows the primary workspace destinations', () => {
  render(<AppShell user={{ nickname: '小林', points: '1200' }}>{null}</AppShell>);
  for (const label of ['开始生成', '任务中心', '作品素材', '点数钱包']) expect(screen.getByRole('link', { name: label })).toBeVisible();
});
```

- [ ] **Step 2: Implement the shell**

Create a responsive desktop sidebar and mobile bottom navigation, skip-to-content link, visible focus rings, reduced-motion support, error boundary and empty/loading states. Show available/frozen points but never expose raw user ID. Use CSS custom properties for warm dark-neutral surfaces, high-contrast text, success/warning/danger states and an 8px spacing scale; no gradients or decorative animations that obscure task state.

- [ ] **Step 3: Verify and commit**

Run: `corepack pnpm --filter @repo/user-web test -- app-shell.test.tsx`

Expected: PASS.

```powershell
git add apps/user-web
git commit -m "feat(user-web): add accessible application shell"
```

### Task 2: Implement Gateway client and phone login

**Files:**
- Create: `apps/user-web/lib/api-client.ts`
- Create: `apps/user-web/app/login/page.tsx`
- Create: `apps/user-web/components/auth/phone-login-form.tsx`
- Test: `apps/user-web/test/phone-login.test.tsx`

- [ ] **Step 1: Write failing cooldown and error tests**

```tsx
it('prevents repeated SMS requests during cooldown', async () => {
  render(<PhoneLoginForm />);
  await user.type(screen.getByLabelText('手机号'), '13800138000');
  await user.click(screen.getByRole('button', { name: '获取验证码' }));
  expect(screen.getByRole('button', { name: /重新发送/ })).toBeDisabled();
});
it('announces an invalid code without clearing the phone', async () => {
  server.use(invalidCodeHandler);
  await submitCode('000000');
  expect(await screen.findByRole('alert')).toHaveTextContent('验证码错误');
  expect(screen.getByLabelText('手机号')).toHaveValue('13800138000');
});
```

- [ ] **Step 2: Implement API client and form**

`apiClient` sends credentials, Trace/Correlation and explicit idempotency keys for writes; maps `ApiErrorSchema`; aborts ordinary requests after ten seconds. Login validates `^1\d{10}$`, uses a 60-second UI cooldown, six-digit code, generic anti-enumeration messages and server-provided `Retry-After`. Refresh happens server-side with HttpOnly cookie; browser JavaScript never stores tokens.

- [ ] **Step 3: Verify and commit**

Run: `corepack pnpm --filter @repo/user-web test -- phone-login.test.tsx`

Expected: PASS.

```powershell
git add apps/user-web
git commit -m "feat(user-web): add secure phone login"
```

### Task 3: Build marketing, model and pricing pages

**Files:**
- Create: `apps/user-web/app/(marketing)/page.tsx`
- Create: `apps/user-web/app/models/page.tsx`
- Create: `apps/user-web/app/models/[id]/page.tsx`
- Create: `apps/user-web/app/pricing/page.tsx`
- Create: `apps/user-web/app/help/[[...slug]]/page.tsx`
- Test: `apps/user-web/test/models-page.test.tsx`

- [ ] **Step 1: Write failing model visibility test**

```tsx
it('shows capability, point price and maintenance state', async () => {
  render(await ModelsPage({ searchParams: Promise.resolve({ mode: 'IMAGE_TO_VIDEO' }) }));
  expect(screen.getByText('图生视频')).toBeVisible();
  expect(screen.getByText(/点数/)).toBeVisible();
  expect(screen.getByText('维护中')).toHaveAttribute('data-tone', 'warning');
});
```

- [ ] **Step 2: Implement server-rendered pages**

Use real API data and stable metadata. Model cards show provider display name, modes, typical price range, speed/quality labels and health state; no fake generation time guarantee. Pricing explains point conversion, failure refund and post-acceptance cancellation rules. Help content renders sanitized published HTML only.

- [ ] **Step 3: Verify and commit**

Run: `corepack pnpm --filter @repo/user-web test -- models-page.test.tsx`

Expected: PASS.

```powershell
git add apps/user-web
git commit -m "feat(user-web): add model discovery and pricing"
```

### Task 4: Implement the dynamic generation studio

**Files:**
- Create: `apps/user-web/app/studio/page.tsx`
- Create: `apps/user-web/components/studio/capability-form.tsx`
- Create: `apps/user-web/components/studio/smart-mode.tsx`
- Create: `apps/user-web/components/studio/pro-mode.tsx`
- Create: `apps/user-web/components/studio/quote-confirmation.tsx`
- Test: `apps/user-web/test/capability-form.test.tsx`

- [ ] **Step 1: Write failing Schema rendering tests**

```tsx
it('renders required enum and conditional fields in UI Schema order', async () => {
  render(<CapabilityForm document={imageToVideoCapability} onValid={vi.fn()} />);
  expect(screen.getAllByLabelText(/.+/).map((node) => node.getAttribute('name'))).toEqual(['image', 'duration', 'motion']);
  await user.selectOptions(screen.getByLabelText('运动模式'), 'custom');
  expect(screen.getByLabelText('自定义运动描述')).toBeVisible();
});
it('rejects unknown fields before quote request', () => expect(validateForm(schema, { image: 'asset-1', injected: true })).toMatchObject({ valid: false }));
```

- [ ] **Step 2: Implement the renderer**

Support string/textarea/integer/boolean/enum/asset-id fields, groups, order, required indicators, defaults, min/max, conditional visibility and cross-field errors. Validate with AJV on every quote submission; omit hidden optional fields, but never silently omit an invalid visible field. Unsupported Schema keywords show a blocking “模型配置暂不可用” error and report the capability version.

- [ ] **Step 3: Implement smart/pro modes and quote**

Smart mode collects mode, quality, speed and budget preferences. Pro mode selects exact provider/model and renders its Schema. Quote confirmation shows selected model or smart-routing promise, parameters, quoted points, expiry countdown, failure refund and cancellation rule. Submit uses a fresh UUID idempotency key and disables repeated clicks until a definitive response.

- [ ] **Step 4: Verify and commit**

Run: `corepack pnpm --filter @repo/user-web test -- capability-form.test.tsx`

Expected: PASS.

```powershell
git add apps/user-web
git commit -m "feat(user-web): add dynamic AI video studio"
```

### Task 5: Implement tasks and resilient live status

**Files:**
- Create: `apps/user-web/app/tasks/page.tsx`
- Create: `apps/user-web/app/tasks/[id]/page.tsx`
- Create: `apps/user-web/lib/task-event-stream.ts`
- Test: `apps/user-web/test/task-status.test.tsx`

- [ ] **Step 1: Write failing reconnect and terminal-state tests**

```tsx
it('reconnects with Last-Event-ID and falls back to polling', async () => {
  render(<TaskStatus taskId="task-1" initial={queuedTask} />);
  eventSource.emitError();
  await advanceTimersByTimeAsync(5000);
  expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('/tasks/task-1'), expect.anything());
});
it('does not regress a terminal status on an old event', () => expect(reduceStatus(settledTask, runningEvent)).toEqual(settledTask));
```

- [ ] **Step 2: Implement list/detail/status UX**

Provide cursor pagination and filters. Timeline shows normalized public reasons, pricing/model snapshot and financial state. SSE reconnects with exponential backoff and `Last-Event-ID`; after three failures poll every five seconds. Stop all background work at terminal status. Cancel button appears only when API declares `cancelAllowed`; retry copies parameters into a new quote flow.

- [ ] **Step 3: Verify and commit**

Run: `corepack pnpm --filter @repo/user-web test -- task-status.test.tsx`

Expected: PASS.

```powershell
git add apps/user-web
git commit -m "feat(user-web): add resilient task center"
```

### Task 6: Implement assets, wallet, orders and invoices

**Files:**
- Create: `apps/user-web/app/assets/page.tsx`
- Create: `apps/user-web/app/wallet/page.tsx`
- Create: `apps/user-web/app/orders/page.tsx`
- Create: `apps/user-web/app/invoices/page.tsx`
- Test: `apps/user-web/test/wallet-assets.test.tsx`

- [ ] **Step 1: Write failing financial display test**

```tsx
it('renders available and frozen points separately and preserves exact integers', () => {
  render(<WalletSummary balance={{ available: '9007199254740993', frozen: '1200' }} />);
  expect(screen.getByText('9,007,199,254,740,993')).toBeVisible();
  expect(screen.getByText('1,200')).toBeVisible();
});
```

- [ ] **Step 2: Implement pages**

Never convert point strings to JavaScript Number; format with `BigInt`. Assets use signed preview/download URLs, accessible video controls, rename/delete confirmation and upload progress. Wallet shows immutable transaction types. Recharge creates an order with idempotency key then renders the server payment payload. Invoice application only lists eligible paid order amounts and prevents duplicate selection.

- [ ] **Step 3: Verify and commit**

Run: `corepack pnpm --filter @repo/user-web test -- wallet-assets.test.tsx`

Expected: PASS.

```powershell
git add apps/user-web
git commit -m "feat(user-web): add assets wallet orders and invoices"
```

### Task 7: Implement messages, tickets and security settings

**Files:**
- Create: `apps/user-web/app/messages/page.tsx`
- Create: `apps/user-web/app/tickets/page.tsx`
- Create: `apps/user-web/app/settings/profile/page.tsx`
- Create: `apps/user-web/app/settings/security/page.tsx`
- Test: `apps/user-web/test/security-settings.test.tsx`

- [ ] **Step 1: Write failing session revocation test**

```tsx
it('requires confirmation before revoking another device', async () => {
  render(<SessionList sessions={sessions} />);
  await user.click(screen.getByRole('button', { name: '退出 Windows Chrome' }));
  expect(screen.getByRole('dialog')).toHaveTextContent('该设备需要重新登录');
  expect(revoke).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Implement pages**

Messages support unread state and deep links. Tickets keep public replies separate from attachments and show status history. Security settings list masked devices/sessions, current-device marker, revoke/exit-all, phone change verification and account deletion with typed confirmation and consequences.

- [ ] **Step 3: Verify and commit**

Run: `corepack pnpm --filter @repo/user-web test -- security-settings.test.tsx`

Expected: PASS.

```powershell
git add apps/user-web
git commit -m "feat(user-web): add messages support and security"
```

### Task 8: Add E2E accessibility and product documentation

**Files:**
- Create: `apps/user-web/e2e/core-flow.spec.ts`
- Create: `apps/user-web/e2e/accessibility.spec.ts`
- Create: `apps/user-web/Dockerfile`
- Create: `docs/product/user-web.md`

- [ ] **Step 1: Add Playwright core flow**

Test phone login with Mock SMS, discover a model, upload fixture, quote, submit, observe SSE success, open result, verify wallet settlement, create a failed task and verify refund. Use deterministic API/MSW fixtures, not sleeps.

- [ ] **Step 2: Add accessibility and responsive checks**

Run axe on marketing, login, studio, task detail, wallet and ticket pages at desktop and 390px mobile. Assert keyboard-only quote/submit, visible focus, form error associations and reduced-motion behavior.

- [ ] **Step 3: Add production image/docs and verify**

Use Next standalone output and non-root Node image. Document routes, capability renderer behavior, error/loading/empty states, analytics events and product acceptance screenshots.

Run: `corepack pnpm --filter @repo/user-web test && corepack pnpm --filter @repo/user-web build && corepack pnpm --filter @repo/user-web exec playwright test`

Expected: PASS.

```powershell
git add apps/user-web docs/product/user-web.md
git commit -m "test(user-web): verify commercial user journey"
```

## WS15 completion gate

Run: `corepack pnpm --filter @repo/user-web lint && corepack pnpm --filter @repo/user-web typecheck && corepack pnpm --filter @repo/user-web test && corepack pnpm --filter @repo/user-web build && git status --short`

Expected: all pass, clean branch, no lockfile/shared UI/contract changes.
