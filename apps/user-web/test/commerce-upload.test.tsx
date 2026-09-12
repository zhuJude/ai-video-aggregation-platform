import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createHash } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
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
import { commerceOwnerIdFromPhone } from '../lib/commerce/identity';
import { createMockUploadGrant, verifyMockUploadGrant } from '../lib/commerce/mock-upload-boundary';
import * as mockObjectStore from '../lib/commerce/mock-object-store';
import {
  listMockObjects,
  reserveMockUpload,
  storeMockUpload,
} from '../lib/commerce/mock-object-store';
import { parseUploadReceiptResponse, usableSignedUrl } from '../lib/commerce/runtime';
import { uploadAssetBytes } from '../lib/commerce/upload-client';
import { createUuidV7 } from '../lib/tasks/identifiers';
import type { AssetPage } from '../lib/commerce/types';

const KEY = '0198f4d4-21c2-7b7d-8a03-08a0da2a7801';
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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

async function installMockStoreLock(owner: {
  readonly version: 1;
  readonly pid: number;
  readonly token: string;
  readonly createdAt: string;
}): Promise<{ readonly lockPath: string; readonly ownerPath: string }> {
  const root = resolve(tmpdir(), 'ai-video-user-web-commerce-mock-v1');
  const lockPath = resolve(root, '.store-lock');
  const ownerPath = resolve(lockPath, 'owner.json');
  await mkdir(root, { recursive: true });
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      await mkdir(lockPath);
      try {
        await writeFile(ownerPath, JSON.stringify(owner), { encoding: 'utf8', flag: 'wx' });
        return { lockPath, ownerPath };
      } catch (error) {
        await rm(lockPath, { force: true, recursive: true });
        throw error;
      }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }
  }
  throw new Error('MOCK_STORE_TEST_LOCK_UNAVAILABLE');
}

