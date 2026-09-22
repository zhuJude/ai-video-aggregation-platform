import { mkdir } from 'node:fs/promises';

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { IDS } from './support/platform-fixture.mjs';

async function actionEntries(form) {
  await expect(form).toBeVisible();
  return form.evaluate((element) => [...new FormData(element).entries()].map(([key, value]) => [key, String(value)]));
}

async function invokeServerAction(page, pathname, entries, overrides = {}) {
  return page.evaluate(async ({ target, formEntries, replacements }) => {
    const form = new FormData();
    for (const [key, value] of formEntries) form.append(key, value);
    for (const [key, value] of Object.entries(replacements)) {
      form.delete(key);
      for (const item of Array.isArray(value) ? value : [value]) form.append(key, String(item));
    }
    const response = await fetch(target, { body: form, credentials: 'same-origin', method: 'POST' });
    return { body: await response.text(), status: response.status };
  }, { target: pathname, formEntries: entries, replacements: overrides });
}

async function fixtureState(context) {
  const response = await context.request.get('https://127.0.0.1:3211/__calls');
  expect(response.ok()).toBe(true);
  return response.json();
}

async function expectFixtureMutation(context, stateKey) {
  await expect.poll(async () => Boolean((await fixtureState(context)).state[stateKey])).toBe(true);
}

async function tabTo(page, target, maximum = 160) {
  const visited = new Set();
  for (let index = 0; index < maximum; index += 1) {
    await page.keyboard.press('Tab');
    const focus = await page.evaluate(() => {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement)) return null;
      const bounds = active.getBoundingClientRect();
      return {
        key: `${active.tagName}:${active.id}:${active.getAttribute('aria-label') ?? ''}:${active.textContent?.trim().slice(0, 80) ?? ''}`,
        visible: active.matches(':focus-visible') && bounds.width > 0 && bounds.height > 0 && getComputedStyle(active).visibility !== 'hidden',
      };
    });
    if (focus) visited.add(focus.key);
    if (await target.evaluate((element) => element === document.activeElement)) {
      expect(focus?.visible).toBe(true);
      expect(visited.size).toBeGreaterThan(1);
      return;
    }
  }
  throw new Error(`Keyboard focus did not reach ${await target.getAttribute('aria-label') ?? await target.textContent()}`);
}

async function login(page, identifier = 'admin@example.com') {
  await page.goto('/login');
  await page.getByLabel('管理员账号').fill(identifier);
  await page.getByLabel('密码').fill('correct horse battery staple');
  await page.getByRole('button', { name: '准备安全登录' }).click();
  await page.getByRole('button', { name: '继续验证' }).click();
  await page.getByLabel('六位验证码').fill('123456');
  await page.getByRole('button', { name: '验证并登录' }).click();
  await expect(page).toHaveURL(/\/overview$/u);
}

test.beforeEach(async ({ request }) => {
  const response = await request.post('https://127.0.0.1:3211/__reset');
  expect(response.ok()).toBe(true);
});

