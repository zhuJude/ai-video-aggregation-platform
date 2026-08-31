import { describe, expect, it, vi } from 'vitest';
import {
  UploadSessionError,
  UploadSessionService,
  type AssetRecord,
  type UploadSessionRecord,
  type UploadSessionRepository,
} from '../src/application/upload-session.service.js';
import {
  AliyunOssObjectStore,
  type AliyunOssObjectStoreConfig,
} from '../src/adapters/aliyun-oss.object-store.js';
import OSS from 'ali-oss';
import type { ObjectStore } from '../src/ports/object-store.js';

const ownerId = '018f0a6a-8ac7-7d2c-8f4d-f234d61c5b7a';
const otherOwnerId = '018f0a6a-8ac7-7d2c-8f4d-f234d61c5b7b';

class MemoryRepository implements UploadSessionRepository {
  readonly sessions = new Map<string, UploadSessionRecord>();
  readonly assets = new Map<string, AssetRecord>();
  readonly deletionRecords: Array<{ assetId: string; objectKey: string }> = [];

  createPending(input: { session: UploadSessionRecord; asset: AssetRecord }): Promise<void> {
    this.sessions.set(input.session.id, { ...input.session });
    this.assets.set(input.asset.id, { ...input.asset });
    return Promise.resolve();
  }

  findSession(sessionId: string): Promise<UploadSessionRecord | null> {
    return Promise.resolve(this.sessions.get(sessionId) ?? null);
  }

  claimExpired(sessionId: string, queriedOwnerId: string, expiredAt: Date): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (
      session === undefined ||
      session.ownerId !== queriedOwnerId ||
      session.status !== 'PENDING' ||
      session.expiresAt > expiredAt
    ) {
      return Promise.resolve(false);
    }
    session.status = 'EXPIRED';
    const asset = this.assets.get(session.assetId);
    if (asset !== undefined) asset.status = 'DELETING';
    return Promise.resolve(true);
  }

  rejectPending(sessionId: string, queriedOwnerId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (session === undefined || session.ownerId !== queriedOwnerId || session.status !== 'PENDING') {
      return Promise.resolve(false);
    }
    session.status = 'REJECTED';
    const asset = this.assets.get(session.assetId);
    if (asset !== undefined) {
      asset.status = 'DELETING';
      this.deletionRecords.push({ assetId: asset.id, objectKey: asset.objectKey });
    }
    return Promise.resolve(true);
  }

  completePending(input: {
    sessionId: string;
    ownerId: string;
    completedAt: Date;
    checksum?: string;
  }): Promise<AssetRecord | null> {
    const session = this.sessions.get(input.sessionId);
    if (
      session === undefined ||
      session.ownerId !== input.ownerId ||
      session.status !== 'PENDING'
    ) {
      return Promise.resolve(null);
    }
    const asset = this.assets.get(session.assetId);
    if (asset === undefined) return Promise.resolve(null);
    session.status = 'COMPLETED';
    session.completedAt = input.completedAt;
    asset.status = 'AVAILABLE';
    if (input.checksum !== undefined) asset.checksum = input.checksum;
    return Promise.resolve({ ...asset });
  }

  findAvailableAsset(assetId: string, queriedOwnerId: string): Promise<AssetRecord | null> {
    const asset = this.assets.get(assetId);
    return Promise.resolve(
      asset !== undefined && asset.ownerId === queriedOwnerId && asset.status === 'AVAILABLE'
        ? { ...asset }
        : null,
    );
  }
}

