import { randomUUID } from 'node:crypto';
import type { ObjectStore } from '../ports/object-store.js';

export type ResultImportErrorCode =
  | 'RESULT_URL_NOT_ALLOWED'
  | 'RESULT_URL_PRIVATE_ADDRESS'
  | 'RESULT_REDIRECT_NOT_ALLOWED'
  | 'RESULT_INTEGRITY_MISMATCH'
  | 'RESULT_IMPORT_FAILED';

export class ResultImportError extends Error {
  readonly code: ResultImportErrorCode;

  constructor(code: ResultImportErrorCode, message: string) {
    super(message);
    this.name = 'ResultImportError';
    this.code = code;
  }
}

export interface ResultDownloadTransport {
  /**
   * Copies a response by connecting only to an address which it validated for
   * every redirect hop. Implementations must stream into private storage.
   */
  copy(input: {
    sourceUrl: URL;
    destinationKey: string;
    maxBytes: bigint;
    allowedHosts: string[];
  }): Promise<{ contentType: string; sizeBytes: bigint; checksum?: string }>;
}

export interface ResultImportRepository {
  findImported(idempotencyKey: string): Promise<ImportedResult | null>;
  reserveImport(input: {
    idempotencyKey: string;
    ownerId: string;
    providerId: string;
    authorizationId: string;
    objectKey: string;
    now: Date;
  }): Promise<
    | { kind: 'claimed'; claimToken: string }
    | { kind: 'busy' }
    | ({ kind: 'duplicate' } & ImportedResult)
  >;
  /** Persists the AVAILABLE asset and `asset.imported.v1` outbox event atomically. */
  persistImported(input: {
    idempotencyKey: string;
    claimToken: string;
    asset: ImportedResult & {
      ownerId: string;
      mimeType: string;
      sizeBytes: bigint;
      checksum?: string;
      originalFileName: string;
    };
  }): Promise<
    | { kind: 'created'; eventId: string }
    | { kind: 'stale' }
    | ({ kind: 'duplicate' } & ImportedResult)
  >;
  failAndScheduleCleanup(input: {
    idempotencyKey: string;
    claimToken: string;
    failedAt: Date;
    error: ResultImportErrorCode;
    objectKey: string;
    scheduledAt: Date;
  }): Promise<void>;
  scheduleCleanup(input: {
    objectKey: string;
    reason: 'IMPORT_FAILED' | 'DUPLICATE_RACE';
    scheduledAt: Date;
  }): Promise<void>;
}

export interface ImportedResult {
  assetId: string;
  objectKey: string;
  status?: 'AVAILABLE';
}

export interface ResultOutboxDispatcher {
  /** A best-effort kick; the durable outbox remains authoritative if dispatch fails. */
  dispatch(eventId: string): Promise<void>;
}

export interface ResultImportInput {
  ownerId: string;
  providerId: string;
  authorizationId: string;
  providerTaskId: string;
  sourceUrl: string;
  allowedHosts: string[];
  expectedMimeType: string;
  expectedSizeBytes: bigint;
  expectedChecksum?: string;
  originalFileName: string;
}

export interface ResultImportServiceDependencies {
  objectStore: Pick<ObjectStore, 'head' | 'delete' | 'readPrefix'>;
  transport: ResultDownloadTransport;
  repository: ResultImportRepository;
  events: ResultOutboxDispatcher;
  idGenerator?: () => string;
  now?: () => Date;
  metrics?: {
    importCompleted(bytes: number): void;
    importFailed(reason: 'network' | 'policy' | 'checksum' | 'storage' | 'unknown'): void;
  };
}

export class ResultImportService {
  readonly #objectStore: Pick<ObjectStore, 'head' | 'delete' | 'readPrefix'>;
  readonly #transport: ResultDownloadTransport;
  readonly #repository: ResultImportRepository;
  readonly #events: ResultOutboxDispatcher;
  readonly #idGenerator: () => string;
  readonly #now: () => Date;
  readonly #metrics: NonNullable<ResultImportServiceDependencies['metrics']>;

