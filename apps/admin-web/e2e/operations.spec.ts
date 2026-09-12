import { mkdir } from 'node:fs/promises';

import { expect, test } from '@playwright/test';
import { IDS } from './support/platform-fixture.mjs';

async function login(
  page,
  identifier = 'admin@example.com',
  startPath = '/login',
  expectedPath = /\/overview$/u,
) {
  await page.goto(startPath);
  await page.getByLabel('管理员账号').fill(identifier);
  await page.getByLabel('密码').fill('correct horse battery staple');
  await page.getByRole('button', { name: '准备安全登录' }).click();
  await page.getByRole('button', { name: '继续验证' }).click();
  await expect(page.getByText('双因素验证', { exact: true })).toBeVisible();
  await page.getByLabel('六位验证码').fill('123456');
  await page.getByRole('button', { name: '验证并登录' }).click();
  await expect(page).toHaveURL(expectedPath);
}

async function fixtureState(context) {
  const response = await context.request.get('https://127.0.0.1:3211/__calls');
  expect(response.ok()).toBe(true);
  return response.json();
}

async function expectFixtureMutation(context, stateKey) {
  await expect.poll(async () => Boolean((await fixtureState(context)).state[stateKey])).toBe(true);
}

test('MFA returns to the protected filtered list that initiated login', async ({ page }) => {
  await login(
    page,
    'admin@example.com',
    '/tasks?cursor=next_1&query=failed-job&status=FAILED',
    /\/tasks\?cursor=next_1&query=failed-job&status=FAILED$/u,
  );
  await expect(page.getByRole('heading', { name: '任务运营' })).toBeVisible();
});

