import type { AssetLifecycleJob } from '../application/lifecycle.job.js';
import {
  ResultImportError,
  type ResultImportService,
} from '../application/result-import.service.js';
import {
  UploadSessionError,
  type UploadSessionService,
} from '../application/upload-session.service.js';
import {
  SupportUploadError,
  type InternalAssetService,
} from '../application/support-upload.service.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type RawHttpHeaders = Record<string, string | string[] | undefined>;

export interface UserAuthenticator {
  authenticate(headers: RawHttpHeaders): Promise<{ userId: string } | null>;
}

export interface ProviderCallbackAuthenticator {
  authenticate(request: {
    headers: RawHttpHeaders;
    rawBody: Uint8Array;
  }): Promise<{ providerId: string } | null>;
}

export interface AuthorizedProviderTask {
  authorizationId: string;
  ownerId: string;
  providerTaskId: string;
  allowedHosts: string[];
  expectedMimeType: string;
  expectedSizeBytes: bigint;
  expectedChecksum?: string;
  originalFileName: string;
}

export interface ProviderTaskAuthorization {
  authorize(providerId: string, providerTaskId: string): Promise<AuthorizedProviderTask | null>;
}

export interface AssetHttpRequest {
  method: string;
  path: string;
  headers?: RawHttpHeaders;
  rawBody?: Uint8Array;
  body?: unknown;
}

export interface AssetHttpResponse {
  status: number;
  body?: unknown;
}

