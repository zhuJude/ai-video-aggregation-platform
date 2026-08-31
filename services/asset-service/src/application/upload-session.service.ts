import { randomUUID } from 'node:crypto';
import type { ObjectStore } from '../ports/object-store.js';

const SESSION_TTL_SECONDS = 15 * 60;
const MAX_DOWNLOAD_TTL_SECONDS = 15 * 60;
const FILE_SIGNATURE_PREFIX_BYTES = 32;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type AssetKind = 'UPLOAD' | 'RESULT' | 'THUMBNAIL';
export type UploadSessionStatus = 'PENDING' | 'COMPLETED' | 'EXPIRED' | 'REJECTED';

export interface UploadSessionRecord {
  id: string;
  ownerId: string;
  assetId: string;
  kind: AssetKind;
  objectKey: string;
  originalFileName: string;
  expectedMimeType: string;
  expectedSizeBytes: bigint;
  status: UploadSessionStatus;
  expiresAt: Date;
  completedAt?: Date;
}

export interface AssetRecord {
  id: string;
  ownerId: string;
  kind: AssetKind;
  objectKey: string;
  originalFileName: string;
  mimeType: string;
  sizeBytes: bigint;
  checksum?: string;
  status: 'PENDING' | 'AVAILABLE' | 'DELETING';
}

export interface UploadSessionRepository {
  createPending(input: { session: UploadSessionRecord; asset: AssetRecord }): Promise<void>;
  findSession(sessionId: string): Promise<UploadSessionRecord | null>;
  claimExpired(sessionId: string, ownerId: string, expiredAt: Date): Promise<boolean>;
  rejectPending(sessionId: string, ownerId: string, rejectedAt: Date): Promise<boolean>;
  completePending(input: {
    sessionId: string;
    ownerId: string;
    completedAt: Date;
    checksum?: string;
  }): Promise<AssetRecord | null>;
  findAvailableAsset(assetId: string, ownerId: string): Promise<AssetRecord | null>;
}

export type UploadSessionErrorCode =
  | 'INVALID_OWNER_ID'
  | 'INVALID_ASSET_KIND'
  | 'INVALID_FILE_NAME'
  | 'INVALID_FILE_SIZE'
  | 'UNSUPPORTED_MIME_TYPE'
  | 'FILE_TOO_LARGE'
  | 'UPLOAD_SESSION_NOT_FOUND'
  | 'UPLOAD_SESSION_ALREADY_USED'
  | 'UPLOAD_SESSION_EXPIRED'
  | 'OBJECT_KEY_MISMATCH'
  | 'DECLARED_MIME_TYPE_MISMATCH'
  | 'DECLARED_SIZE_MISMATCH'
  | 'INVALID_FILE_SIGNATURE'
  | 'OBJECT_MIME_TYPE_MISMATCH'
  | 'OBJECT_SIZE_MISMATCH'
  | 'ASSET_NOT_FOUND'
  | 'INVALID_DOWNLOAD_EXPIRATION';

export class UploadSessionError extends Error {
  readonly code: UploadSessionErrorCode;

  constructor(code: UploadSessionErrorCode, message: string) {
    super(message);
    this.name = 'UploadSessionError';
    this.code = code;
  }
}

export interface UploadPolicy {
  allowedMimeTypes: Readonly<Record<string, bigint>>;
}

export interface UploadSessionServiceDependencies {
  objectStore: ObjectStore;
  repository: UploadSessionRepository;
  policy: UploadPolicy;
  now?: () => Date;
  idGenerator?: () => string;
}

export interface CreateUploadSessionInput {
  ownerId: string;
  kind: AssetKind;
  fileName: string;
  mimeType: string;
  sizeBytes: bigint;
}

export interface CompleteUploadSessionInput {
  ownerId: string;
  objectKey: string;
  mimeType: string;
  /** @deprecated File signatures are validated from the stored object prefix. */
  magic?: string;
  sizeBytes: bigint;
}

