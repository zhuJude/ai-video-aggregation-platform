import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PHONE = '+8613800138000';
const sessionState = vi.hoisted(() => ({ needsRefresh: false, phone: '+8613800138000' }));

vi.mock('../lib/auth/server-session', () => {
  class AuthenticationRequiredError extends Error {}
  class SessionRefreshRequiredError extends Error {}
  return {
    AuthenticationRequiredError,
    SessionRefreshRequiredError,
    requireMutableAuthenticatedServerSession: () => {
      if (sessionState.needsRefresh) throw new SessionRefreshRequiredError();
      return Promise.resolve({ ownerId: sessionState.phone });
    },
  };
});

import { completeUploadAction, createUploadSessionAction } from '../app/commerce-actions';
import { PUT as putMockUpload } from '../app/api/commerce/mock-uploads/[token]/route';
import { AssetLibrary } from '../components/commerce/asset-library';
import { parseUploadReceiptResponse } from '../lib/commerce/runtime';
import type { AssetPage } from '../lib/commerce/types';

const KEY = '0198f4d4-21c2-7b7d-8a03-08a0da2a7801';

beforeEach(() => {
  sessionState.needsRefresh = false;
  sessionState.phone = PHONE;
  process.env.USER_WEB_COMMERCE_MODE = 'mock';
  process.env.USER_WEB_COMMERCE_MOCK_SIGNING_KEY = Buffer.alloc(32, 17).toString('base64url');
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.USER_WEB_COMMERCE_MODE;
  delete process.env.USER_WEB_COMMERCE_MOCK_SIGNING_KEY;
});

const emptyAssets: AssetPage = { items: [], pageInfo: {} };

function installRouteXhr() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const state = { aborted: false, bytes: new Uint8Array() };

  class RouteXhr {
    readonly upload = new EventTarget();
    onabort: ((event: ProgressEvent) => void) | null = null;
    onerror: ((event: ProgressEvent) => void) | null = null;
    onload: ((event: ProgressEvent) => void) | null = null;
    ontimeout: ((event: ProgressEvent) => void) | null = null;
    responseText = '';
    status = 0;
    timeout = 0;
    withCredentials = false;
    #headers = new Headers();
    #url = '';

    open(method: string, url: string) {
      expect(method).toBe('PUT');
      this.#url = url;
    }

    setRequestHeader(name: string, value: string) {
      this.#headers.set(name, value);
    }

    send(body: XMLHttpRequestBodyInit | null) {
      void (async () => {
        const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () => {
            reject(reader.error ?? new Error('FILE_READ_FAILED'));
          };
          reader.onload = () => {
            resolve(reader.result as ArrayBuffer);
          };
          reader.readAsArrayBuffer(body as Blob);
        });
        const bytes = new Uint8Array(buffer);
        state.bytes = bytes;
        this.upload.dispatchEvent(
          new ProgressEvent('progress', {
            lengthComputable: true,
            loaded: Math.max(1, Math.floor(bytes.byteLength / 2)),
            total: bytes.byteLength,
          }),
        );
        await gate;
        if (state.aborted) return;
        const token = this.#url.split('/').at(-1) ?? '';
        const response = await putMockUpload(
          new Request(`https://app.example${this.#url}`, {
            body: bytes as BodyInit,
            headers: {
              ...Object.fromEntries(this.#headers),
              origin: 'https://app.example',
              'sec-fetch-site': 'same-origin',
            },
            method: 'PUT',
          }),
          { params: Promise.resolve({ token }) },
        );
        this.status = response.status;
        this.responseText = await response.text();
        this.onload?.(new ProgressEvent('load'));
      })().catch(() => {
        this.onerror?.(new ProgressEvent('error'));
      });
    }

    abort() {
      state.aborted = true;
      this.onabort?.(new ProgressEvent('abort'));
    }
  }

  vi.stubGlobal('XMLHttpRequest', RouteXhr);
  return { release, state };
}

async function putGrant(
  grant: Awaited<ReturnType<typeof createUploadSessionAction>> & { readonly ok: true },
  bytes: Uint8Array,
) {
  const token = grant.data.url.split('/').at(-1) ?? '';
  const request = new Request(`https://app.example${grant.data.url}`, {
    body: bytes as BodyInit,
    headers: {
      ...grant.data.headers,
      origin: 'https://app.example',
      'sec-fetch-site': 'same-origin',
    },
    method: 'PUT',
  });
  return putMockUpload(request, { params: Promise.resolve({ token }) });
}