test('financial and RBAC controls fail closed', async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ viewport: { height: 900, width: 1280 } });
  const page = await context.newPage();
  await login(page);

  await page.goto('/finance/reconciliation');
  const requestForm = page.getByRole('form', { name: `创建补偿申请 ${IDS.reconciliation}` });
  await requestForm.getByLabel('申请原因').fill('验证申请人不可自审');
  await requestForm.getByRole('checkbox').check();
  await requestForm.getByRole('button', { name: '创建补偿分录' }).click();
  await expectFixtureMutation(context, 'compensationCreated');
  await page.reload();
  await expect(page.getByRole('form', { name: `审批补偿申请 ${IDS.reconciliation}` })).toHaveCount(0);

  const reviewer = await browser.newContext({ viewport: { height: 900, width: 1280 } });
  const reviewerPage = await reviewer.newPage();
  await login(reviewerPage, 'reviewer@example.com');
  await reviewerPage.goto('/finance/reconciliation');
  const approvalForm = reviewerPage.getByRole('form', { name: `审批补偿申请 ${IDS.reconciliation}` });
  await approvalForm.getByLabel('复核意见').fill('验证服务端自审保护');
  await approvalForm.getByRole('checkbox').check();
  const approvalEntries = await actionEntries(approvalForm);
  await reviewer.close();

  const beforeSelfApproval = await fixtureState(context);
  const selfApproval = await invokeServerAction(page, '/finance/reconciliation', approvalEntries);
  expect(selfApproval.status).toBe(500);
  const afterSelfApproval = await fixtureState(context);
  expect(afterSelfApproval.calls.compensationApprovals).toBe(beforeSelfApproval.calls.compensationApprovals);
  expect(afterSelfApproval.state.compensationApproved).toBe(false);
  await page.reload();
  await expect(page.getByText(/已完成审批 1\/2/u)).toBeVisible();

  await page.goto('/finance/ledger');
  await expect(page.getByRole('table')).toContainText('USER_AVAILABLE');
  await expect(page.locator('form:not([method="get"])')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /编辑|调整|删除/u })).toHaveCount(0);
  await mkdir('output/playwright', { recursive: true });
  await page.locator('nextjs-portal').evaluateAll((nodes) => nodes.forEach((node) => node.remove()));
  await page.screenshot({ fullPage: true, path: 'output/playwright/acceptance-financial-controls.png' });

  await page.goto(`/tasks/${IDS.task}`);
  await page.getByRole('tab', { name: '原始报文' }).click();
  const raw = page.getByLabel('脱敏原始报文');
  await expect(raw).toContainText('[REDACTED]');
  await expect(raw).not.toContainText('raw-secret-must-be-redacted');
  await expect(raw).not.toContainText('raw-token-must-be-redacted');

  await page.goto('/content');
  const publish = page.getByRole('button', { name: '发布内容' });
  const form = publish.locator('xpath=ancestor::form');
  await form.getByLabel('操作原因').fill('验证重复发布保护');
  await form.getByRole('checkbox').check();
  const publishEntries = await actionEntries(form);
  await publish.click();
  await expectFixtureMutation(context, 'contentPublished');
  await page.reload();
  await expect(page.getByText('PUBLISHED')).toBeVisible();
  await expect(page.getByRole('button', { name: '发布内容' })).toHaveCount(0);
  const beforeDuplicate = await fixtureState(context);
  const duplicatePublish = await invokeServerAction(page, '/content', publishEntries);
  expect(duplicatePublish.status).toBe(500);
  const afterDuplicate = await fixtureState(context);
  expect(afterDuplicate.calls.contentOperations).toBe(beforeDuplicate.calls.contentOperations);
  expect(afterDuplicate.state.contentPublished).toBe(true);
  await page.reload();
  await expect(page.getByText('PUBLISHED')).toBeVisible();

  await page.goto('/iam');
  await expect(page.getByText(/超级管理员/u)).toBeVisible();
  await expect(page.getByRole('button', { name: '应用管理员变更' })).toHaveCount(1);
  const safeAdminForm = page.getByRole('button', { name: '应用管理员变更' }).locator('xpath=ancestor::form');
  await safeAdminForm.getByLabel('操作原因').fill('捕获合法管理员命令元数据');
  await safeAdminForm.getByRole('checkbox').check();
  const adminEntries = await actionEntries(safeAdminForm);
  const lastSuperAdmin = await invokeServerAction(page, '/iam', adminEntries, {
    adminId: IDS.actor,
    dataScope: 'ALL',
    expectedVersion: '3',
    operation: 'UPDATE_STATUS',
    preflightToken: 'iam-disable-last-super-token',
    roleId: [IDS.role],
    status: 'DISABLED',
  });
  expect(lastSuperAdmin.status).toBe(500);
  const afterLastSuper = await fixtureState(context);
  expect(afterLastSuper.calls.iamCommands).toBe(0);
  await page.reload();
  const protectedAdmin = page.getByText('admin-****01', { exact: true }).locator('xpath=ancestor::*[@role="group"][1]');
  await expect(protectedAdmin).toContainText('ACTIVE');
  await expect(protectedAdmin.locator('form')).toHaveCount(0);
  await page.locator('nextjs-portal').evaluateAll((nodes) => nodes.forEach((node) => node.remove()));
  await page.screenshot({ fullPage: true, path: 'output/playwright/acceptance-rbac-controls.png' });
  await context.close();

  const viewer = await browser.newContext({ viewport: { height: 900, width: 1280 } });
  const viewerPage = await viewer.newPage();
  await login(viewerPage, 'viewer@example.com');
  await expect(viewerPage.getByRole('link', { name: '后台权限' })).toHaveCount(0);
  const forbidden = await viewerPage.goto('/iam');
  expect(forbidden?.status()).toBe(403);
  await expect(viewerPage.locator('body')).toContainText('FORBIDDEN');
  await expect(viewerPage.locator('body')).not.toBeEmpty();
  const missingPermission = await invokeServerAction(viewerPage, '/finance/reconciliation', approvalEntries);
  expect(missingPermission.status).toBe(403);
  expect(missingPermission.body).toContain('FORBIDDEN');
  await viewer.close();
});

