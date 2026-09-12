import { expect, test, type Page } from '@playwright/test';

import { acceptanceScreenshot, login } from './helpers';

const WEBP_1X1 = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');

function assetIdFromUploadUrl(url: string): string {
  const token = new URL(url).pathname.split('/').at(-1) ?? '';
  const encoded = token.split('.')[0] ?? '';
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown;
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('assetId' in payload) ||
    typeof payload.assetId !== 'string'
  ) {
    throw new Error('UPLOAD_TOKEN_DID_NOT_CONTAIN_ASSET_ID');
  }
  return payload.assetId;
}

async function createTextTask(page: Page, fail: boolean) {
  await page.goto('/studio');
  await page.getByLabel('生成方式').selectOption('TEXT_TO_VIDEO');
  await page.getByLabel('画面描述').fill('日落下的海边公路，镜头缓慢向前推进');
  if (fail) await page.getByLabel('模拟失败路径').check();
  await page.getByRole('button', { name: '获取准确报价' }).click();
  await expect(page.getByRole('heading', { name: '本次报价与任务规则' })).toBeVisible();
  const submit = page.getByRole('button', { name: '确认并创建任务' });
  await submit.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  const accepted = page.getByText(/任务已创建，编号/);
  await expect(accepted).toBeVisible();
  const taskId = (await accepted.textContent())?.match(
    /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/,
  )?.[0];
  if (!taskId) throw new Error('TASK_ID_NOT_RENDERED');
  await page.getByRole('link', { name: '查看任务进度' }).click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${taskId}$`));
  return taskId;
}

test.beforeEach(({ isMobile }) => {
  test.skip(isMobile, 'The full commerce journey runs once at the desktop acceptance breakpoint.');
});

test('phone login, model discovery, WebP upload and resilient commercial lifecycle', async ({
  page,
}, testInfo) => {
  await page.goto('/models');
  await page.getByLabel('生成方式').selectOption('TEXT_TO_VIDEO');
  await page.getByLabel('提供商').selectOption('kling');
  await page.getByRole('button', { name: '应用筛选' }).click();
  await expect(page).toHaveURL(/mode=TEXT_TO_VIDEO/);
  const selectedModel = page.getByRole('article').filter({ hasText: 'Kling 2.1 Pro' });
  await expect(selectedModel).toBeVisible();
  await selectedModel.getByRole('link', { name: '查看详情' }).click();
  await expect(page.getByRole('heading', { name: 'Kling 2.1 Pro' })).toBeVisible();
  await expect(page.getByRole('link', { name: '使用此模型' })).toHaveAttribute(
    'href',
    '/studio?model=kling-2-1-pro',
  );

  await login(page);
  await page.goto('/assets');
  const uploadRequest = page.waitForRequest(
    (request) =>
      request.method() === 'PUT' && request.url().includes('/api/commerce/mock-uploads/'),
  );
  const uploadResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      response.url().includes('/api/commerce/mock-uploads/'),
  );
  await page.getByLabel('上传图片或视频').setInputFiles({
    buffer: WEBP_1X1,
    mimeType: 'image/webp',
    name: 'acceptance-source.webp',
  });
  const uploaded = await uploadRequest;
  expect((await uploadResponse).status()).toBe(200);
  const uploadedAssetId = assetIdFromUploadUrl(uploaded.url());
  const crossOriginUpload = await page.request.put(uploaded.url(), {
    data: WEBP_1X1,
    headers: {
      'content-type': 'image/webp',
      origin: 'https://attacker.invalid',
      'x-upload-content-length': String(WEBP_1X1.byteLength),
    },
  });
  expect(crossOriginUpload.status()).toBe(403);
  await expect(page.getByText('上传完成，可在生成工作台中复用。')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'acceptance-source.webp' })).toBeVisible();

  await page.goto('/studio');
  await page.getByLabel('起始图片').fill(uploadedAssetId);
  await page.getByRole('button', { name: '获取准确报价' }).click();
  await expect(page.getByRole('heading', { name: '本次报价与任务规则' })).toBeVisible();
  await expect(page.getByLabel('报价点数')).toContainText('点');
  const submit = page.getByRole('button', { name: '确认并创建任务' });
  await submit.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  const accepted = page.getByText(/任务已创建，编号/);
  await expect(accepted).toBeVisible();
  const successTaskId = (await accepted.textContent())?.match(
    /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/,
  )?.[0];
  if (!successTaskId) throw new Error('TASK_ID_NOT_RENDERED');

  let disconnected = false;
  await page.route('**/api/tasks/*/events', async (route) => {
    if (!disconnected) {
      disconnected = true;
      await route.abort('connectionfailed');
      return;
    }
    await route.continue();
  });
  await page.getByRole('link', { name: '查看任务进度' }).click();
  await expect(page.getByText('已结算', { exact: true })).toBeVisible({ timeout: 20_000 });
  expect(disconnected).toBe(true);
  await expect(page.getByRole('heading', { name: '生成结果' })).toBeVisible();
  await acceptanceScreenshot(page, testInfo, 'task-success');

  await page.getByRole('button', { name: '预览结果' }).click();
  const preview = page.getByRole('link', { name: '打开短时预览' });
  await expect(preview).toBeVisible();
  const previewUrl = await preview.getAttribute('href');
  if (!previewUrl) throw new Error('PREVIEW_URL_MISSING');
  const media = await page.evaluate(async (source) => {
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    video.src = source;
    return new Promise<{
      canPlay: true;
      duration: number;
      height: number;
      loadedMetadata: true;
      width: number;
    }>((resolve, reject) => {
      let loadedMetadata = false;
      video.addEventListener('loadedmetadata', () => {
        loadedMetadata = true;
      });
      video.addEventListener('canplay', () => {
        if (!loadedMetadata) return;
        resolve({
          canPlay: true,
          duration: video.duration,
          height: video.videoHeight,
          loadedMetadata: true,
          width: video.videoWidth,
        });
      });
      video.addEventListener('error', () => {
        reject(new Error('VIDEO_METADATA_FAILED'));
      });
      document.body.append(video);
      video.load();
    });
  }, previewUrl);
  expect(media.loadedMetadata).toBe(true);
  expect(media.canPlay).toBe(true);
  expect(media.width).toBeGreaterThan(0);
  expect(media.height).toBeGreaterThan(0);
  expect(media.duration).toBeGreaterThan(0);

  await page.goto('/tasks');
  await expect(page.locator(`a[href="/tasks/${successTaskId}"]`)).toHaveCount(1);
  await page.goto('/wallet');
  const successLedger = page
    .locator('tbody tr')
    .filter({ has: page.locator(`a[href="/tasks/${successTaskId}"]`) });
  await expect(successLedger).toHaveCount(2);
  await expect(successLedger.filter({ hasText: '任务结算' })).toHaveCount(1);
  await expect(successLedger.filter({ hasText: '任务冻结' })).toHaveCount(1);
  await acceptanceScreenshot(page, testInfo, 'wallet-settled');

  const failedTaskId = await createTextTask(page, true);
  await expect(page.getByText('已退款', { exact: true })).toBeVisible({ timeout: 20_000 });
  await page.goto('/wallet');
  const failedLedger = page
    .locator('tbody tr')
    .filter({ has: page.locator(`a[href="/tasks/${failedTaskId}"]`) });
  await expect(failedLedger).toHaveCount(2);
  await expect(failedLedger.filter({ hasText: '释放冻结' })).toHaveCount(1);
  await expect(failedLedger.filter({ hasText: '任务冻结' })).toHaveCount(1);
});