describe('stateless commerce upload boundary', () => {
  it('reads and hashes real bytes before a signed receipt can finalize the asset', async () => {
    const created = await createUploadSessionAction(
      { name: '真实帧.png', size: 4, type: 'image/png' },
      KEY,
    );
    expect(created).toMatchObject({ ok: true });
    if (!created.ok) throw new Error('EXPECTED_UPLOAD_GRANT');
    expect(Object.keys(created.data).sort()).toEqual(['expiresAt', 'headers', 'id', 'url']);
    expect(created.data.url).toMatch(/^\/api\/commerce\/mock-uploads\//);

    const response = await putGrant(created, new Uint8Array([0, 1, 2, 255]));
    expect(response.status).toBe(200);
    const receipt = parseUploadReceiptResponse(await response.json());
    const completed = await completeUploadAction(receipt.receipt, KEY);
    expect(completed).toMatchObject({
      ok: true,
      data: { name: '真实帧.png', mimeType: 'image/png', sizeBytes: '4' },
    });
  });

  it('rejects an expired signed grant and a declared/actual byte mismatch', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-12T10:00:00.000Z'));
    const created = await createUploadSessionAction(
      { name: '期限.png', size: 4, type: 'image/png' },
      '0198f4d4-21c2-7b7d-8a03-08a0da2a7802',
    );
    if (!created.ok) throw new Error('EXPECTED_UPLOAD_GRANT');

    const mismatch = await putGrant(created, new Uint8Array([1, 2, 3]));
    expect(mismatch.status).toBe(400);

    vi.setSystemTime(new Date('2026-09-12T10:06:00.000Z'));
    const expired = await putGrant(created, new Uint8Array([1, 2, 3, 4]));
    expect(expired.status).toBe(410);
  });

  it('returns the typed refresh signal so the client can coordinate and retry', async () => {
    const created = await createUploadSessionAction(
      { name: '刷新.png', size: 4, type: 'image/png' },
      '0198f4d4-21c2-7b7d-8a03-08a0da2a7803',
    );
    if (!created.ok) throw new Error('EXPECTED_UPLOAD_GRANT');
    sessionState.needsRefresh = true;
    const response = await putGrant(created, new Uint8Array([1, 2, 3, 4]));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ code: 'SESSION_REFRESH_REQUIRED' });
  });

  it('binds the upload grant to the authenticated owner', async () => {
    const created = await createUploadSessionAction(
      { name: '隔离.png', size: 4, type: 'image/png' },
      '0198f4d4-21c2-7b7d-8a03-08a0da2a7804',
    );
    if (!created.ok) throw new Error('EXPECTED_UPLOAD_GRANT');
    sessionState.phone = '+8613900139000';
    const response = await putGrant(created, new Uint8Array([1, 2, 3, 4]));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('');
  });

  it('uses the production component path to PUT File bytes and report real progress', async () => {
    const xhr = installRouteXhr();
    const user = userEvent.setup();
    render(<AssetLibrary initial={emptyAssets} />);
    const file = new File([new Uint8Array([5, 4, 3, 2])], '真实上传.png', {
      type: 'image/png',
    });

    await user.upload(screen.getByLabelText('上传图片或视频'), file);
    expect(await screen.findByText('50%')).toBeVisible();
    expect([...xhr.state.bytes]).toEqual([5, 4, 3, 2]);
    xhr.release();
    expect(await screen.findByText('上传完成，可在生成工作台中复用。')).toBeVisible();
    expect(screen.getByRole('heading', { name: '真实上传.png' })).toBeVisible();
  });

  it('aborts the production XHR transport immediately', async () => {
    const xhr = installRouteXhr();
    const user = userEvent.setup();
    render(<AssetLibrary initial={emptyAssets} />);
    await user.upload(
      screen.getByLabelText('上传图片或视频'),
      new File([new Uint8Array([1, 2, 3, 4])], '取消.png', { type: 'image/png' }),
    );
    expect(await screen.findByText('50%')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '取消上传' }));
    expect(xhr.state.aborted).toBe(true);
    expect(screen.getByText('上传已取消。')).toBeVisible();
  });
});