test('critical screens pass axe at 1280px and expose keyboard focus', async ({ page }) => {
  test.setTimeout(180_000);
  await login(page);
  const routes = [
    '/overview',
    `/users/${IDS.user}`,
    `/providers/${IDS.provider}`,
    `/models/${IDS.model}/capabilities`,
    `/tasks/${IDS.task}`,
    '/finance/ledger',
    '/iam',
  ];
  for (const route of routes) {
    await test.step(route, async () => {
      await page.goto(route);
      await page.mouse.move(0, 0);
      await expect(page.getByRole('main')).toBeVisible();
      const results = await new AxeBuilder({ page })
        .exclude('nextjs-portal')
        // Fluent Tabster injects focus sentinels that axe 4.10 reports even
        // though they are implementation-only and hidden from the a11y tree.
        .exclude('[data-tabster-dummy]')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations, `${route}: ${results.violations.map((item) => item.id).join(', ')}`).toEqual([]);

      if (route === '/overview') {
        const providers = page.getByRole('link', { name: '供应商' });
        await tabTo(page, providers);
        await page.keyboard.press('Enter');
        await expect(page).toHaveURL(/\/providers$/u);
      } else if (route.startsWith('/users/')) {
        const adjust = page.getByRole('button', { name: '调整点数' });
        await tabTo(page, adjust);
        await page.keyboard.press('Space');
        await expect(page.getByRole('dialog', { name: '申请调整点数' })).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog', { name: '申请调整点数' })).toHaveCount(0);
        await expect(adjust).toBeFocused();
      } else if (route.startsWith('/providers/')) {
        const probe = page.getByRole('button', { name: '健康探测' });
        await tabTo(page, probe);
        await page.keyboard.press('Space');
        await expect(page.getByRole('dialog')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await expect(probe).toBeFocused();
      } else if (route.includes('/capabilities')) {
        const applyJson = page.getByRole('button', { name: '应用 JSON' });
        await tabTo(page, applyJson);
        await page.keyboard.press('Enter');
        await expect(page.getByRole('region', { name: '高级 JSON 模式' })).toBeVisible();
      } else if (route.startsWith('/tasks/')) {
        const publicTab = page.getByRole('tab', { name: '公开视图' });
        const rawTab = page.getByRole('tab', { name: '原始报文' });
        await tabTo(page, publicTab);
        await page.keyboard.press('ArrowRight');
        await expect(rawTab).toBeFocused();
        expect(await rawTab.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          return element.matches(':focus-visible') && bounds.width > 0 && bounds.height > 0;
        })).toBe(true);
        await page.keyboard.press('Enter');
        await expect(page.getByLabel('脱敏原始报文')).toBeVisible();
      } else if (route === '/finance/ledger') {
        const reconciliation = page.getByRole('link', { name: '渠道对账' });
        await tabTo(page, reconciliation);
        await page.keyboard.press('Enter');
        await expect(page).toHaveURL(/\/finance\/reconciliation$/u);
      } else {
        const overview = page.getByRole('link', { name: '总览' });
        await tabTo(page, overview);
        await page.keyboard.press('Enter');
        await expect(page).toHaveURL(/\/overview$/u);
      }
    });
  }
});