  constructor(dependencies: ResultImportServiceDependencies) {
    this.#objectStore = dependencies.objectStore;
    this.#transport = dependencies.transport;
    this.#repository = dependencies.repository;
    this.#events = dependencies.events;
    this.#idGenerator = dependencies.idGenerator ?? randomUUID;
    this.#now = dependencies.now ?? (() => new Date());
    this.#metrics = dependencies.metrics ?? {
      importCompleted: () => undefined,
      importFailed: () => undefined,
    };
  }

  async import(input: ResultImportInput): Promise<ImportedResult> {
    const sourceUrl = assertAllowedResultUrl(input.sourceUrl, input.allowedHosts);
    assertExpectedMetadata(input);
    const idempotencyKey = `${input.providerId}:${input.authorizationId}:${input.ownerId}:${input.providerTaskId}`;
    const known = await this.#repository.findImported(idempotencyKey);
    if (known !== null) return known;

    const assetId = this.#idGenerator();
    const objectKey = `results/${input.ownerId}/${assetId}`;
    const reservation = await this.#repository.reserveImport({
      idempotencyKey,
      ownerId: input.ownerId,
      providerId: input.providerId,
      authorizationId: input.authorizationId,
      objectKey,
      now: this.#now(),
    });
    if (reservation.kind === 'duplicate') return reservation;
    if (reservation.kind === 'busy') {
      throw new ResultImportError('RESULT_IMPORT_FAILED', 'Result import is already in progress');
    }

    let persisted = false;
    let cleanupScheduled = false;
    try {
      const copied = await this.#transport.copy({
        sourceUrl,
        destinationKey: objectKey,
        maxBytes: input.expectedSizeBytes,
        allowedHosts: input.allowedHosts,
      });
      this.#metrics.importCompleted(safeMetricBytes(copied.sizeBytes));
      const verified = await this.#objectStore.head(objectKey);
      assertIntegrity(input, copied, verified);
      const prefix = await this.#objectStore.readPrefix(objectKey, 32);
      if (!matchesResultSignature(input.expectedMimeType, prefix)) {
        throw new ResultImportError(
          'RESULT_INTEGRITY_MISMATCH',
          'Imported result signature does not match its MIME type',
        );
      }
      const persistedResult = await this.#repository.persistImported({
        idempotencyKey,
        claimToken: reservation.claimToken,
        asset: {
          assetId,
          objectKey,
          ownerId: input.ownerId,
          mimeType: verified.contentType,
          sizeBytes: verified.sizeBytes,
          ...(verified.checksum === undefined ? {} : { checksum: verified.checksum }),
          originalFileName: input.originalFileName,
        },
      });
      if (persistedResult.kind === 'stale') {
        cleanupScheduled = true;
        throw new ResultImportError('RESULT_IMPORT_FAILED', 'Result import reservation was lost');
      }
      if (persistedResult.kind === 'duplicate') {
        await this.#scheduleCleanup(objectKey, 'DUPLICATE_RACE', this.#now());
        return persistedResult;
      }
      persisted = true;
      const result: ImportedResult = { assetId, objectKey, status: 'AVAILABLE' };
      try {
        await this.#events.dispatch(persistedResult.eventId);
      } catch {
        /* durable outbox retries */
      }
      return result;
    } catch (error) {
      const stableError = toStableImportError(error);
      this.#metrics.importFailed(importFailureReason(stableError));
      if (!persisted && !cleanupScheduled) {
        const failedAt = this.#now();
        try {
          await this.#repository.failAndScheduleCleanup({
            idempotencyKey,
            claimToken: reservation.claimToken,
            failedAt,
            error: stableError.code,
            objectKey,
            scheduledAt: new Date(failedAt.getTime() + 7 * 24 * 60 * 60 * 1_000),
          });
        } catch {
          // The reservation stores objectKey before any bytes are copied, so a
          // recovery scan remains authoritative if this immediate delete fails.
          try {
            await this.#objectStore.delete(objectKey);
          } catch {
            /* recovered from the durable reservation */
          }
        }
      }
      throw stableError;
    }
  }

  async #scheduleCleanup(
    objectKey: string,
    reason: 'IMPORT_FAILED' | 'DUPLICATE_RACE',
    scheduledAt: Date,
  ): Promise<void> {
    await this.#repository.scheduleCleanup({ objectKey, reason, scheduledAt });
  }
}

