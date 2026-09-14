/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-non-null-assertion -- focused in-memory seams deliberately resolve synchronously. */
import { describe, expect, it, vi } from 'vitest';
import type { ObjectStore } from '../src/ports/object-store.js';
import {
  ResultImportError,
  ResultImportService,
  type ResultImportRepository,
  type ResultDownloadTransport,
} from '../src/application/result-import.service.js';

const ownerId = '018f0a6a-8ac7-7d2c-8f4d-f234d61c5b7a';
const validInput = {
  ownerId,
  providerId: 'provider-a',
  authorizationId: '018f0a6a-8ac7-7d2c-8f4d-f234d61c5b71',
  providerTaskId: 'provider-task-42',
  sourceUrl: 'https://cdn.provider.cn/results/final.mp4',
  allowedHosts: ['cdn.provider.cn'],
  expectedMimeType: 'video/mp4',
  expectedSizeBytes: 200n,
  expectedChecksum: 'sha256:expected',
  originalFileName: 'final.mp4',
};

class MemoryStore implements Pick<ObjectStore, 'head' | 'delete'> {
  readonly head = vi.fn<ObjectStore['head']>(() =>
    Promise.resolve({ contentType: 'video/mp4', sizeBytes: 200n, checksum: 'sha256:expected' }),
  );
  readonly delete = vi.fn<ObjectStore['delete']>(() => Promise.resolve());
  readonly readPrefix = vi.fn(() =>
    Promise.resolve(Uint8Array.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70])),
  );
}

class MemoryRepository implements ResultImportRepository {
  readonly imported = new Map<string, { assetId: string; objectKey: string }>();
  readonly reserved = new Set<string>();
  readonly cleanups: string[] = [];
  readonly failed: Array<{
    idempotencyKey: string;
    claimToken: string;
    failedAt: Date;
    error: string;
  }> = [];
  busy = false;
  failureTransactionUnavailable = false;
  readonly persistImported = vi.fn<ResultImportRepository['persistImported']>(async (input) => {
    const existing = this.imported.get(input.idempotencyKey);
    if (existing !== undefined) return { kind: 'duplicate', ...existing } as const;
    const asset = { assetId: input.asset.assetId, objectKey: input.asset.objectKey };
    this.imported.set(input.idempotencyKey, asset);
    return { kind: 'created', eventId: 'outbox-1' } as const;
  });
  findImported(idempotencyKey: string) {
    const asset = this.imported.get(idempotencyKey);
    return Promise.resolve(asset === undefined ? null : { ...asset, status: 'AVAILABLE' as const });
  }
  reserveImport(input: { idempotencyKey: string }) {
    const existing = this.imported.get(input.idempotencyKey);
    if (existing !== undefined || this.reserved.has(input.idempotencyKey)) {
      const imported = existing ?? { assetId: 'in-flight', objectKey: 'in-flight' };
      return Promise.resolve(
        this.busy ? { kind: 'busy' as const } : { kind: 'duplicate' as const, ...imported },
      );
    }
    this.reserved.add(input.idempotencyKey);
    return Promise.resolve({ kind: 'claimed' as const, claimToken: 'claim-1' });
  }
  failAndScheduleCleanup(input: {
    idempotencyKey: string;
    claimToken: string;
    failedAt: Date;
    error: string;
    objectKey: string;
  }) {
    if (this.failureTransactionUnavailable) return Promise.reject(new Error('database offline'));
    this.failed.push(input);
    this.cleanups.push(input.objectKey);
    return Promise.resolve();
  }
  scheduleCleanup(input: { objectKey: string }) {
    this.cleanups.push(input.objectKey);
    return Promise.resolve();
  }
}

function makeTransport(): ResultDownloadTransport & { copy: ReturnType<typeof vi.fn> } {
  return {
    copy: vi.fn(async () => ({
      contentType: 'video/mp4',
      sizeBytes: 200n,
      checksum: 'sha256:expected',
    })),
  } as unknown as ResultDownloadTransport & { copy: ReturnType<typeof vi.fn> };
}