export class UploadSessionService {
  readonly #objectStore: ObjectStore;
  readonly #repository: UploadSessionRepository;
  readonly #policy: UploadPolicy;
  readonly #now: () => Date;
  readonly #idGenerator: () => string;

  constructor(dependencies: UploadSessionServiceDependencies) {
    this.#objectStore = dependencies.objectStore;
    this.#repository = dependencies.repository;
    this.#policy = dependencies.policy;
    this.#now = dependencies.now ?? (() => new Date());
    this.#idGenerator = dependencies.idGenerator ?? randomUUID;
  }

  async create(input: CreateUploadSessionInput): Promise<{
    sessionId: string;
    assetId: string;
    objectKey: string;
    originalFileName: string;
    expiresAt: Date;
    uploadUrl: string;
    uploadHeaders: Record<string, string>;
  }> {
    this.#validateCreateInput(input);

    const now = this.#now();
    const sessionId = this.#idGenerator();
    const assetId = this.#idGenerator();
    const objectKey = `uploads/${input.ownerId}/${this.#idGenerator()}`;
    const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1_000);
    const upload = await this.#objectStore.createUpload({
      objectKey,
      contentType: input.mimeType,
      maxBytes: input.sizeBytes,
      expiresInSeconds: SESSION_TTL_SECONDS,
    });
    const asset: AssetRecord = {
      id: assetId,
      ownerId: input.ownerId,
      kind: input.kind,
      objectKey,
      originalFileName: input.fileName,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      status: 'PENDING',
    };
    const session: UploadSessionRecord = {
      id: sessionId,
      ownerId: input.ownerId,
      assetId,
      kind: input.kind,
      objectKey,
      originalFileName: input.fileName,
      expectedMimeType: input.mimeType,
      expectedSizeBytes: input.sizeBytes,
      status: 'PENDING',
      expiresAt,
    };
    await this.#repository.createPending({ session, asset });

    return {
      sessionId,
      assetId,
      objectKey,
      originalFileName: input.fileName,
      expiresAt,
      uploadUrl: upload.url,
      uploadHeaders: upload.headers,
    };
  }

  async complete(
    sessionId: string,
    input: CompleteUploadSessionInput,
  ): Promise<{
    assetId: string;
    objectKey: string;
    mimeType: string;
    sizeBytes: bigint;
    status: 'AVAILABLE';
  }> {
    const session = await this.#repository.findSession(sessionId);
    if (session === null || session.ownerId !== input.ownerId) {
      throw new UploadSessionError('UPLOAD_SESSION_NOT_FOUND', 'Upload session was not found');
    }
    if (session.status === 'COMPLETED') {
      throw new UploadSessionError(
        'UPLOAD_SESSION_ALREADY_USED',
        'Upload session has already been completed',
      );
    }
    if (session.status === 'EXPIRED') {
      throw new UploadSessionError('UPLOAD_SESSION_EXPIRED', 'Upload session has expired');
    }
    if (session.status === 'REJECTED') {
      throw new UploadSessionError('UPLOAD_SESSION_ALREADY_USED', 'Upload session has been rejected');
    }
    this.#assertIssuedObjectKey(session, input.objectKey);

    const now = this.#now();
    if (session.expiresAt.getTime() <= now.getTime()) {
      const claimed = await this.#repository.claimExpired(session.id, session.ownerId, now);
      if (!claimed) {
        throw new UploadSessionError(
          'UPLOAD_SESSION_ALREADY_USED',
          'Upload session was completed by another request',
        );
      }
      await this.#deleteInvalidObject(session.objectKey);
      throw new UploadSessionError('UPLOAD_SESSION_EXPIRED', 'Upload session has expired');
    }

    try {
      this.#validateCompletionDeclaration(session, input);
      const actual = await this.#objectStore.head(session.objectKey);
      if (normalizeContentType(actual.contentType) !== session.expectedMimeType) {
        throw new UploadSessionError(
          'OBJECT_MIME_TYPE_MISMATCH',
          'Stored object content type does not match the issued upload policy',
        );
      }
      if (actual.sizeBytes !== session.expectedSizeBytes) {
        throw new UploadSessionError(
          'OBJECT_SIZE_MISMATCH',
          'Stored object size does not match the issued upload policy',
        );
      }
      const prefix = await this.#objectStore.readPrefix(
        session.objectKey,
        FILE_SIGNATURE_PREFIX_BYTES,
      );
      if (!matchesMagic(session.expectedMimeType, prefix)) {
        throw new UploadSessionError(
          'INVALID_FILE_SIGNATURE',
          'Stored object signature does not match the issued MIME type',
        );
      }

      const completedAt = this.#now();
      if (session.expiresAt.getTime() <= completedAt.getTime()) {
        const claimed = await this.#repository.claimExpired(session.id, session.ownerId, completedAt);
        if (!claimed) {
          throw new UploadSessionError(
            'UPLOAD_SESSION_ALREADY_USED',
            'Upload session was completed by another request',
          );
        }
        await this.#deleteInvalidObject(session.objectKey);
        throw new UploadSessionError('UPLOAD_SESSION_EXPIRED', 'Upload session has expired');
      }

      const asset = await this.#repository.completePending({
        sessionId: session.id,
        ownerId: session.ownerId,
        completedAt,
        ...(actual.checksum === undefined ? {} : { checksum: actual.checksum }),
      });
      if (asset === null) {
        throw new UploadSessionError(
          'UPLOAD_SESSION_ALREADY_USED',
          'Upload session was completed by another request',
        );
      }
      return {
        assetId: asset.id,
        objectKey: asset.objectKey,
        mimeType: asset.mimeType,
        sizeBytes: asset.sizeBytes,
        status: 'AVAILABLE',
      };
    } catch (error) {
      if (isTerminalValidationFailure(error)) {
        const claimed = await this.#repository.rejectPending(session.id, session.ownerId, now);
        if (!claimed) {
          throw new UploadSessionError(
            'UPLOAD_SESSION_ALREADY_USED',
            'Upload session was completed by another request',
          );
        }
        await this.#deleteInvalidObject(session.objectKey);
      }
      throw error;
    }
  }

  async createDownload(
    ownerId: string,
    assetId: string,
    expiresInSeconds: number,
  ): Promise<string> {
    if (
      !Number.isInteger(expiresInSeconds) ||
      expiresInSeconds < 1 ||
      expiresInSeconds > MAX_DOWNLOAD_TTL_SECONDS
    ) {
      throw new UploadSessionError(
        'INVALID_DOWNLOAD_EXPIRATION',
        `Download expiration must be between 1 and ${String(MAX_DOWNLOAD_TTL_SECONDS)} seconds`,
      );
    }
    const asset = await this.#repository.findAvailableAsset(assetId, ownerId);
    if (asset === null) {
      throw new UploadSessionError('ASSET_NOT_FOUND', 'Asset was not found');
    }
    this.#assertOwnerScopedObjectKey(asset.ownerId, asset.objectKey);
    return this.#objectStore.createDownload(asset.objectKey, expiresInSeconds);
  }

  #validateCreateInput(input: CreateUploadSessionInput): void {
    if (!UUID_PATTERN.test(input.ownerId)) {
      throw new UploadSessionError('INVALID_OWNER_ID', 'Owner ID must be a UUID');
    }
    if (input.kind !== 'UPLOAD') {
      throw new UploadSessionError(
        'INVALID_ASSET_KIND',
        'Direct upload sessions only accept UPLOAD assets',
      );
    }
    if (
      input.fileName.length === 0 ||
      input.fileName.length > 255 ||
      input.fileName.includes('\0')
    ) {
      throw new UploadSessionError('INVALID_FILE_NAME', 'Original filename is invalid');
    }
    if (input.sizeBytes <= 0n) {
      throw new UploadSessionError('INVALID_FILE_SIZE', 'File size must be greater than zero');
    }
    const maxBytes = this.#policy.allowedMimeTypes[input.mimeType];
    if (maxBytes === undefined) {
      throw new UploadSessionError('UNSUPPORTED_MIME_TYPE', 'MIME type is not allowed');
    }
    if (input.sizeBytes > maxBytes) {
      throw new UploadSessionError('FILE_TOO_LARGE', 'File exceeds the configured MIME size limit');
    }
  }

  #validateCompletionDeclaration(
    session: UploadSessionRecord,
    input: CompleteUploadSessionInput,
  ): void {
    if (input.mimeType !== session.expectedMimeType) {
      throw new UploadSessionError(
        'DECLARED_MIME_TYPE_MISMATCH',
        'Declared MIME type does not match the issued upload policy',
      );
    }
    if (input.sizeBytes !== session.expectedSizeBytes) {
      throw new UploadSessionError(
        'DECLARED_SIZE_MISMATCH',
        'Declared size does not match the issued upload policy',
      );
    }
  }

  #assertIssuedObjectKey(session: UploadSessionRecord, candidate: string): void {
    this.#assertOwnerScopedObjectKey(session.ownerId, session.objectKey);
    if (candidate !== session.objectKey) {
      throw new UploadSessionError(
        'OBJECT_KEY_MISMATCH',
        'Object key was not issued for this upload session',
      );
    }
  }

  #assertOwnerScopedObjectKey(ownerId: string, objectKey: string): void {
    const expectedPrefix = `uploads/${ownerId}/`;
    const objectId = objectKey.slice(expectedPrefix.length);
    if (
      !objectKey.startsWith(expectedPrefix) ||
      !UUID_PATTERN.test(objectId) ||
      objectId.includes('/')
    ) {
      throw new UploadSessionError(
        'OBJECT_KEY_MISMATCH',
        'Object key is outside the owner upload namespace',
      );
    }
  }

  async #deleteInvalidObject(objectKey: string): Promise<void> {
    try {
      await this.#objectStore.delete(objectKey);
    } catch {
      // Persistence retains the non-available asset so the deletion worker can retry cleanup.
    }
  }
}