/** Framework-neutral, directly mountable handler. Task 6 adds the process shell. */
export class AssetHttpModule {
  readonly #resultImport: Pick<ResultImportService, 'import'>;
  readonly #lifecycle: Pick<AssetLifecycleJob, 'requestUserDeletion' | 'restoreUserDeletion'>;
  readonly #uploadSessions: Pick<UploadSessionService, 'create' | 'complete' | 'createDownload'>;
  readonly #internalAssets: Pick<
    InternalAssetService,
    'findAvailableAsset' | 'reserve' | 'finalize' | 'release' | 'lookup'
  >;
  readonly #userAuthenticator: UserAuthenticator;
  readonly #serviceAuthenticator: UserAuthenticator;
  readonly #providerCallbackAuthenticator: ProviderCallbackAuthenticator;
  readonly #providerTaskAuthorization: ProviderTaskAuthorization;
  readonly #metrics: {
    uploadCompletionFailed(reason: 'signature' | 'size' | 'mime' | 'storage' | 'unknown'): void;
  };

  constructor(input: {
    resultImport: Pick<ResultImportService, 'import'>;
    lifecycle: Pick<AssetLifecycleJob, 'requestUserDeletion' | 'restoreUserDeletion'>;
    uploadSessions?: Pick<UploadSessionService, 'create' | 'complete' | 'createDownload'>;
    internalAssets?: Pick<
      InternalAssetService,
      'findAvailableAsset' | 'reserve' | 'finalize' | 'release' | 'lookup'
    >;
    userAuthenticator: UserAuthenticator;
    serviceAuthenticator?: UserAuthenticator;
    providerCallbackAuthenticator: ProviderCallbackAuthenticator;
    providerTaskAuthorization: ProviderTaskAuthorization;
    metrics?: {
      uploadCompletionFailed(reason: 'signature' | 'size' | 'mime' | 'storage' | 'unknown'): void;
    };
  }) {
    this.#resultImport = input.resultImport;
    this.#lifecycle = input.lifecycle;
    this.#uploadSessions = input.uploadSessions ?? unavailableUploadSessions();
    this.#internalAssets = input.internalAssets ?? unavailableInternalAssets();
    this.#userAuthenticator = input.userAuthenticator;
    this.#serviceAuthenticator = input.serviceAuthenticator ?? input.userAuthenticator;
    this.#providerCallbackAuthenticator = input.providerCallbackAuthenticator;
    this.#providerTaskAuthorization = input.providerTaskAuthorization;
    this.#metrics = input.metrics ?? { uploadCompletionFailed: () => undefined };
  }

  async handle(request: AssetHttpRequest): Promise<AssetHttpResponse> {
    if (request.method === 'POST' && request.path === '/v1/upload-sessions')
      return this.#createUpload(request);
    const completion = /^\/v1\/upload-sessions\/([0-9a-f-]+)\/complete$/i.exec(request.path);
    if (request.method === 'POST' && completion !== null)
      return this.#completeUpload(request, completion[1] ?? '');
    const download = /^\/v1\/assets\/([0-9a-f-]+)\/downloads$/i.exec(request.path);
    if (request.method === 'POST' && download !== null)
      return this.#createDownload(request, download[1] ?? '');
    if (request.method === 'POST' && request.path === '/internal/provider-results/import') {
      return this.#importProviderResult(request);
    }
    if (request.path.startsWith('/internal/')) return this.#internal(request);
    const assetRoute = /^\/v1\/assets\/([0-9a-f-]+)(\/restore)?$/i.exec(request.path);
    if (assetRoute !== null) {
      if (request.method === 'DELETE' && assetRoute[2] === undefined)
        return this.#deleteAsset(request, assetRoute[1] ?? '');
      if (request.method === 'POST' && assetRoute[2] === '/restore')
        return this.#restoreAsset(request, assetRoute[1] ?? '');
    }
    return { status: 404, body: { code: 'ROUTE_NOT_FOUND' } };
  }

  async #createUpload(request: AssetHttpRequest): Promise<AssetHttpResponse> {
    const user = await this.#authenticate(this.#userAuthenticator, request);
    if (user === null) return unauthenticated();
    const body = record(request.body);
    if (
      body === null ||
      typeof body.kind !== 'string' ||
      typeof body.fileName !== 'string' ||
      typeof body.mimeType !== 'string' ||
      typeof body.sizeBytes !== 'string' ||
      !/^\d+$/.test(body.sizeBytes)
    )
      return invalidRequest();
    try {
      return {
        status: 201,
        body: await this.#uploadSessions.create({
          ownerId: user.userId,
          kind: body.kind as 'UPLOAD',
          fileName: body.fileName,
          mimeType: body.mimeType,
          sizeBytes: BigInt(body.sizeBytes),
        }),
      };
    } catch (error) {
      return uploadError(error);
    }
  }

  async #completeUpload(request: AssetHttpRequest, sessionId: string): Promise<AssetHttpResponse> {
    const user = await this.#authenticate(this.#userAuthenticator, request);
    if (user === null) return unauthenticated();
    const body = record(request.body);
    if (
      body === null ||
      typeof body.objectKey !== 'string' ||
      typeof body.mimeType !== 'string' ||
      typeof body.sizeBytes !== 'string' ||
      !/^\d+$/.test(body.sizeBytes)
    )
      return invalidRequest();
    try {
      return {
        status: 200,
        body: await this.#uploadSessions.complete(sessionId, {
          ownerId: user.userId,
          objectKey: body.objectKey,
          mimeType: body.mimeType,
          sizeBytes: BigInt(body.sizeBytes),
        }),
      };
    } catch (error) {
      this.#metrics.uploadCompletionFailed(uploadFailureReason(error));
      return uploadError(error);
    }
  }

  async #createDownload(request: AssetHttpRequest, assetId: string): Promise<AssetHttpResponse> {
    const user = await this.#authenticate(this.#userAuthenticator, request);
    if (user === null) return unauthenticated();
    const body = record(request.body);
    if (body === null || typeof body.expiresInSeconds !== 'number') return invalidRequest();
    try {
      return {
        status: 200,
        body: {
          url: await this.#uploadSessions.createDownload(
            user.userId,
            assetId,
            body.expiresInSeconds,
          ),
        },
      };
    } catch (error) {
      return uploadError(error);
    }
  }

  async #internal(request: AssetHttpRequest): Promise<AssetHttpResponse> {
    const identity = await this.#authenticate(this.#serviceAuthenticator, request);
    if (identity === null) return unauthenticated();
    const asset = /^\/internal\/assets\/([0-9a-f-]+)$/i.exec(request.path);
    try {
      if (request.method === 'GET' && asset !== null) {
        const result = await this.#internalAssets.findAvailableAsset(asset[1] ?? '');
        return result === null ? assetNotFound() : { status: 200, body: result };
      }
      if (request.method === 'POST' && request.path === '/internal/support-uploads/reserve')
        return { status: 200, body: await this.#internalAssets.reserve(request.body as never) };
      if (request.method === 'POST' && request.path === '/internal/support-uploads/finalize') {
        await this.#internalAssets.finalize(request.body as never);
        return { status: 204 };
      }
      if (request.method === 'POST' && request.path === '/internal/support-uploads/release') {
        await this.#internalAssets.release(request.body as never);
        return { status: 204 };
      }
      const lookup = /^\/internal\/support-uploads\/reservations\/(.+)$/.exec(request.path);
      if (request.method === 'GET' && lookup !== null) {
        const value = await this.#internalAssets.lookup(decodeURIComponent(lookup[1] ?? ''));
        return value === null
          ? { status: 404, body: { code: 'RESERVATION_NOT_FOUND' } }
          : { status: 200, body: value };
      }
      return { status: 404, body: { code: 'ROUTE_NOT_FOUND' } };
    } catch (error) {
      if (error instanceof SupportUploadError)
        return {
          status:
            error.code === 'RESERVATION_CONFLICT'
              ? 409
              : error.code === 'RESERVATION_NOT_FOUND'
                ? 404
                : 400,
          body: { code: error.code },
        };
      return internalError();
    }
  }

  async #authenticate(
    authenticator: UserAuthenticator,
    request: AssetHttpRequest,
  ): Promise<{ userId: string } | null> {
    try {
      return await authenticator.authenticate(normalizeHeaders(request.headers));
    } catch {
      return null;
    }
  }

  async #importProviderResult(request: AssetHttpRequest): Promise<AssetHttpResponse> {
    if (request.rawBody === undefined) return unauthenticated();
    let identity: { providerId: string } | null;
    try {
      identity = await this.#providerCallbackAuthenticator.authenticate({
        headers: normalizeHeaders(request.headers),
        rawBody: request.rawBody,
      });
    } catch {
      return internalError();
    }
    if (identity === null) return unauthenticated();
    const callback = parseCallbackBody(request.rawBody);
    if (callback === null || !sameCallbackBody(request.body, callback)) return invalidRequest();
    let task: AuthorizedProviderTask | null;
    try {
      task = await this.#providerTaskAuthorization.authorize(
        identity.providerId,
        callback.providerTaskId,
      );
    } catch {
      return internalError();
    }
    if (task === null || !isAuthorizedTask(task, callback.providerTaskId)) return forbidden();

    try {
      const result = await this.#resultImport.import({
        providerId: identity.providerId,
        authorizationId: task.authorizationId,
        ownerId: task.ownerId,
        providerTaskId: task.providerTaskId,
        sourceUrl: callback.sourceUrl,
        allowedHosts: [...task.allowedHosts],
        expectedMimeType: task.expectedMimeType,
        expectedSizeBytes: task.expectedSizeBytes,
        ...(task.expectedChecksum === undefined ? {} : { expectedChecksum: task.expectedChecksum }),
        originalFileName: task.originalFileName,
      });
      return { status: 201, body: result };
    } catch (error) {
      if (error instanceof ResultImportError)
        return {
          status: error.code === 'RESULT_IMPORT_FAILED' ? 502 : 422,
          body: { code: error.code },
        };
      return internalError();
    }
  }

  async #deleteAsset(request: AssetHttpRequest, assetId: string): Promise<AssetHttpResponse> {
    let identity: { userId: string } | null;
    try {
      identity = await this.#userAuthenticator.authenticate(normalizeHeaders(request.headers));
    } catch {
      return internalError();
    }
    if (identity === null) return unauthenticated();
    if (!UUID_PATTERN.test(identity.userId) || !UUID_PATTERN.test(assetId)) return invalidRequest();
    try {
      return (await this.#lifecycle.requestUserDeletion(identity.userId, assetId))
        ? { status: 202 }
        : assetNotFound();
    } catch {
      return internalError();
    }
  }

  async #restoreAsset(request: AssetHttpRequest, assetId: string): Promise<AssetHttpResponse> {
    let identity: { userId: string } | null;
    try {
      identity = await this.#userAuthenticator.authenticate(normalizeHeaders(request.headers));
    } catch {
      return internalError();
    }
    if (identity === null) return unauthenticated();
    if (!UUID_PATTERN.test(identity.userId) || !UUID_PATTERN.test(assetId)) return invalidRequest();
    try {
      return (await this.#lifecycle.restoreUserDeletion(identity.userId, assetId))
        ? { status: 204 }
        : assetNotFound();
    } catch {
      return internalError();
    }
  }
}