class ExpiryRaceRepository extends MemoryRepository {
  override claimExpired(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

class ValidationRaceRepository extends MemoryRepository {
  override rejectPending(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

interface TestObjectStore extends ObjectStore {
  createUploadSpy: ReturnType<typeof vi.fn<ObjectStore['createUpload']>>;
  headSpy: ReturnType<typeof vi.fn<ObjectStore['head']>>;
  createDownloadSpy: ReturnType<typeof vi.fn<ObjectStore['createDownload']>>;
  deleteSpy: ReturnType<typeof vi.fn<ObjectStore['delete']>>;
  readPrefixSpy: ReturnType<typeof vi.fn<(objectKey: string, maxBytes: number) => Promise<Uint8Array>>>;
}

function makeObjectStore(): TestObjectStore {
  const createUpload = vi.fn<ObjectStore['createUpload']>((input) =>
    Promise.resolve({
      url: `https://private-bucket.oss.example/${input.objectKey}`,
      headers: { 'content-type': 'image/png' },
    }),
  );
  const head = vi.fn<ObjectStore['head']>(() =>
    Promise.resolve({ contentType: 'image/png', sizeBytes: 200n }),
  );
  const createDownload = vi.fn<ObjectStore['createDownload']>((objectKey) =>
    Promise.resolve(`https://cdn.example/${objectKey}?token=signed`),
  );
  const deleteObject = vi.fn<ObjectStore['delete']>(() => Promise.resolve());
  const readPrefix = vi.fn<(objectKey: string, maxBytes: number) => Promise<Uint8Array>>(() =>
    Promise.resolve(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  );
  return {
    createUpload,
    head,
    createDownload,
    delete: deleteObject,
    readPrefix,
    copyFromUrl: vi.fn(() =>
      Promise.resolve({
        contentType: 'image/png',
        sizeBytes: 200n,
        checksum: 'sha256:example',
      }),
    ),
    createUploadSpy: createUpload,
    headSpy: head,
    createDownloadSpy: createDownload,
    deleteSpy: deleteObject,
    readPrefixSpy: readPrefix,
  };
}

function makeService(objectStore = makeObjectStore(), now = new Date('2026-08-31T00:00:00.000Z')) {
  const repository = new MemoryRepository();
  return {
    objectStore,
    repository,
    service: new UploadSessionService({
      objectStore,
      repository,
      now: () => now,
      policy: {
        allowedMimeTypes: {
          'image/png': 5_000_000n,
          'image/jpeg': 5_000_000n,
          'video/mp4': 100_000_000n,
        },
      },
    }),
  };
}

describe('secure upload sessions', () => {
  it('rejects stored MZ bytes even when the caller claims a PNG signature', async () => {
    const { service, objectStore } = makeService();
    objectStore.readPrefixSpy.mockResolvedValue(Uint8Array.from([0x4d, 0x5a, 0x90, 0x00]));
    const session = await service.create({
      ownerId,
      kind: 'UPLOAD',
      fileName: 'avatar.png',
      mimeType: 'image/png',
      sizeBytes: 200n,
    });

    await expect(
      service.complete(session.sessionId, {
        ownerId,
        objectKey: session.objectKey,
        mimeType: 'image/png',
        magic: '89504e470d0a1a0a',
        sizeBytes: 200n,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_FILE_SIGNATURE' });
  });

  it('persists a terminal rejection and deletion record for a trusted stored-signature failure', async () => {
    const objectStore = makeObjectStore();
    objectStore.readPrefixSpy.mockResolvedValue(Uint8Array.from([0x4d, 0x5a, 0x90, 0x00]));
    const repository = new MemoryRepository();
    const service = new UploadSessionService({
      objectStore,
      repository: repository as unknown as UploadSessionRepository,
      policy: { allowedMimeTypes: { 'image/png': 5_000_000n } },
    });
    const session = await service.create({
      ownerId,
      kind: 'UPLOAD',
      fileName: 'avatar.png',
      mimeType: 'image/png',
      sizeBytes: 200n,
    });
    const input = { ownerId, objectKey: session.objectKey, mimeType: 'image/png', sizeBytes: 200n };

    await expect(service.complete(session.sessionId, input)).rejects.toMatchObject({
      code: 'INVALID_FILE_SIGNATURE',
    });
    expect(repository.sessions.get(session.sessionId)?.status).toBe('REJECTED');
    expect(repository.assets.get(session.assetId)?.status).toBe('DELETING');
    expect(repository.deletionRecords).toEqual([{ assetId: session.assetId, objectKey: session.objectKey }]);
    await expect(service.complete(session.sessionId, input)).rejects.toMatchObject({
      code: 'UPLOAD_SESSION_ALREADY_USED',
    });
  });

  it('does not delete an object when concurrent completion wins a validation rejection', async () => {
    const objectStore = makeObjectStore();
    objectStore.readPrefixSpy.mockResolvedValue(Uint8Array.from([0x4d, 0x5a, 0x90, 0x00]));
    const repository = new ValidationRaceRepository();
    const service = new UploadSessionService({
      objectStore,
      repository: repository as unknown as UploadSessionRepository,
      policy: { allowedMimeTypes: { 'image/png': 5_000_000n } },
    });
    const session = await service.create({
      ownerId,
      kind: 'UPLOAD',
      fileName: 'avatar.png',
      mimeType: 'image/png',
      sizeBytes: 200n,
    });

    await expect(
      service.complete(session.sessionId, {
        ownerId,
        objectKey: session.objectKey,
        mimeType: 'image/png',
        sizeBytes: 200n,
      }),
    ).rejects.toMatchObject({ code: 'UPLOAD_SESSION_ALREADY_USED' });
    expect(objectStore.deleteSpy).not.toHaveBeenCalled();
  });

  it('accepts stored PNG bytes even when the caller supplies unrelated magic', async () => {
    const { service, objectStore } = makeService();
    objectStore.readPrefixSpy.mockResolvedValue(
      Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
    );
    const session = await service.create({
      ownerId,
      kind: 'UPLOAD',
      fileName: 'avatar.png',
      mimeType: 'image/png',
      sizeBytes: 200n,
    });

    await expect(
      service.complete(session.sessionId, {
        ownerId,
        objectKey: session.objectKey,
        mimeType: 'image/png',
        magic: '4d5a',
        sizeBytes: 200n,
      }),
    ).resolves.toMatchObject({ status: 'AVAILABLE' });
    expect(objectStore.readPrefixSpy).toHaveBeenCalledWith(session.objectKey, 32);
  });

  it('uses a random owner-scoped key and keeps the original name as display metadata only', async () => {
    const { service } = makeService();

    const session = await service.create({
      ownerId,
      kind: 'UPLOAD',
      fileName: '../../secret.png',
      mimeType: 'image/png',
      sizeBytes: 200n,
    });

    expect(session.objectKey).toMatch(new RegExp(`^uploads/${ownerId}/[a-f0-9-]+$`));
    expect(session.objectKey).not.toContain('secret');
    expect(session.originalFileName).toBe('../../secret.png');
    expect(session.expiresAt.toISOString()).toBe('2026-08-31T00:15:00.000Z');
  });

  it('rejects unsupported MIME types and oversized declared files before issuing an upload', async () => {
    const { service, objectStore } = makeService();

    await expect(
      service.create({
        ownerId,
        kind: 'UPLOAD',
        fileName: 'payload.exe',
        mimeType: 'application/x-msdownload',
        sizeBytes: 200n,
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_MIME_TYPE' });
    await expect(
      service.create({
        ownerId,
        kind: 'UPLOAD',
        fileName: 'huge.png',
        mimeType: 'image/png',
        sizeBytes: 5_000_001n,
      }),
    ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    expect(objectStore.createUploadSpy).not.toHaveBeenCalled();
  });

  it('validates caller, issued key, declaration, and actual HEAD before one atomic completion', async () => {
    const objectStore = makeObjectStore();
    const repository = new MemoryRepository();
    const service = new UploadSessionService({
      objectStore,
      repository,
      now: () => new Date('2026-08-31T00:00:00.000Z'),
      policy: { allowedMimeTypes: { 'image/png': 5_000_000n } },
    });
    const session = await service.create({
      ownerId,
      kind: 'UPLOAD',
      fileName: 'avatar.png',
      mimeType: 'image/png',
      sizeBytes: 200n,
    });
    const valid = {
      ownerId,
      objectKey: session.objectKey,
      mimeType: 'image/png',
      magic: '89504e470d0a1a0a',
      sizeBytes: 200n,
    } as const;

    await expect(
      service.complete(session.sessionId, { ...valid, ownerId: otherOwnerId }),
    ).rejects.toMatchObject({
      code: 'UPLOAD_SESSION_NOT_FOUND',
    });
    await expect(
      service.complete(session.sessionId, { ...valid, objectKey: `uploads/${ownerId}/different` }),
    ).rejects.toMatchObject({
      code: 'OBJECT_KEY_MISMATCH',
    });
    await expect(service.complete(session.sessionId, valid)).resolves.toMatchObject({
      status: 'AVAILABLE',
      objectKey: session.objectKey,
      mimeType: 'image/png',
      sizeBytes: 200n,
    });
    await expect(service.complete(session.sessionId, valid)).rejects.toMatchObject({
      code: 'UPLOAD_SESSION_ALREADY_USED',
    });
  });

  it('claims expiry instead of completing when validation crosses the session deadline', async () => {
    let now = new Date('2026-08-31T00:00:00.000Z');
    const objectStore = makeObjectStore();
    objectStore.readPrefixSpy.mockImplementation(() => {
      now = new Date('2026-08-31T00:15:00.000Z');
      return Promise.resolve(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    });
    const repository = new MemoryRepository();
    const service = new UploadSessionService({
      objectStore,
      repository,
      now: () => now,
      policy: { allowedMimeTypes: { 'image/png': 5_000_000n } },
    });
    const session = await service.create({
      ownerId,
      kind: 'UPLOAD',
      fileName: 'avatar.png',
      mimeType: 'image/png',
      sizeBytes: 200n,
    });

    await expect(
      service.complete(session.sessionId, {
        ownerId,
        objectKey: session.objectKey,
        mimeType: 'image/png',
        sizeBytes: 200n,
      }),
    ).rejects.toMatchObject({ code: 'UPLOAD_SESSION_EXPIRED' });
    expect(repository.sessions.get(session.sessionId)?.status).toBe('EXPIRED');
    expect(objectStore.deleteSpy).toHaveBeenCalledWith(session.objectKey);
  });

  it('rejects expired sessions and deletes invalid uploaded objects', async () => {
    let now = new Date('2026-08-31T00:00:00.000Z');
    const objectStore = makeObjectStore();
    const repository = new MemoryRepository();
    const service = new UploadSessionService({
      objectStore,
      repository,
      now: () => now,
      policy: { allowedMimeTypes: { 'image/png': 5_000_000n } },
    });
    const session = await service.create({
      ownerId,
      kind: 'UPLOAD',
      fileName: 'avatar.png',
      mimeType: 'image/png',
      sizeBytes: 200n,
    });
    now = new Date('2026-08-31T00:15:00.001Z');

    await expect(
      service.complete(session.sessionId, {
        ownerId,
        objectKey: session.objectKey,
        mimeType: 'image/png',
        magic: '89504e470d0a1a0a',
        sizeBytes: 200n,
      }),
    ).rejects.toMatchObject({ code: 'UPLOAD_SESSION_EXPIRED' });
    expect(objectStore.deleteSpy).toHaveBeenCalledWith(session.objectKey);
  });

  it('does not delete an expired object when concurrent completion won the expiry claim', async () => {
    let now = new Date('2026-08-31T00:00:00.000Z');
    const objectStore = makeObjectStore();
    const repository = new ExpiryRaceRepository();
    const service = new UploadSessionService({
      objectStore,
      repository: repository as unknown as UploadSessionRepository,
      now: () => now,
      policy: { allowedMimeTypes: { 'image/png': 5_000_000n } },
    });
    const session = await service.create({
      ownerId,
      kind: 'UPLOAD',
      fileName: 'avatar.png',
      mimeType: 'image/png',
      sizeBytes: 200n,
    });
    now = new Date('2026-08-31T00:15:00.001Z');

    await expect(
      service.complete(session.sessionId, {
        ownerId,
        objectKey: session.objectKey,
        mimeType: 'image/png',
        sizeBytes: 200n,
      }),
    ).rejects.toMatchObject({ code: 'UPLOAD_SESSION_ALREADY_USED' });
    expect(objectStore.deleteSpy).not.toHaveBeenCalled();
  });

  it('rejects a HEAD size or type that differs from the issued policy', async () => {
    const objectStore = makeObjectStore();
    objectStore.headSpy.mockResolvedValue({ contentType: 'image/jpeg', sizeBytes: 201n });
    const repository = new MemoryRepository();
    const service = new UploadSessionService({
      objectStore,
      repository,
      policy: { allowedMimeTypes: { 'image/png': 5_000_000n } },
    });
    const session = await service.create({
      ownerId,
      kind: 'UPLOAD',
      fileName: 'avatar.png',
      mimeType: 'image/png',
      sizeBytes: 200n,
    });

    await expect(
      service.complete(session.sessionId, {
        ownerId,
        objectKey: session.objectKey,
        mimeType: 'image/png',
        magic: '89504e470d0a1a0a',
        sizeBytes: 200n,
      }),
    ).rejects.toBeInstanceOf(UploadSessionError);
    expect(objectStore.deleteSpy).toHaveBeenCalledWith(session.objectKey);
  });

  it('returns only a temporary signed download URL for an owned available asset', async () => {
    const { service, objectStore } = makeService();
    const session = await service.create({
      ownerId,
      kind: 'UPLOAD',
      fileName: 'avatar.png',
      mimeType: 'image/png',
      sizeBytes: 200n,
    });
    const asset = await service.complete(session.sessionId, {
      ownerId,
      objectKey: session.objectKey,
      mimeType: 'image/png',
      magic: '89504e470d0a1a0a',
      sizeBytes: 200n,
    });

    await expect(service.createDownload(ownerId, asset.assetId, 120)).resolves.toBe(
      `https://cdn.example/${session.objectKey}?token=signed`,
    );
    expect(objectStore.createDownloadSpy).toHaveBeenCalledWith(session.objectKey, 120);
    await expect(service.createDownload(otherOwnerId, asset.assetId, 120)).rejects.toMatchObject({
      code: 'ASSET_NOT_FOUND',
    });
  });
});

describe('Aliyun OSS secure configuration', () => {
  const baseConfig: AliyunOssObjectStoreConfig = {
    environment: 'production',
    region: 'oss-cn-shanghai',
    bucket: 'private-assets',
    bucketAcl: 'private',
    ramRoleArn: 'acs:ram::123456789:role/asset-service',
    kmsKeyReference: 'acs:kms:cn-shanghai:123456789:key/example',
    cdnBaseUrl: 'https://assets.example.com',
    cdnAuthKeyReference: 'kms://asset-cdn-auth-key',
    cdnAuthValiditySeconds: 120,
    credentialProvider: () =>
      Promise.resolve({
        accessKeyId: 'ephemeral-sts-id',
        accessKeySecret: 'ephemeral-sts-secret',
        securityToken: 'ephemeral-sts-token',
      }),
    secretResolver: () => Promise.resolve('Abcdef123456'),
  };

  it('rejects public-read ACL outside local development', () => {
    expect(() => new AliyunOssObjectStore({ ...baseConfig, bucketAcl: 'public-read' })).toThrow(
      /public-read/i,
    );
  });

  it('requires RAM role and KMS references instead of literal long-lived credentials', () => {
    expect(() => new AliyunOssObjectStore({ ...baseConfig, ramRoleArn: '' })).toThrow(/RAM role/i);
    expect(() => new AliyunOssObjectStore({ ...baseConfig, kmsKeyReference: '' })).toThrow(/KMS/i);
  });

  it('rejects a literal CDN signing secret in place of an approved KMS reference', () => {
    expect(
      () => new AliyunOssObjectStore({ ...baseConfig, cdnAuthKeyReference: 'Abcdef123456' }),
    ).toThrow(/CDN authentication KMS reference/i);
  });

  it('binds POST uploads to OSS forbid-overwrite semantics', async () => {
    const calculatePostSignature = vi.spyOn(OSS.prototype, 'calculatePostSignature').mockReturnValue({
      OSSAccessKeyId: 'temporary-access-key',
      Signature: 'signature',
      policy: 'policy',
    });
    const store = new AliyunOssObjectStore(baseConfig);

    const upload = await store.createUpload({
      objectKey: 'uploads/object-id',
      contentType: 'image/png',
      maxBytes: 200n,
      expiresInSeconds: 60,
    });

    const policy = calculatePostSignature.mock.calls[0]?.[0] as
      | { conditions: unknown[] }
      | undefined;
    if (policy === undefined) throw new Error('Expected createUpload to sign a POST policy');
    expect(policy.conditions).toContainEqual(['eq', '$x-oss-forbid-overwrite', 'true']);
    expect(upload.headers).toMatchObject({ 'x-oss-forbid-overwrite': 'true' });
    calculatePostSignature.mockRestore();
  });

  it('reads only a bounded object prefix through an OSS Range GET', async () => {
    const get = vi.spyOn(OSS.prototype, 'get').mockResolvedValue({
      res: { headers: { 'content-range': 'bytes 0-7/200' } },
      content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    });
    const store = new AliyunOssObjectStore(baseConfig);

    await expect(store.readPrefix('uploads/object-id', 8)).resolves.toEqual(
      Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(get).toHaveBeenCalledWith('uploads/object-id', { headers: { Range: 'bytes=0-7' } });
    get.mockRestore();
  });

  it('does not label an OSS ETag as an integrity checksum', async () => {
    const head = vi.spyOn(OSS.prototype, 'head').mockResolvedValue({
      res: {
        headers: {
          'content-type': 'image/png',
          'content-length': '200',
          etag: 'multipart-etag',
        },
      },
    });
    const store = new AliyunOssObjectStore(baseConfig);

    await expect(store.head('uploads/object-id')).resolves.toEqual({
      contentType: 'image/png',
      sizeBytes: 200n,
    });
    head.mockRestore();
  });

  it('signs CDN Type-A URLs with the current timestamp because CDN applies its own TTL', async () => {
    const store = new AliyunOssObjectStore({
      ...baseConfig,
      now: () => new Date('2026-08-31T00:00:00.000Z'),
      secretResolver: () => Promise.resolve('Abcdef123456'),
    });

    await expect(store.createDownload('uploads/object-id', 120)).resolves.toBe(
      'https://assets.example.com/uploads/object-id?auth_key=1788134400-0-0-687f2724b4a54e0c6679e899f140553f',
    );
  });

  it('rejects a requested CDN lifetime shorter than the configured CDN Type-A TTL', async () => {
    const store = new AliyunOssObjectStore(baseConfig);
    await expect(store.createDownload('uploads/object-id', 119)).rejects.toThrow(/configured CDN TTL/i);
  });

  it('rejects a requested CDN lifetime longer than its fixed Type-A TTL', async () => {
    const store = new AliyunOssObjectStore(baseConfig);
    await expect(store.createDownload('uploads/object-id', 121)).rejects.toThrow(/equal/i);
  });
});
