import { expect, type Page, type TestInfo } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function login(page: Page): Promise<void> {
  if (new URL(page.url()).pathname !== '/login') await page.goto('/login');
  await page.getByRole('textbox', { name: '手机号' }).fill('13800138000');
  await page.getByRole('button', { name: '获取验证码' }).click();
  await expect(page.getByText('如果该手机号可用，验证码将尽快发送。')).toBeVisible();
  await expect(page.getByLabel('短信验证码')).toBeFocused();
  await page.getByLabel('短信验证码').fill('123456');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/studio(?:\?.*)?$/);
  await expect(page.getByRole('heading', { name: '从能力配置到透明报价' })).toBeVisible();
}

export async function acceptanceScreenshot(
  page: Page,
  testInfo: TestInfo,
  name: string,
): Promise<string> {
  const breakpoint = testInfo.project.name.startsWith('mobile') ? 'mobile' : 'desktop';
  const directory = resolve(process.cwd(), 'output', 'playwright', 'acceptance', breakpoint);
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, `${name}.png`);
  const focusMarker = await page.evaluate(() => {
    if (!(document.activeElement instanceof HTMLElement)) return false;
    document.activeElement.dataset.acceptanceFocus = 'true';
    document.activeElement.blur();
    return true;
  });
  await page.screenshot({
    animations: 'disabled',
    fullPage: breakpoint === 'desktop',
    path,
  });
  if (focusMarker) {
    const previouslyFocused = page.locator('[data-acceptance-focus="true"]');
    await previouslyFocused.focus();
    await previouslyFocused.evaluate(
      (element) => delete (element as HTMLElement).dataset.acceptanceFocus,
    );
  }
  return path;
}

export async function expectNoPageOverflow(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    )
    .toBe(true);
}

export async function expectLastMainActionAboveBottomNavigation(page: Page): Promise<void> {
  const lastAction = page
    .locator('main')
    .locator(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])',
    )
    .last();
  await expect(lastAction).toBeVisible();
  await lastAction.scrollIntoViewIfNeeded();

  const [actionBox, navigationBox] = await Promise.all([
    lastAction.boundingBox(),
    page.locator('.primary-navigation').boundingBox(),
  ]);
  expect(actionBox, 'last main action should have a browser bounding box').not.toBeNull();
  expect(navigationBox, 'bottom navigation should have a browser bounding box').not.toBeNull();
  if (!actionBox || !navigationBox) throw new Error('MOBILE_NAVIGATION_GEOMETRY_UNAVAILABLE');
  expect(actionBox.y + actionBox.height).toBeLessThanOrEqual(navigationBox.y);
}

export async function focusWithKeyboard(
  page: Page,
  locatorDescription: { readonly role: 'button'; readonly name: string },
): Promise<void> {
  const target = page.getByRole(locatorDescription.role, { name: locatorDescription.name });
  for (let index = 0; index < 40; index += 1) {
    await page.keyboard.press('Tab');
    if (await target.evaluate((element) => element === document.activeElement)) return;
  }
  throw new Error(`KEYBOARD_TARGET_NOT_REACHED:${locatorDescription.name}`);
}