function isTerminalValidationFailure(error: unknown): error is UploadSessionError {
  return (
    error instanceof UploadSessionError &&
    (error.code === 'DECLARED_MIME_TYPE_MISMATCH' ||
      error.code === 'DECLARED_SIZE_MISMATCH' ||
      error.code === 'OBJECT_MIME_TYPE_MISMATCH' ||
      error.code === 'OBJECT_SIZE_MISMATCH' ||
      error.code === 'INVALID_FILE_SIGNATURE')
  );
}

function normalizeContentType(contentType: string): string {
  return contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function matchesMagic(mimeType: string, prefix: Uint8Array): boolean {
  switch (mimeType) {
    case 'image/png':
      return startsWithBytes(prefix, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/jpeg':
      return startsWithBytes(prefix, [0xff, 0xd8, 0xff]);
    case 'image/gif':
      return (
        startsWithBytes(prefix, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
        startsWithBytes(prefix, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
      );
    case 'image/webp':
      return startsWithBytes(prefix, [0x52, 0x49, 0x46, 0x46]) && startsWithBytes(prefix, [0x57, 0x45, 0x42, 0x50], 8);
    case 'video/mp4':
    case 'video/quicktime':
      return startsWithBytes(prefix, [0x66, 0x74, 0x79, 0x70], 4);
    case 'video/webm':
      return startsWithBytes(prefix, [0x1a, 0x45, 0xdf, 0xa3]);
    default:
      return false;
  }
}

function startsWithBytes(prefix: Uint8Array, expected: readonly number[], offset = 0): boolean {
  return expected.every((byte, index) => prefix[offset + index] === byte);
}