describe('stateless commerce upload boundary', () => {
  it('does not claim object-store quota for abandoned upload grants', async () => {
    const grants = await Promise.all(
      [1600, 1601].map((suffix) =>
        createUploadSessionAction(
          { name: `abandoned-${String(suffix)}.mp4`, size: 500 * 1024 * 1024, type: 'video/mp4' },
          `0198f4d4-21c2-7b7d-8a03-${String(suffix).padStart(12, '0')}`,
        ),
      ),
    );
    const later = await createUploadSessionAction(
      { name: 'later.mp4', size: 500 * 1024 * 1024, type: 'video/mp4' },
      '0198f4d4-21c2-7b7d-8a03-000000001602',
    );
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 25 * 60 * 60_000);
    await listMockObjects(commerceOwnerIdFromPhone(PHONE));
    vi.useRealTimers();
    expect(grants).toEqual([
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ ok: true }),
    ]);
    expect(later).toMatchObject({ ok: true });
  });

  it('releases PUT reservations and partials after two aborted 500 MB streams', async () => {
    const ownerId = commerceOwnerIdFromPhone(PHONE);
    const grants = [1610, 1611].map((suffix) =>
      verifyMockUploadGrant(
        createMockUploadGrant(
          { name: `aborted-${String(suffix)}.mp4`, size: 500 * 1024 * 1024, type: 'video/mp4' },
          `0198f4d4-21c2-7b7d-8a03-${String(suffix).padStart(12, '0')}`,
          ownerId,
        )
          .url.split('/')
          .at(-1) ?? '',
      ),
    );
    const validGrant = verifyMockUploadGrant(
      createMockUploadGrant(
        { name: 'valid-after-abort.mp4', size: 25 * 1024 * 1024, type: 'video/mp4' },
        '0198f4d4-21c2-7b7d-8a03-000000001612',
        ownerId,
      )
        .url.split('/')
        .at(-1) ?? '',
    );
    const abortedBody = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new DOMException('aborted', 'AbortError'));
        },
      });
    const [first, second] = grants;
    if (!first || !second) throw new Error('EXPECTED_TWO_GRANTS');
    await expect(storeMockUpload(first, abortedBody())).rejects.toMatchObject({
      name: 'AbortError',
    });
    await expect(storeMockUpload(second, abortedBody())).rejects.toMatchObject({
      name: 'AbortError',
    });
    const validBytes = new Uint8Array(25 * 1024 * 1024);
    validBytes.set(
      new Uint8Array([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0]),
    );
    await expect(
      storeMockUpload(
        validGrant,
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(validBytes);
            controller.close();
          },
        }),
      ),
    ).resolves.toMatch(/^[a-f0-9]{64}$/);
    const root = resolve(tmpdir(), 'ai-video-user-web-commerce-mock-v1');
    const attemptedKeys = new Set([first.storageKey, second.storageKey]);
    expect(
      (await readdir(root)).filter(
        (file) => file.endsWith('.partial') && attemptedKeys.has(file.slice(0, 64)),
      ),
    ).toEqual([]);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 3 * 60 * 60_000);
    await listMockObjects(ownerId);
    vi.useRealTimers();
  });

  it('fails closed without deleting an old active lock and succeeds only after release', async () => {
    const root = resolve(tmpdir(), 'ai-video-user-web-commerce-mock-v1');
    const lockPath = resolve(root, '.store-lock');
    const ownerPath = resolve(lockPath, 'owner.json');
    const ownerId = commerceOwnerIdFromPhone(PHONE);
    const grant = verifyMockUploadGrant(
      createMockUploadGrant(
        { name: 'locked.png', size: PNG_BYTES.byteLength, type: 'image/png' },
        '0198f4d4-21c2-7b7d-8a03-000000001500',
        ownerId,
      )
        .url.split('/')
        .at(-1) ?? '',
    );
    const liveOwner = {
      version: 1,
      pid: process.pid,
      token: '0198f4d4-21c2-7b7d-8a03-000000001510',
      createdAt: new Date(Date.now() - 31_000).toISOString(),
    } as const;
    await installMockStoreLock(liveOwner);
    await utimes(ownerPath, new Date(Date.now() - 31_000), new Date(Date.now() - 31_000));
    const attempted = await reserveMockUpload(grant, { attempts: 1 }).then(
      () => ({ status: 'fulfilled' as const }),
      (error: unknown) => ({ error, status: 'rejected' as const }),
    );
    const retainedLock = await readFile(ownerPath, 'utf8').catch(() => undefined);
    await rm(lockPath, { force: true, recursive: true });
    await reserveMockUpload(grant);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 25 * 60 * 60_000);
    await listMockObjects(ownerId);
    vi.useRealTimers();
    expect(attempted).toMatchObject({
      status: 'rejected',
      error: { code: 'LOCK_UNAVAILABLE', outcome: 'UNCERTAIN' },
    });
    expect(retainedLock).toBe(JSON.stringify(liveOwner));
  });

  it('atomically recovers a proven-dead owner lock for two waiting runtimes', async () => {
    const root = resolve(tmpdir(), 'ai-video-user-web-commerce-mock-v1');
    const lockPath = resolve(root, '.store-lock');
    const ownerId = commerceOwnerIdFromPhone(PHONE);
    const grants = [1520, 1521].map((suffix) =>
      verifyMockUploadGrant(
        createMockUploadGrant(
          { name: `dead-${String(suffix)}.png`, size: PNG_BYTES.byteLength, type: 'image/png' },
          `0198f4d4-21c2-7b7d-8a03-${String(suffix).padStart(12, '0')}`,
          ownerId,
        )
          .url.split('/')
          .at(-1) ?? '',
      ),
    );
    const deadToken = createUuidV7();
    await installMockStoreLock({
      version: 1,
      pid: 2_147_483_647,
      token: deadToken,
      createdAt: new Date().toISOString(),
    });
    const reservations = await Promise.allSettled(grants.map((grant) => reserveMockUpload(grant)));
    const quarantinePath = resolve(root, `.store-lock-quarantine-${deadToken}`);
    const quarantine = await stat(quarantinePath).catch(() => undefined);
    await rm(lockPath, { force: true, recursive: true });
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 25 * 60 * 60_000);
    await listMockObjects(ownerId);
    vi.useRealTimers();
    const leakedRecoveryArtifacts = (await readdir(root)).filter(
      (file) => file.includes(deadToken) && /quarantine|recovery/.test(file),
    );
    expect(reservations.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
    expect(reservations.filter((result) => result.status === 'rejected')).toHaveLength(0);
    expect(quarantine).toBeUndefined();
    expect(leakedRecoveryArtifacts).toEqual([]);
  });

  it('recovers when a recovery-fence owner crashed after atomic publication', async () => {
    const root = resolve(tmpdir(), 'ai-video-user-web-commerce-mock-v1');
    const ownerId = commerceOwnerIdFromPhone(PHONE);
    const deadPid = 2_147_483_647;
    await installMockStoreLock({
      version: 1,
      pid: deadPid,
      token: createUuidV7(),
      createdAt: new Date().toISOString(),
    });
    const recoveryPath = resolve(root, '.store-lock-recovery');
    const recoveryToken = createUuidV7();
    await mkdir(recoveryPath);
    await writeFile(
      resolve(recoveryPath, 'owner.json'),
      JSON.stringify({
        version: 1,
        pid: deadPid,
        token: recoveryToken,
        createdAt: new Date().toISOString(),
      }),
      { encoding: 'utf8', flag: 'wx' },
    );
    const grant = verifyMockUploadGrant(
      createMockUploadGrant(
        { name: 'recover-fence.png', size: PNG_BYTES.byteLength, type: 'image/png' },
        '0198f4d4-21c2-7b7d-8a03-000000001540',
        ownerId,
      )
        .url.split('/')
        .at(-1) ?? '',
    );
    await expect(reserveMockUpload(grant)).resolves.toBeUndefined();
    expect(await stat(recoveryPath).catch(() => undefined)).toBeUndefined();
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 3 * 60 * 60_000);
    await listMockObjects(ownerId);
    vi.useRealTimers();
  });

  it('cleans only strictly named expired lock auxiliaries inside the fixed namespace', async () => {
    const root = resolve(tmpdir(), 'ai-video-user-web-commerce-mock-v1');
    const token = createUuidV7();
    const candidate = resolve(root, `.store-lock-candidate-${token}`);
    const quarantine = resolve(root, `.store-lock-quarantine-${token}`);
    const lookalike = resolve(root, '.store-lock-candidate-not-a-uuid');
    await Promise.all([candidate, quarantine, lookalike].map((path) => mkdir(path)));
    const deadOwner = JSON.stringify({
      version: 1,
      pid: 2_147_483_647,
      token,
      createdAt: new Date().toISOString(),
    });
    await Promise.all(
      [candidate, quarantine].map((path) =>
        writeFile(resolve(path, 'owner.json'), deadOwner, { encoding: 'utf8', flag: 'wx' }),
      ),
    );
    const expired = new Date(Date.now() - 11 * 60_000);
    await Promise.all(
      [candidate, quarantine, lookalike].map((path) => utimes(path, expired, expired)),
    );
    await listMockObjects(commerceOwnerIdFromPhone(PHONE));
    await expect(stat(candidate)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(quarantine)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(lookalike)).resolves.toMatchObject({});
    await rm(lookalike, { force: true, recursive: true });
  });

  it('does not remove a lock when process liveness is unknown', async () => {
    const root = resolve(tmpdir(), 'ai-video-user-web-commerce-mock-v1');
    const lockPath = resolve(root, '.store-lock');
    const ownerPath = resolve(lockPath, 'owner.json');
    const ownerId = commerceOwnerIdFromPhone(PHONE);
    const grant = verifyMockUploadGrant(
      createMockUploadGrant(
        { name: 'unknown.png', size: PNG_BYTES.byteLength, type: 'image/png' },
        '0198f4d4-21c2-7b7d-8a03-000000001530',
        ownerId,
      )
        .url.split('/')
        .at(-1) ?? '',
    );
    await installMockStoreLock({
      version: 1,
      pid: process.pid,
      token: '0198f4d4-21c2-7b7d-8a03-000000001531',
      createdAt: new Date().toISOString(),
    });
    const attempted = await reserveMockUpload(grant, {
      attempts: 1,
      liveness: () => 'UNKNOWN',
    }).catch((error: unknown) => error);
    const retained = await readFile(ownerPath, 'utf8').catch(() => undefined);
    await rm(lockPath, { force: true, recursive: true });
    expect(attempted).toMatchObject({ code: 'LOCK_UNAVAILABLE', outcome: 'UNCERTAIN' });
    expect(retained).toContain('000000001531');
  });

  it('retries filesystem short writes until the complete chunk is durable', async () => {
    const writeChunkFully = (
      mockObjectStore as unknown as {
        writeChunkFully?: (
          handle: {
            write: (
              bytes: Uint8Array,
              offset: number,
              length: number,
            ) => Promise<{ bytesWritten: number }>;
          },
          bytes: Uint8Array,
        ) => Promise<void>;
      }
    ).writeChunkFully;
    expect(writeChunkFully).toBeTypeOf('function');
    if (!writeChunkFully) return;

    const persisted: number[] = [];
    await writeChunkFully(
      {
        write: (bytes, offset, length) => {
          const bytesWritten = Math.min(2, length);
          persisted.push(...bytes.subarray(offset, offset + bytesWritten));
          return Promise.resolve({ bytesWritten });
        },
      },
      new Uint8Array([1, 2, 3, 4, 5]),
    );
    expect(persisted).toEqual([1, 2, 3, 4, 5]);
  });

  it('does not claim quota or open a partial for a pre-locked request stream', async () => {
    const ownerId = commerceOwnerIdFromPhone(PHONE);
    const grant = verifyMockUploadGrant(
      createMockUploadGrant(
        { name: 'locked-stream.png', size: PNG_BYTES.byteLength, type: 'image/png' },
        '0198f4d4-21c2-7b7d-8a03-000000001550',
        ownerId,
      )
        .url.split('/')
        .at(-1) ?? '',
    );
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(PNG_BYTES);
        controller.close();
      },
    });
    const reader = body.getReader();
    await expect(storeMockUpload(grant, body)).rejects.toBeInstanceOf(TypeError);
    reader.releaseLock();
    const root = resolve(tmpdir(), 'ai-video-user-web-commerce-mock-v1');
    const leftovers = (await readdir(root)).filter((file) => file.startsWith(grant.storageKey));
    expect(leftovers).toEqual([]);
  });

  it('compensates the partial and reservation when releasing the claim lock fails', async () => {
    const ownerId = commerceOwnerIdFromPhone(PHONE);
    const grant = verifyMockUploadGrant(
      createMockUploadGrant(
        { name: 'release-failure.png', size: PNG_BYTES.byteLength, type: 'image/png' },
        '0198f4d4-21c2-7b7d-8a03-000000001551',
        ownerId,
      )
        .url.split('/')
        .at(-1) ?? '',
    );
    const error = Object.assign(new Error('injected release failure'), { code: 'EPERM' });
    await expect(
      storeMockUpload(
        grant,
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(PNG_BYTES);
            controller.close();
          },
        }),
        {
          renameDirectory: (source, target) => {
            if (source.endsWith('.store-lock')) return Promise.reject(error);
            return rename(source, target);
          },
        },
      ),
    ).rejects.toBe(error);
    const root = resolve(tmpdir(), 'ai-video-user-web-commerce-mock-v1');
    expect((await readdir(root)).filter((file) => file.startsWith(grant.storageKey))).toEqual([]);
    await rm(resolve(root, '.store-lock'), { force: true, recursive: true });
  });

  it('cleans stale partial metadata and orphaned content from the fixed mock store', async () => {
    const root = resolve(tmpdir(), 'ai-video-user-web-commerce-mock-v1');
    const storageKey = 'b'.repeat(64);
    const temporaryId = '0198f4d4-21c2-7b7d-8a03-08a0da2a7999';
    const paths = [
      resolve(root, `${storageKey}.bin`),
      resolve(root, `${storageKey}.${temporaryId}.partial`),
      resolve(root, `${storageKey}.${temporaryId}.tmp`),
    ];
    await mkdir(root, { recursive: true });
    try {
      await Promise.all(paths.map((path) => writeFile(path, new Uint8Array([1]))));
      const expired = new Date(Date.now() - 25 * 60 * 60_000);
      await Promise.all(paths.map((path) => utimes(path, expired, expired)));
      await listMockObjects(commerceOwnerIdFromPhone(PHONE));
      await Promise.all(
        paths.map((path) => expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })),
      );
    } finally {
      await Promise.all(paths.map((path) => unlink(path).catch(() => undefined)));
    }
  });

  it('atomically enforces total capacity across concurrent reservations', async () => {
    const ownerId = commerceOwnerIdFromPhone(PHONE);
    const grants = [1200, 1201, 1202].map((suffix) => {
      const grant = createMockUploadGrant(
        { name: `capacity-${String(suffix)}.mp4`, size: 350 * 1024 * 1024, type: 'video/mp4' },
        `0198f4d4-21c2-7b7d-8a03-${String(suffix).padStart(12, '0')}`,
        ownerId,
      );
      return verifyMockUploadGrant(grant.url.split('/').at(-1) ?? '');
    });
    const reservations = await Promise.allSettled(grants.map((grant) => reserveMockUpload(grant)));
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 25 * 60 * 60_000);
    await listMockObjects(ownerId);
    vi.useRealTimers();
    expect(reservations.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
    expect(reservations.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it('reads and hashes real bytes before a signed receipt can finalize the asset', async () => {
    const created = await createUploadSessionAction(
      { name: '真实帧.png', size: PNG_BYTES.byteLength, type: 'image/png' },
      KEY,
    );
    expect(created).toMatchObject({ ok: true });
    if (!created.ok) throw new Error('EXPECTED_UPLOAD_GRANT');
    expect(Object.keys(created.data).sort()).toEqual(['expiresAt', 'headers', 'id', 'url']);
    expect(created.data.url).toMatch(/^\/api\/commerce\/mock-uploads\//);

    const response = await putGrant(created, PNG_BYTES);
    expect(response.status).toBe(200);
    const receipt = parseUploadReceiptResponse(await response.json());
    const completed = await completeUploadAction(receipt.receipt, KEY);
    expect(completed).toMatchObject({
      ok: true,
      data: { name: '真实帧.png', mimeType: 'image/png', sizeBytes: '8' },
    });
    vi.resetModules();
    const { commerceGateway: freshGateway } = await import('../lib/commerce/gateway');
    const refreshed = (await freshGateway.listAssets(
      { query: '真实帧' },
      { ownerId: commerceOwnerIdFromPhone(PHONE) },
    )) as { items: Array<{ id: string }> };
    expect(refreshed.items).toContainEqual(expect.objectContaining({ id: KEY }));
    const access = (await freshGateway.requestAssetAccess(KEY, 'PREVIEW', {
      ownerId: commerceOwnerIdFromPhone(PHONE),
    })) as { url: string };
    expect(access.url).toMatch(/^\/api\/commerce\/mock-assets\//);
  });

  it('rejects an expired signed grant and a declared/actual byte mismatch', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-12T10:00:00.000Z'));
    const created = await createUploadSessionAction(
      { name: '期限.png', size: PNG_BYTES.byteLength, type: 'image/png' },
      '0198f4d4-21c2-7b7d-8a03-08a0da2a7802',
    );
    if (!created.ok) throw new Error('EXPECTED_UPLOAD_GRANT');

    const mismatch = await putGrant(created, PNG_BYTES.slice(0, -1));
    expect(mismatch.status).toBe(400);

    vi.setSystemTime(new Date('2026-09-12T10:06:00.000Z'));
    const expired = await putGrant(created, PNG_BYTES);
    expect(expired.status).toBe(410);
  });

  it('returns the typed refresh signal so the client can coordinate and retry', async () => {
    const created = await createUploadSessionAction(
      { name: '刷新.png', size: PNG_BYTES.byteLength, type: 'image/png' },
      '0198f4d4-21c2-7b7d-8a03-08a0da2a7803',
    );
    if (!created.ok) throw new Error('EXPECTED_UPLOAD_GRANT');
    sessionState.needsRefresh = true;
    const response = await putGrant(created, PNG_BYTES);
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ code: 'SESSION_REFRESH_REQUIRED' });
  });

  it('binds the upload grant to the authenticated owner', async () => {
    const created = await createUploadSessionAction(
      { name: '隔离.png', size: PNG_BYTES.byteLength, type: 'image/png' },
      '0198f4d4-21c2-7b7d-8a03-08a0da2a7804',
    );
    if (!created.ok) throw new Error('EXPECTED_UPLOAD_GRANT');
    sessionState.phone = '+8613900139000';
    const response = await putGrant(created, PNG_BYTES);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('');
  });

  it('uses the production component path to PUT File bytes and report real progress', async () => {
    const xhr = installRouteXhr();
    const user = userEvent.setup();
    render(<AssetLibrary initial={emptyAssets} />);
    const file = new File([PNG_BYTES], '真实上传.png', {
      type: 'image/png',
    });

    await user.upload(screen.getByLabelText('上传图片或视频'), file);
    expect(await screen.findByText('50%')).toBeVisible();
    expect(xhr.state.bytes).toEqual(PNG_BYTES);
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

  it('budgets a 500 MB upload far beyond ten seconds while abort stays immediate', async () => {
    const state = { aborted: false, timeout: 0 };
    class TimeoutCaptureXhr {
      readonly upload = new EventTarget();
      onabort: ((event: ProgressEvent) => void) | null = null;
      onerror: ((event: ProgressEvent) => void) | null = null;
      onload: ((event: ProgressEvent) => void) | null = null;
      ontimeout: ((event: ProgressEvent) => void) | null = null;
      responseText = '';
      status = 0;
      timeout = 0;
      withCredentials = false;
      open() {}
      setRequestHeader() {}
      send() {
        state.timeout = this.timeout;
      }
      abort() {
        state.aborted = true;
        this.onabort?.(new ProgressEvent('abort'));
      }
    }
    vi.stubGlobal('XMLHttpRequest', TimeoutCaptureXhr);
    const size = 500 * 1024 * 1024;
    const controller = new AbortController();
    const upload = uploadAssetBytes(
      {
        id: '0198f4d4-21c2-7b7d-8a03-08a0da2a7807',
        url: '/api/commerce/mock-uploads/signed-token.signature',
        headers: {
          'content-type': 'video/mp4',
          'x-upload-content-length': String(size),
        },
        expiresAt: '2099-09-12T10:00:00.000Z',
      },
      { name: 'large.mp4', size, type: 'video/mp4' } as File,
      { signal: controller.signal, onProgress: () => undefined },
    );
    expect(state.timeout).toBeGreaterThan(10_000);
    controller.abort();
    expect(state.aborted).toBe(true);
    await expect(upload).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('classifies a server MIME or magic rejection as definitive', async () => {
    class RejectedXhr {
      readonly upload = new EventTarget();
      onabort: ((event: ProgressEvent) => void) | null = null;
      onerror: ((event: ProgressEvent) => void) | null = null;
      onload: ((event: ProgressEvent) => void) | null = null;
      ontimeout: ((event: ProgressEvent) => void) | null = null;
      responseText = '{"code":"UPLOAD_CONTENT_MISMATCH"}';
      status = 415;
      timeout = 0;
      withCredentials = false;
      open() {}
      setRequestHeader() {}
      send() {
        queueMicrotask(() => this.onload?.(new ProgressEvent('load')));
      }
      abort() {
        this.onabort?.(new ProgressEvent('abort'));
      }
    }
    vi.stubGlobal('XMLHttpRequest', RejectedXhr);
    const file = new File([new Uint8Array(12)], 'bad.mp4', { type: 'video/mp4' });
    await expect(
      uploadAssetBytes(
        {
          id: '0198f4d4-21c2-7b7d-8a03-08a0da2a7808',
          url: '/api/commerce/mock-uploads/signed-token.signature',
          headers: { 'content-type': file.type, 'x-upload-content-length': String(file.size) },
          expiresAt: '2099-09-12T10:00:00.000Z',
        },
        file,
        { signal: new AbortController().signal, onProgress: () => undefined },
      ),
    ).rejects.toMatchObject({ outcome: 'DEFINITIVE_FAILURE' });
  });

  it('rejects declared MP4 content whose magic bytes do not match', async () => {
    const randomBytes = new Uint8Array(16).fill(7);
    const key = '0198f4d4-21c2-7b7d-8a03-08a0da2a7819';
    const created = await createUploadSessionAction(
      { name: '伪造.mp4', size: randomBytes.byteLength, type: 'video/mp4' },
      key,
    );
    if (!created.ok) throw new Error('EXPECTED_UPLOAD_GRANT');
    const response = await putGrant(created, randomBytes);
    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toEqual({ code: 'UPLOAD_CONTENT_MISMATCH' });
    const retryAfterCleanup = await createUploadSessionAction(
      { name: '伪造.mp4', size: randomBytes.byteLength, type: 'video/mp4' },
      key,
    );
    expect(retryAfterCleanup).toMatchObject({ ok: true });
    if (retryAfterCleanup.ok) {
      const retried = await putGrant(
        retryAfterCleanup,
        new Uint8Array([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0]),
      );
      const retryReceipt = parseUploadReceiptResponse(await retried.json());
      await completeUploadAction(retryReceipt.receipt, key);
      await (
        await import('../lib/commerce/gateway')
      ).commerceGateway.deleteAsset(key, {
        ownerId: commerceOwnerIdFromPhone(PHONE),
        idempotencyKey: '0198f4d4-21c2-7b7d-8a03-08a0da2a7820',
      });
    }
  });

  it('does not let a rejected duplicate body invalidate a concurrent valid upload', async () => {
    const key = '0198f4d4-21c2-7b7d-8a03-000000001300';
    const created = await createUploadSessionAction(
      { name: '并发帧.png', size: PNG_BYTES.byteLength, type: 'image/png' },
      key,
    );
    if (!created.ok) throw new Error('EXPECTED_UPLOAD_GRANT');
    const [rejected, accepted] = await Promise.all([
      putGrant(created, new Uint8Array(PNG_BYTES.byteLength).fill(0x41)),
      putGrant(created, PNG_BYTES),
    ]);
    expect(rejected.status).toBe(415);
    expect(accepted.status).toBe(200);
    const receipt = parseUploadReceiptResponse(await accepted.json());
    await expect(completeUploadAction(receipt.receipt, key)).resolves.toMatchObject({ ok: true });
    await (
      await import('../lib/commerce/gateway')
    ).commerceGateway.deleteAsset(key, {
      ownerId: commerceOwnerIdFromPhone(PHONE),
      idempotencyKey: '0198f4d4-21c2-7b7d-8a03-000000001301',
    });
  });

  it('revalidates the actual body when a completed PUT is replayed', async () => {
    const key = '0198f4d4-21c2-7b7d-8a03-000000001400';
    const created = await createUploadSessionAction(
      { name: '重放帧.png', size: PNG_BYTES.byteLength, type: 'image/png' },
      key,
    );
    if (!created.ok) throw new Error('EXPECTED_UPLOAD_GRANT');
    const accepted = await putGrant(created, PNG_BYTES);
    expect(accepted.status).toBe(200);
    const receipt = parseUploadReceiptResponse(await accepted.json());
    const rejectedReplay = await putGrant(created, new Uint8Array(PNG_BYTES.byteLength).fill(0x41));
    expect(rejectedReplay.status).toBe(415);
    await completeUploadAction(receipt.receipt, key);
    await (
      await import('../lib/commerce/gateway')
    ).commerceGateway.deleteAsset(key, {
      ownerId: commerceOwnerIdFromPhone(PHONE),
      idempotencyKey: '0198f4d4-21c2-7b7d-8a03-000000001401',
    });
  });

  it('rejects an extension and declared MIME mismatch before issuing a grant', async () => {
    await expect(
      createUploadSessionAction(
        { name: '伪装.png', size: 12, type: 'video/mp4' },
        '0198f4d4-21c2-7b7d-8a03-08a0da2a7809',
      ),
    ).resolves.toEqual({ ok: false, outcome: 'DEFINITIVE_FAILURE' });
  });

  it('accepts only matching extension, MIME, and magic signatures for every supported format', async () => {
    const cases = [
      { name: 'frame.jpg', type: 'image/jpeg', bytes: new Uint8Array([0xff, 0xd8, 0xff]) },
      { name: 'frame.png', type: 'image/png', bytes: PNG_BYTES },
      {
        name: 'frame.webp',
        type: 'image/webp',
        bytes: new TextEncoder().encode('RIFF0000WEBP'),
      },
      {
        name: 'clip.mp4',
        type: 'video/mp4',
        bytes: new Uint8Array([0, 0, 0, 16, ...new TextEncoder().encode('ftypisom'), 0, 0, 0, 0]),
      },
      {
        name: 'clip.webm',
        type: 'video/webm',
        bytes: new Uint8Array([
          0x1a,
          0x45,
          0xdf,
          0xa3,
          0x87,
          0x42,
          0x82,
          0x84,
          ...new TextEncoder().encode('webm'),
        ]),
      },
      {
        name: 'clip.mov',
        type: 'video/quicktime',
        bytes: new Uint8Array([0, 0, 0, 16, ...new TextEncoder().encode('ftypqt  '), 0, 0, 0, 0]),
      },
    ] as const;
    for (const [index, fixture] of cases.entries()) {
      const key = `0198f4d4-21c2-7b7d-8a03-${String(800 + index).padStart(12, '0')}`;
      const created = await createUploadSessionAction(
        { name: fixture.name, size: fixture.bytes.byteLength, type: fixture.type },
        key,
      );
      expect(created, fixture.name).toMatchObject({ ok: true });
      if (!created.ok) continue;
      const response = await putGrant(created, fixture.bytes);
      expect(response.status).toBe(200);
      const receipt = parseUploadReceiptResponse(await response.json());
      const completed = await completeUploadAction(receipt.receipt, key);
      expect(completed, fixture.name).toMatchObject({ ok: true });
      if (completed.ok) {
        expect(completed.data.mimeType).toBe(fixture.type);
        await (
          await import('../lib/commerce/gateway')
        ).commerceGateway.deleteAsset(key, {
          ownerId: commerceOwnerIdFromPhone(PHONE),
          idempotencyKey: `0198f4d4-21c2-7b7d-8a03-${String(900 + index).padStart(12, '0')}`,
        });
      }
    }
  });

  it('rejects generic EBML and unrelated ISO-BMFF brands masquerading as supported video', async () => {
    const impostors = [
      {
        name: 'injected.webm',
        type: 'video/webm',
        bytes: new Uint8Array([
          0x1a,
          0x45,
          0xdf,
          0xa3,
          0x82,
          0xec,
          0x80,
          0x42,
          0x82,
          0x84,
          ...new TextEncoder().encode('webm'),
        ]),
      },
      {
        name: 'unknown-size.webm',
        type: 'video/webm',
        bytes: new Uint8Array([
          0x1a,
          0x45,
          0xdf,
          0xa3,
          0xff,
          0x42,
          0x82,
          0x84,
          ...new TextEncoder().encode('webm'),
        ]),
      },
      {
        name: 'truncated.webm',
        type: 'video/webm',
        bytes: new Uint8Array([
          0x1a,
          0x45,
          0xdf,
          0xa3,
          0x87,
          0x42,
          0x82,
          0x84,
          ...new TextEncoder().encode('web'),
        ]),
      },
      {
        name: 'avif.mp4',
        type: 'video/mp4',
        bytes: new Uint8Array([0, 0, 0, 16, ...new TextEncoder().encode('ftypavif'), 0, 0, 0, 0]),
      },
      {
        name: 'short.mp4',
        type: 'video/mp4',
        bytes: new Uint8Array([0, 0, 0, 12, ...new TextEncoder().encode('ftypisom')]),
      },
      {
        name: 'invalid-size.mp4',
        type: 'video/mp4',
        bytes: new Uint8Array([0, 0, 0, 8, ...new TextEncoder().encode('ftypisom'), 0, 0, 0, 0]),
      },
      {
        name: 'truncated.mov',
        type: 'video/quicktime',
        bytes: new Uint8Array([0, 0, 0, 24, ...new TextEncoder().encode('ftypqt  '), 0, 0, 0, 0]),
      },
    ] as const;
    for (const [index, fixture] of impostors.entries()) {
      const key = `0198f4d4-21c2-7b7d-8a03-${String(1100 + index).padStart(12, '0')}`;
      const created = await createUploadSessionAction(
        { name: fixture.name, size: fixture.bytes.byteLength, type: fixture.type },
        key,
      );
      if (!created.ok) throw new Error('EXPECTED_UPLOAD_GRANT');
      const response = await putGrant(created, fixture.bytes);
      expect(response.status, fixture.name).toBe(415);
    }
  });

  it('streams stored bytes through owner-bound preview, download, range, and expiry grants', async () => {
    const key = '0198f4d4-21c2-7b7d-8a03-08a0da2a7806';
    const created = await createUploadSessionAction(
      { name: '可下载.png', size: PNG_BYTES.byteLength, type: 'image/png' },
      key,
    );
    if (!created.ok) throw new Error('EXPECTED_UPLOAD_GRANT');
    const uploadResponse = await putGrant(created, PNG_BYTES);
    const receipt = parseUploadReceiptResponse(await uploadResponse.json());
    const completed = await completeUploadAction(receipt.receipt, key);
    if (!completed.ok) throw new Error('EXPECTED_COMPLETED_UPLOAD');
    const ownerId = commerceOwnerIdFromPhone(PHONE);
    const preview = (await (
      await import('../lib/commerce/gateway')
    ).commerceGateway.requestAssetAccess(key, 'PREVIEW', { ownerId })) as {
      url: string;
      expiresAt: string;
    };
    const token = preview.url.split('/').at(-1) ?? '';
    expect(usableSignedUrl(preview)).toBe(preview.url);
    const { GET: getMockAsset } = await import('../app/api/commerce/mock-assets/[token]/route');
    const fullPreview = await getMockAsset(new Request(`https://app.example${preview.url}`), {
      params: Promise.resolve({ token }),
    });
    expect(fullPreview.status).toBe(200);
    expect(new Uint8Array(await fullPreview.arrayBuffer())).toEqual(PNG_BYTES);
    const ranged = await getMockAsset(
      new Request(`https://app.example${preview.url}`, { headers: { range: 'bytes=2-5' } }),
      { params: Promise.resolve({ token }) },
    );
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-type')).toBe('image/png');
    expect(ranged.headers.get('x-content-type-options')).toBe('nosniff');
    expect(ranged.headers.get('content-disposition')).toMatch(/^inline;/);
    expect(ranged.headers.get('content-range')).toBe('bytes 2-5/8');
    expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(PNG_BYTES.slice(2, 6));
    const invalidRange = await getMockAsset(
      new Request(`https://app.example${preview.url}`, { headers: { range: 'bytes=99-100' } }),
      { params: Promise.resolve({ token }) },
    );
    expect(invalidRange.status).toBe(416);
    expect(invalidRange.headers.get('content-range')).toBe('bytes */8');

    const download = (await (
      await import('../lib/commerce/gateway')
    ).commerceGateway.requestAssetAccess(key, 'DOWNLOAD', { ownerId })) as { url: string };
    const downloadToken = download.url.split('/').at(-1) ?? '';
    const downloaded = await getMockAsset(new Request(`https://app.example${download.url}`), {
      params: Promise.resolve({ token: downloadToken }),
    });
    expect(downloaded.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(PNG_BYTES);

    sessionState.phone = '+8613900139000';
    const foreign = await getMockAsset(new Request(`https://app.example${preview.url}`), {
      params: Promise.resolve({ token }),
    });
    expect(foreign.status).toBe(404);
    sessionState.phone = PHONE;

    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(preview.expiresAt) + 1);
    const expired = await getMockAsset(new Request(`https://app.example${preview.url}`), {
      params: Promise.resolve({ token }),
    });
    expect(expired.status).toBe(410);
  });

  it('seeds fixture assets as real store bytes and preserves signed access across reloads', async () => {
    const ownerId = commerceOwnerIdFromPhone(PHONE);
    const assetId = '0198f4d4-21c2-7b7d-8a03-08a0da2a7101';
    const expected = new Uint8Array([
      0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0,
    ]);
    let gateway = (await import('../lib/commerce/gateway')).commerceGateway;
    const access = (await gateway.requestAssetAccess(assetId, 'PREVIEW', { ownerId })) as {
      url: string;
    };
    expect(access.url).toMatch(/^\/api\/commerce\/mock-assets\//);
    vi.resetModules();
    gateway = (await import('../lib/commerce/gateway')).commerceGateway;
    const listed = (await gateway.listAssets({ query: '海边公路' }, { ownerId })) as {
      items: Array<{ id: string }>;
    };
    expect(listed.items).toContainEqual(expect.objectContaining({ id: assetId }));
    const { GET: getMockAsset } = await import('../app/api/commerce/mock-assets/[token]/route');
    const token = access.url.split('/').at(-1) ?? '';
    const response = await getMockAsset(new Request(`https://app.example${access.url}`), {
      params: Promise.resolve({ token }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(expected);
  });

  it('persists rename and removes both stored content and metadata on delete', async () => {
    const key = '0198f4d4-21c2-7b7d-8a03-08a0da2a7821';
    const ownerId = commerceOwnerIdFromPhone(PHONE);
    const root = resolve(tmpdir(), 'ai-video-user-web-commerce-mock-v1');
    const renameKey = '0198f4d4-21c2-7b7d-8a03-08a0da2a7817';
    const laterRenameKey = '0198f4d4-21c2-7b7d-8a03-000000001817';
    const deleteKey = '0198f4d4-21c2-7b7d-8a03-08a0da2a7818';
    const storageKey = createHash('sha256')
      .update(`mock-object:v1:${ownerId}:${key}`, 'utf8')
      .digest('hex');
    const commandFile = (operation: 'DELETE' | 'RENAME', idempotencyKey: string) => {
      const commandStorageKey = createHash('sha256')
        .update(`mock-asset-command:v1:${ownerId}:${operation}:${idempotencyKey}`, 'utf8')
        .digest('hex');
      return resolve(root, `.asset-command-${commandStorageKey}.json`);
    };
    await Promise.all(
      [
        resolve(root, `${storageKey}.json`),
        resolve(root, `${storageKey}.bin`),
        commandFile('RENAME', renameKey),
        commandFile('RENAME', laterRenameKey),
        commandFile('DELETE', deleteKey),
      ].map((path) => unlink(path).catch(() => undefined)),
    );
    const created = await createUploadSessionAction(
      { name: '待整理.png', size: PNG_BYTES.byteLength, type: 'image/png' },
      key,
    );
    if (!created.ok) throw new Error('EXPECTED_UPLOAD_GRANT');
    const uploaded = await putGrant(created, PNG_BYTES);
    const receipt = parseUploadReceiptResponse(await uploaded.json());
    await completeUploadAction(receipt.receipt, key);
    let freshGateway = (await import('../lib/commerce/gateway')).commerceGateway;
    const preview = (await freshGateway.requestAssetAccess(key, 'PREVIEW', { ownerId })) as {
      url: string;
    };
    const renamed = await freshGateway.renameAsset(key, '已整理.png', {
      ownerId,
      idempotencyKey: renameKey,
    });
    vi.resetModules();
    freshGateway = (await import('../lib/commerce/gateway')).commerceGateway;
    await expect(
      freshGateway.renameAsset(key, '已整理.png', { ownerId, idempotencyKey: renameKey }),
    ).resolves.toEqual(renamed);
    await expect(
      freshGateway.renameAsset(key, '冲突名称.png', { ownerId, idempotencyKey: renameKey }),
    ).rejects.toMatchObject({
      message: 'IDEMPOTENCY_CONFLICT',
      outcome: 'DEFINITIVE_FAILURE',
    });
    const renamedList = (await freshGateway.listAssets({ query: '已整理' }, { ownerId })) as {
      items: Array<{ id: string; name: string }>;
    };
    expect(renamedList.items.some((item) => item.id === key && item.name === '已整理.png')).toBe(
      true,
    );
    const commandPath = commandFile('RENAME', renameKey);
    const metadataPath = resolve(root, `${storageKey}.json`);
    const command = JSON.parse(await readFile(commandPath, 'utf8')) as unknown as Record<
      string,
      unknown
    >;
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as unknown as Record<
      string,
      unknown
    >;
    await writeFile(commandPath, JSON.stringify({ ...command, state: 'PENDING' }), 'utf8');
    await writeFile(metadataPath, JSON.stringify({ ...metadata, name: '待整理.png' }), 'utf8');
    vi.resetModules();
    freshGateway = (await import('../lib/commerce/gateway')).commerceGateway;
    await expect(
      freshGateway.renameAsset(key, '后续名称.png', {
        ownerId,
        idempotencyKey: laterRenameKey,
      }),
    ).rejects.toMatchObject({ outcome: 'UNCERTAIN' });
    await expect(
      freshGateway.renameAsset(key, '已整理.png', { ownerId, idempotencyKey: renameKey }),
    ).resolves.toEqual(renamed);
    const completedCommand = JSON.parse(await readFile(commandPath, 'utf8')) as unknown as Record<
      string,
      unknown
    >;
    await writeFile(commandPath, JSON.stringify({ ...completedCommand, state: 'PENDING' }), 'utf8');
    vi.resetModules();
    freshGateway = (await import('../lib/commerce/gateway')).commerceGateway;
    await expect(
      freshGateway.renameAsset(key, '已整理.png', { ownerId, idempotencyKey: renameKey }),
    ).resolves.toEqual(renamed);
    await expect(
      freshGateway.renameAsset(key, '后续名称.png', {
        ownerId,
        idempotencyKey: laterRenameKey,
      }),
    ).resolves.toMatchObject({ name: '后续名称.png' });
    vi.resetModules();
    freshGateway = (await import('../lib/commerce/gateway')).commerceGateway;
    await expect(
      freshGateway.renameAsset(key, '已整理.png', { ownerId, idempotencyKey: renameKey }),
    ).resolves.toEqual(renamed);
    const afterOldReplay = (await freshGateway.listAssets({ query: '后续名称' }, { ownerId })) as {
      items: Array<{ id: string; name: string }>;
    };
    expect(afterOldReplay.items).toContainEqual(
      expect.objectContaining({ id: key, name: '后续名称.png' }),
    );
    const deleted = await freshGateway.deleteAsset(key, {
      ownerId,
      idempotencyKey: deleteKey,
    });
    vi.resetModules();
    freshGateway = (await import('../lib/commerce/gateway')).commerceGateway;
    await expect(
      freshGateway.deleteAsset(key, { ownerId, idempotencyKey: deleteKey }),
    ).resolves.toEqual(deleted);
    await expect(
      freshGateway.deleteAsset('0198f4d4-21c2-7b7d-8a03-08a0da2a7101', {
        ownerId,
        idempotencyKey: deleteKey,
      }),
    ).rejects.toMatchObject({
      message: 'IDEMPOTENCY_CONFLICT',
      outcome: 'DEFINITIVE_FAILURE',
    });
    const listed = (await freshGateway.listAssets({}, { ownerId })) as {
      items: Array<{ id: string }>;
    };
    expect(listed.items).not.toContainEqual(expect.objectContaining({ id: key }));
    const token = preview.url.split('/').at(-1) ?? '';
    const { GET: getMockAsset } = await import('../app/api/commerce/mock-assets/[token]/route');
    const afterDelete = await getMockAsset(new Request(`https://app.example${preview.url}`), {
      params: Promise.resolve({ token }),
    });
    expect(afterDelete.status).toBe(404);
  });
});