function safeMetricBytes(value: bigint): number {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : 0;
}

function importFailureReason(
  error: ResultImportError,
): 'network' | 'policy' | 'checksum' | 'storage' | 'unknown' {
  if (
    error.code === 'RESULT_URL_NOT_ALLOWED' ||
    error.code === 'RESULT_URL_PRIVATE_ADDRESS' ||
    error.code === 'RESULT_REDIRECT_NOT_ALLOWED'
  )
    return 'policy';
  if (error.code === 'RESULT_INTEGRITY_MISMATCH') return 'checksum';
  return 'network';
}

function assertAllowedResultUrl(sourceUrl: string, allowedHosts: string[]): URL {
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    throw new ResultImportError('RESULT_URL_NOT_ALLOWED', 'Result URL is not permitted');
  }
  const allowed = new Set(allowedHosts.map(normalizeHost));
  if (
    url.protocol !== 'https:' ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0 ||
    url.port.length > 0 ||
    !allowed.has(normalizeHost(url.hostname))
  ) {
    throw new ResultImportError('RESULT_URL_NOT_ALLOWED', 'Result URL is not permitted');
  }
  return url;
}

function normalizeHost(host: string): string {
  const trimmed = host.trim().replace(/\.$/, '');
  try {
    return new URL(`https://${trimmed}`).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return '';
  }
}

function assertExpectedMetadata(input: ResultImportInput): void {
  if (
    input.ownerId.length === 0 ||
    input.providerId.length === 0 ||
    input.authorizationId.length === 0 ||
    input.providerTaskId.length === 0 ||
    input.originalFileName.length === 0 ||
    input.expectedMimeType.length === 0 ||
    input.expectedSizeBytes <= 0n
  ) {
    throw new ResultImportError('RESULT_IMPORT_FAILED', 'Result import metadata is invalid');
  }
}

function assertIntegrity(
  expected: ResultImportInput,
  copied: { contentType: string; sizeBytes: bigint; checksum?: string },
  verified: { contentType: string; sizeBytes: bigint; checksum?: string },
): void {
  const expectedType = normalizeContentType(expected.expectedMimeType);
  if (
    normalizeContentType(copied.contentType) !== expectedType ||
    normalizeContentType(verified.contentType) !== expectedType ||
    copied.sizeBytes !== expected.expectedSizeBytes ||
    verified.sizeBytes !== expected.expectedSizeBytes ||
    (expected.expectedChecksum !== undefined &&
      (copied.checksum !== expected.expectedChecksum ||
        verified.checksum !== expected.expectedChecksum))
  ) {
    throw new ResultImportError(
      'RESULT_INTEGRITY_MISMATCH',
      'Imported result does not match expected metadata',
    );
  }
}

function normalizeContentType(value: string): string {
  return value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function matchesResultSignature(mimeType: string, prefix: Uint8Array): boolean {
  const mime = normalizeContentType(mimeType);
  if (mime === 'video/mp4')
    return (
      prefix.length >= 8 &&
      prefix[4] === 0x66 &&
      prefix[5] === 0x74 &&
      prefix[6] === 0x79 &&
      prefix[7] === 0x70
    );
  if (mime === 'image/png')
    return (
      prefix.length >= 8 &&
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
        (byte, index) => prefix[index] === byte,
      )
    );
  if (mime === 'image/jpeg')
    return prefix.length >= 3 && prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff;
  return false;
}

function toStableImportError(error: unknown): ResultImportError {
  if (error instanceof ResultImportError) return error;
  return new ResultImportError('RESULT_IMPORT_FAILED', 'Result import could not be completed');
}