function normalizeHeaders(headers: RawHttpHeaders | undefined): RawHttpHeaders {
  const normalized: RawHttpHeaders = {};
  for (const [name, value] of Object.entries(headers ?? {})) normalized[name.toLowerCase()] = value;
  return normalized;
}

function parseCallbackBody(
  rawBody: Uint8Array,
): { providerTaskId: string; sourceUrl: string } | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(rawBody).toString('utf8'));
    return isExactCallbackBody(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function sameCallbackBody(
  body: unknown,
  callback: { providerTaskId: string; sourceUrl: string },
): boolean {
  return (
    isExactCallbackBody(body) &&
    body.providerTaskId === callback.providerTaskId &&
    body.sourceUrl === callback.sourceUrl
  );
}

function isExactCallbackBody(body: unknown): body is { providerTaskId: string; sourceUrl: string } {
  if (!isRecord(body) || Object.keys(body).length !== 2) return false;
  return (
    typeof body.providerTaskId === 'string' &&
    body.providerTaskId.length > 0 &&
    body.providerTaskId.length <= 255 &&
    typeof body.sourceUrl === 'string' &&
    body.sourceUrl.length > 0
  );
}

function isAuthorizedTask(task: AuthorizedProviderTask, requestedTaskId: string): boolean {
  return (
    task.providerTaskId === requestedTaskId &&
    UUID_PATTERN.test(task.authorizationId) &&
    UUID_PATTERN.test(task.ownerId) &&
    task.allowedHosts.length > 0 &&
    task.expectedMimeType.length > 0 &&
    task.expectedSizeBytes > 0n &&
    task.originalFileName.length > 0 &&
    task.originalFileName.length <= 255
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}
function uploadError(error: unknown): AssetHttpResponse {
  if (!(error instanceof UploadSessionError)) return internalError();
  const notFound = error.code === 'UPLOAD_SESSION_NOT_FOUND' || error.code === 'ASSET_NOT_FOUND';
  const conflict =
    error.code === 'UPLOAD_SESSION_ALREADY_USED' || error.code === 'UPLOAD_SESSION_EXPIRED';
  return { status: notFound ? 404 : conflict ? 409 : 422, body: { code: error.code } };
}
function uploadFailureReason(
  error: unknown,
): 'signature' | 'size' | 'mime' | 'storage' | 'unknown' {
  if (!(error instanceof UploadSessionError)) return 'storage';
  if (error.code === 'INVALID_FILE_SIGNATURE') return 'signature';
  if (error.code.includes('SIZE') || error.code === 'FILE_TOO_LARGE') return 'size';
  if (error.code.includes('MIME')) return 'mime';
  return 'unknown';
}
function unauthenticated(): AssetHttpResponse {
  return { status: 401, body: { code: 'UNAUTHENTICATED' } };
}
function invalidRequest(): AssetHttpResponse {
  return { status: 400, body: { code: 'INVALID_REQUEST' } };
}
function forbidden(): AssetHttpResponse {
  return { status: 403, body: { code: 'FORBIDDEN' } };
}
function assetNotFound(): AssetHttpResponse {
  return { status: 404, body: { code: 'ASSET_NOT_FOUND' } };
}
function internalError(): AssetHttpResponse {
  return { status: 500, body: { code: 'INTERNAL_ERROR' } };
}

function unavailable(): never {
  throw new Error('ROUTE_DEPENDENCY_UNAVAILABLE');
}

function unavailableUploadSessions(): Pick<
  UploadSessionService,
  'create' | 'complete' | 'createDownload'
> {
  return {
    create: unavailable,
    complete: unavailable,
    createDownload: unavailable,
  };
}

function unavailableInternalAssets(): Pick<
  InternalAssetService,
  'findAvailableAsset' | 'reserve' | 'finalize' | 'release' | 'lookup'
> {
  return {
    findAvailableAsset: unavailable,
    reserve: unavailable,
    finalize: unavailable,
    release: unavailable,
    lookup: unavailable,
  };
}
