import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import {
  acceptanceScreenshot,
  expectLastMainActionAboveBottomNavigation,
  expectNoPageOverflow,
  focusWithKeyboard,
  login,
} from './helpers';

async function expectWcag22Aa(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(result.violations).toEqual([]);
}

test('WCAG 2.2 AA, focus, error, reduced motion and overflow acceptance', async ({
  page,
  isMobile,
}, testInfo) => {
  await page.goto('/');
  await expectWcag22Aa(page);
  await expectNoPageOverflow(page);
  await acceptanceScreenshot(page, testInfo, 'home');

  await page.goto('/login');
  await expectWcag22Aa(page);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '手机号' })).toBeFocused();
  await expect(page.getByRole('textbox', { name: '手机号' })).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  await expect(page.locator('#phone-login-error')).toHaveText('请输入 11 位手机号');
  await expectWcag22Aa(page);
  await expectNoPageOverflow(page);
  await acceptanceScreenshot(page, testInfo, 'login-error');

  await login(page);
  await page.getByLabel('生成方式').selectOption('TEXT_TO_VIDEO');
  await page.getByLabel('画面描述').fill('键盘完成报价与提交的横屏画面');
  await page.getByLabel('画面描述').focus();
  await focusWithKeyboard(page, { role: 'button', name: '获取准确报价' });
  await expect(page.getByRole('button', { name: '获取准确报价' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: '本次报价与任务规则' })).toBeVisible();
  await focusWithKeyboard(page, { role: 'button', name: '确认并创建任务' });
  await expect(page.getByRole('button', { name: '确认并创建任务' })).toBeFocused();
  await expectWcag22Aa(page);
  await expectNoPageOverflow(page);
  await acceptanceScreenshot(page, testInfo, 'studio-quote');
  if (isMobile) await expectLastMainActionAboveBottomNavigation(page);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reducedMotion = await page
    .getByRole('button', { name: '确认并创建任务' })
    .evaluate((element) => {
      const milliseconds = (duration: string) =>
        duration.endsWith('ms') ? Number.parseFloat(duration) : Number.parseFloat(duration) * 1_000;
      const style = getComputedStyle(element);
      return {
        animationDurationMs: milliseconds(style.animationDuration),
        transitionDurationMs: milliseconds(style.transitionDuration),
      };
    });
  expect(reducedMotion.animationDurationMs).toBeLessThanOrEqual(0.01);
  expect(reducedMotion.transitionDurationMs).toBeLessThanOrEqual(0.01);
  await page.keyboard.press('Enter');
  await expect(page.getByText(/任务已创建，编号/)).toBeVisible();

  const protectedPages = [
    { path: '/tasks/task-2', screenshot: 'task-detail' },
    { path: '/wallet', screenshot: 'wallet' },
    { path: '/tickets', screenshot: 'tickets' },
  ] as const;
  for (const route of protectedPages) {
    await page.goto(route.path);
    await expectWcag22Aa(page);
    await expectNoPageOverflow(page);
    await acceptanceScreenshot(page, testInfo, route.screenshot);
    if (isMobile) await expectLastMainActionAboveBottomNavigation(page);
  }
});