test('operator completes MFA and the audited operations flow', async ({ browser }) => {
  test.setTimeout(180_000);
  await mkdir('output/playwright', { recursive: true });
  const context = await browser.newContext({ viewport: { height: 900, width: 1280 } });
  await context.request.post('https://127.0.0.1:3211/__reset');
  const page = await context.newPage();
  await login(page);
  await expect(page.getByRole('region', { name: '运营总览' })).toBeVisible();
  await page.locator('nextjs-portal').evaluateAll((nodes) => nodes.forEach((node) => node.remove()));
  await page.screenshot({ fullPage: true, path: 'output/playwright/acceptance-overview.png' });

  await page.goto('/providers');
  await page.getByLabel('供应商名称').fill('北极星视频');
  await page.getByLabel('接口地址').fill('https://north.example.com/v1');
  await page.getByLabel('变更原因').fill('接入新的合规供应商');
  await page.getByRole('checkbox', { name: '我确认提交供应商配置' }).check();
  await page.getByRole('button', { name: '创建供应商' }).click();
  await expect(page.getByText(/配置已受理/u)).toBeVisible();

  await page.goto(`/models/${IDS.model}/capabilities`);
  await page.getByRole('button', { name: '保存草稿' }).click();
  await expect(page.getByText(/草稿已保存/u)).toBeVisible();
  await page.getByRole('button', { name: '校验' }).click();
  await expect(page.getByRole('button', { name: '发布' })).toBeEnabled();
  await page.getByRole('button', { name: '发布' }).click();
  await page.getByLabel('键入模型代码').fill('video_fast');
  await page.getByLabel('发布原因').fill('通过能力和定价校验');
  await page.getByRole('checkbox', { name: '我确认发布新版本' }).check();
  await page.getByRole('button', { name: '确认发布' }).click();
  await expect(page.getByText(/发布已受理/u)).toBeVisible();

  await page.goto('/pricing');
  await page.getByRole('button', { name: '权威影响预览' }).click();
  await expect(page.getByText(/权威预检已完成/u)).toBeVisible();
  await page.getByRole('button', { name: '发布定价' }).click();
  await page.getByLabel('发布原因').fill('同步已发布模型能力');
  await page.getByRole('checkbox', { name: '我确认发布此定价版本' }).check();
  await page.getByRole('button', { name: '确认发布' }).click();
  await expect(page.getByText(/定价发布请求已受理/u)).toBeVisible();

  await page.goto('/routing');
  const simulationInput = page.getByLabel('模拟参数 JSON');
  await simulationInput.click();
  await simulationInput.press('Control+A');
  await simulationInput.pressSequentially('{"duration":5,"resolution":"1080p"}');
  await page.getByRole('button', { name: '运行权威路由模拟' }).click();
  await expect(page.getByRole('table', { name: '路由候选评分' })).toContainText('星河视频供应商');

  await page.goto(`/tasks/${IDS.task}`);
  await expect(page.getByRole('heading', { name: new RegExp(IDS.task, 'u') })).toBeVisible();
  await page.getByRole('tab', { name: '原始报文' }).click();
  await expect(page.getByLabel('脱敏原始报文')).toContainText('[REDACTED]');

  await page.goto(`/users/${IDS.user}`);
  await page.getByRole('button', { name: '调整点数' }).click();
  const adjustment = page.getByRole('dialog', { name: '申请调整点数' });
  await adjustment.getByLabel('调整方向').selectOption('CREDIT');
  await adjustment.getByRole('textbox', { name: '调整点数' }).fill('10');
  await adjustment.getByLabel('调整原因').fill('活动补偿');
  await adjustment.getByLabel('复核人').selectOption(IDS.reviewer);
  await adjustment.getByRole('button', { name: '获取权威预览' }).click();
  await expect(page.getByText(/调整后：110/u)).toBeVisible();
  await adjustment.getByRole('checkbox', { name: '我已核对影响范围，并确认提交双人审批申请' }).check();
  await adjustment.getByRole('button', { name: '提交申请' }).click();
  await expect(page.getByText(/申请待审批/u)).toBeVisible();

  await page.goto('/finance/orders');
  await expect(page.getByRole('heading', { name: `订单 ${IDS.order}` })).toBeVisible();
  await expect(page.getByText(new RegExp(`待对账案件 ${IDS.reconciliation}`, 'u'))).toBeVisible();

  await page.goto('/finance/reconciliation');
  const create = page.getByRole('form', { name: `创建补偿申请 ${IDS.reconciliation}` });
  await create.getByLabel('申请原因').fill('修复渠道金额差异');
  await create.getByRole('checkbox').check();
  await create.getByRole('button', { name: '创建补偿分录' }).click();
  await expectFixtureMutation(context, 'compensationCreated');
  await page.reload();
  await expect(page.getByText(/已完成审批 1\/2/u)).toBeVisible();

  const reviewer = await browser.newContext({ viewport: { height: 900, width: 1280 } });
  const reviewerPage = await reviewer.newPage();
  await login(reviewerPage, 'reviewer@example.com');
  await reviewerPage.goto(`/users/${IDS.user}`);
  await reviewerPage.getByRole('tab', { name: '钱包' }).click();
  const walletApproval = reviewerPage.getByRole('form', { name: `审批点数调整 ${IDS.request}` });
  await walletApproval.getByLabel('审批原因').fill('独立复核活动补偿');
  await walletApproval.getByRole('button', { name: '获取审批预检' }).click();
  await expect(walletApproval.getByText(/权威审批预检已完成/u)).toBeVisible();
  await walletApproval.getByRole('checkbox', { name: '我已核对点数调整并确认批准' }).check();
  await walletApproval.getByRole('button', { name: '批准点数调整' }).click();
  await expect(walletApproval.getByText(/点数调整已批准/u)).toBeVisible();
  await reviewerPage.reload();
  await reviewerPage.getByRole('tab', { name: '钱包' }).click();
  await expect(reviewerPage.getByRole('tabpanel')).toContainText('110');
  await expect(reviewerPage.getByRole('tabpanel')).toContainText('APPROVED');
  await expect(reviewerPage.getByRole('tabpanel')).toContainText(IDS.request);

  await reviewerPage.goto('/finance/reconciliation');
  const approval = reviewerPage.getByRole('form', { name: `审批补偿申请 ${IDS.reconciliation}` });
  await approval.getByLabel('复核意见').fill('账本与渠道凭据一致');
  await approval.getByRole('checkbox').check();
  await approval.getByRole('button', { name: '批准补偿申请' }).click();
  await expectFixtureMutation(context, 'compensationApproved');
  await reviewerPage.reload();
  await expect(reviewerPage.getByText(/已完成审批 2\/2/u)).toBeVisible();
  await reviewer.close();

  await page.goto('/finance/orders');
  await expect(page.getByText(new RegExp(`对账案件 ${IDS.reconciliation} 已修复`, 'u'))).toBeVisible();

  await page.goto('/content');
  const publish = page.getByRole('button', { name: '发布内容' });
  const publishForm = publish.locator('xpath=ancestor::form');
  await publishForm.getByLabel('操作原因').fill('发布维护窗口公告');
  await publishForm.getByRole('checkbox').check();
  await publish.click();
  await expectFixtureMutation(context, 'contentPublished');
  await page.reload();
  await expect(page.getByText('PUBLISHED')).toBeVisible();

  await page.goto('/tickets');
  const resolve = page.getByRole('button', { name: '解决' });
  const resolveForm = resolve.locator('xpath=ancestor::form');
  await resolveForm.getByLabel('操作原因').fill('问题已验证解决');
  await resolveForm.getByRole('checkbox').check();
  await resolve.click();
  await expectFixtureMutation(context, 'ticketResolved');
  await page.reload();
  await expect(page.getByText('RESOLVED')).toBeVisible();
  await page.locator('nextjs-portal').evaluateAll((nodes) => nodes.forEach((node) => node.remove()));
  await page.screenshot({ fullPage: true, path: 'output/playwright/acceptance-core-flow.png' });
  await context.close();
});