function makeService(metrics?: {
  importCompleted(bytes: number): void;
  importFailed(reason: 'network' | 'policy' | 'checksum' | 'storage' | 'unknown'): void;
}) {
  const store = new MemoryStore();
  const repository = new MemoryRepository();
  const transport = makeTransport();
  const events = { dispatch: vi.fn(async () => undefined) };
  return {
    store,
    repository,
    transport,
    events,
    service: new ResultImportService({
      objectStore: store as unknown as ObjectStore,
      repository,
      transport,
      events,
      idGenerator: () => '018f0a6a-8ac7-7d2c-8f4d-f234d61c5b70',
      ...(metrics === undefined ? {} : { metrics }),
    }),
  };
}

describe('result import', () => {
  it('rejects a result URL outside provider allowlists', async () => {
    const { service } = makeService();
    await expect(
      service.import({
        ...validInput,
        sourceUrl: 'http://169.254.169.254/latest/meta-data',
        allowedHosts: ['cdn.provider.cn'],
      }),
    ).rejects.toMatchObject({ code: 'RESULT_URL_NOT_ALLOWED' });
  });

  it('publishes imported only after the destination is verified', async () => {
    const { service, store, events } = makeService();
    await service.import(validInput);
    expect(store.head.mock.invocationCallOrder[0]!).toBeLessThan(
      events.dispatch.mock.invocationCallOrder[0]!,
    );
  });

  it('records copied bytes and bounded failure reasons on the business path', async () => {
    const metrics = { importCompleted: vi.fn(), importFailed: vi.fn() };
    const success = makeService(metrics);
    await success.service.import(validInput);
    expect(metrics.importCompleted).toHaveBeenCalledWith(200);

    const failure = makeService(metrics);
    failure.transport.copy.mockRejectedValueOnce(
      new ResultImportError('RESULT_URL_PRIVATE_ADDRESS', 'blocked'),
    );
    await expect(failure.service.import(validInput)).rejects.toBeInstanceOf(ResultImportError);
    expect(metrics.importFailed).toHaveBeenCalledWith('policy');
  });

  it.each([
    'http://cdn.provider.cn/video.mp4',
    'https://user:secret@cdn.provider.cn/video.mp4',
    'https://cdn.provider.cn/video.mp4#fragment',
    'https://cdn.provider.cn.evil.example/video.mp4',
  ])('rejects unsafe result URL %s', async (sourceUrl) => {
    const { service } = makeService();
    await expect(service.import({ ...validInput, sourceUrl })).rejects.toBeInstanceOf(
      ResultImportError,
    );
  });

  it('uses normalized exact host matching for IDN and trailing dots', async () => {
    const { service, transport } = makeService();
    await service.import({
      ...validInput,
      sourceUrl: 'https://XN--BCHER-KVA.example./video.mp4',
      allowedHosts: ['bücher.example'],
    });
    expect(transport.copy).toHaveBeenCalledOnce();
  });

  it.each(['127.0.0.1', '169.254.169.254', '10.0.0.1', '::1', 'fe80::1', '::'])(
    'rejects private DNS answer %s',
    async () => {
      const { service, transport } = makeService();
      transport.copy.mockRejectedValueOnce(
        new ResultImportError('RESULT_URL_PRIVATE_ADDRESS', 'blocked'),
      );
      await expect(service.import(validInput)).rejects.toMatchObject({
        code: 'RESULT_URL_PRIVATE_ADDRESS',
      });
    },
  );

  it.each(['redirect-limit', 'redirect-disallowed', 'redirect-private'])(
    'rejects unsafe redirects: %s',
    async (reason) => {
      const { service, transport } = makeService();
      transport.copy.mockRejectedValueOnce(
        new ResultImportError('RESULT_REDIRECT_NOT_ALLOWED', reason),
      );
      await expect(service.import(validInput)).rejects.toMatchObject({
        code: 'RESULT_REDIRECT_NOT_ALLOWED',
      });
    },
  );

  it.each([
    { contentType: 'image/png', sizeBytes: 200n, checksum: 'sha256:expected' },
    { contentType: 'video/mp4', sizeBytes: 201n, checksum: 'sha256:expected' },
    { contentType: 'video/mp4', sizeBytes: 200n, checksum: 'sha256:other' },
  ])('rejects a copied type, size, or checksum mismatch', async (copied) => {
    const { service, transport, repository } = makeService();
    transport.copy.mockResolvedValueOnce(copied);
    await expect(service.import(validInput)).rejects.toMatchObject({
      code: 'RESULT_INTEGRITY_MISMATCH',
    });
    expect(repository.cleanups).toHaveLength(1);
  });

  it('does not copy or publish a duplicate import replay', async () => {
    const { service, transport, events } = makeService();
    const first = await service.import(validInput);
    const replay = await service.import(validInput);
    expect(replay).toEqual(first);
    expect(transport.copy).toHaveBeenCalledOnce();
    expect(events.dispatch).toHaveBeenCalledOnce();
  });

  it('scopes idempotency by verified provider and server authorization record', async () => {
    const { service, transport, repository } = makeService();
    const first = await service.import(validInput);
    const second = await service.import({
      ...validInput,
      providerId: 'provider-b',
      authorizationId: '018f0a6a-8ac7-7d2c-8f4d-f234d61c5b72',
    });
    expect(second).toEqual(first);
    expect(repository.imported).toHaveLength(2);
    expect(transport.copy).toHaveBeenCalledTimes(2);
  });

  it('does not copy while another live reservation owns the import', async () => {
    const { service, repository, transport } = makeService();
    repository.reserved.add(
      `${validInput.providerId}:${validInput.authorizationId}:${ownerId}:${validInput.providerTaskId}`,
    );
    repository.busy = true;
    await expect(service.import(validInput)).rejects.toMatchObject({
      code: 'RESULT_IMPORT_FAILED',
    });
    expect(transport.copy).not.toHaveBeenCalled();
  });

  it('marks a failed reservation retryable and retains its private object for seven-day cleanup', async () => {
    const { service, repository, transport } = makeService();
    transport.copy.mockRejectedValueOnce(new Error('provider disconnected'));
    await expect(service.import(validInput)).rejects.toMatchObject({
      code: 'RESULT_IMPORT_FAILED',
    });
    expect(repository.failed).toEqual([
      expect.objectContaining({
        idempotencyKey: `${validInput.providerId}:${validInput.authorizationId}:${ownerId}:${validInput.providerTaskId}`,
        claimToken: 'claim-1',
        error: 'RESULT_IMPORT_FAILED',
      }),
    ]);
    expect(repository.cleanups).toHaveLength(1);
  });

  it('attempts immediate object deletion if atomic failure persistence is unavailable', async () => {
    const { service, repository, transport, store } = makeService();
    repository.failureTransactionUnavailable = true;
    transport.copy.mockRejectedValueOnce(new Error('provider disconnected'));
    await expect(service.import(validInput)).rejects.toMatchObject({
      code: 'RESULT_IMPORT_FAILED',
    });
    expect(store.delete).toHaveBeenCalledWith(
      `results/${ownerId}/018f0a6a-8ac7-7d2c-8f4d-f234d61c5b70`,
    );
  });

  it('schedules the losing destination when persistence discovers a duplicate race', async () => {
    const { service, repository } = makeService();
    repository.persistImported.mockResolvedValueOnce({
      kind: 'duplicate',
      assetId: 'winner',
      objectKey: 'results/winner',
      status: 'AVAILABLE',
    });
    await expect(service.import(validInput)).resolves.toMatchObject({ assetId: 'winner' });
    expect(repository.cleanups).toEqual([
      `results/${ownerId}/018f0a6a-8ac7-7d2c-8f4d-f234d61c5b70`,
    ]);
    expect(repository.failed).toEqual([]);
  });

  it('does not overwrite the immediate cleanup signal emitted by a stale persist token', async () => {
    const { service, repository } = makeService();
    repository.persistImported.mockResolvedValueOnce({ kind: 'stale' });
    await expect(service.import(validInput)).rejects.toMatchObject({
      code: 'RESULT_IMPORT_FAILED',
    });
    expect(repository.failed).toEqual([]);
  });

  it('rejects an MZ executable disguised as a video result', async () => {
    const { service, store } = makeService();
    store.readPrefix.mockResolvedValueOnce(Uint8Array.from([0x4d, 0x5a, 0x90, 0x00]));
    await expect(service.import(validInput)).rejects.toMatchObject({
      code: 'RESULT_INTEGRITY_MISMATCH',
    });
  });
});
