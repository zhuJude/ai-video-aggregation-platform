import type { AssetLifecycleJob } from '../application/lifecycle.job.js';
import { ResultImportError, type ResultImportService } from '../application/result-import.service.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type RawHttpHeaders = Record<string, string | string[] | undefined>;

export interface UserAuthenticator {
  authenticate(headers: RawHttpHeaders): Promise<{ userId: string } | null>;
}

export interface ProviderCallbackAuthenticator {
  authenticate(request: { headers: RawHttpHeaders; rawBody: Uint8Array }): Promise<{ providerId: string } | null>;
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
  readonly #userAuthenticator: UserAuthenticator;
  readonly #providerCallbackAuthenticator: ProviderCallbackAuthenticator;
  readonly #providerTaskAuthorization: ProviderTaskAuthorization;

  constructor(input: {
    resultImport: Pick<ResultImportService, 'import'>;
    lifecycle: Pick<AssetLifecycleJob, 'requestUserDeletion' | 'restoreUserDeletion'>;
    userAuthenticator: UserAuthenticator;
    providerCallbackAuthenticator: ProviderCallbackAuthenticator;
    providerTaskAuthorization: ProviderTaskAuthorization;
  }) {
    this.#resultImport = input.resultImport;
    this.#lifecycle = input.lifecycle;
    this.#userAuthenticator = input.userAuthenticator;
    this.#providerCallbackAuthenticator = input.providerCallbackAuthenticator;
    this.#providerTaskAuthorization = input.providerTaskAuthorization;
  }

  async handle(request: AssetHttpRequest): Promise<AssetHttpResponse> {
    if (request.method === 'POST' && request.path === '/internal/provider-results/import') {
      return this.#importProviderResult(request);
    }
    const assetRoute = /^\/v1\/assets\/([0-9a-f-]+)(\/restore)?$/i.exec(request.path);
    if (assetRoute !== null) {
      if (request.method === 'DELETE' && assetRoute[2] === undefined) return this.#deleteAsset(request, assetRoute[1] ?? '');
      if (request.method === 'POST' && assetRoute[2] === '/restore') return this.#restoreAsset(request, assetRoute[1] ?? '');
    }
    return { status: 404, body: { code: 'ROUTE_NOT_FOUND' } };
  }

  async #importProviderResult(request: AssetHttpRequest): Promise<AssetHttpResponse> {
    if (request.rawBody === undefined) return unauthenticated();
    let identity: { providerId: string } | null;
    try {
      identity = await this.#providerCallbackAuthenticator.authenticate({ headers: normalizeHeaders(request.headers), rawBody: request.rawBody });
    } catch {
      return internalError();
    }
    if (identity === null) return unauthenticated();
    const callback = parseCallbackBody(request.rawBody);
    if (callback === null || !sameCallbackBody(request.body, callback)) return invalidRequest();
    let task: AuthorizedProviderTask | null;
    try {
      task = await this.#providerTaskAuthorization.authorize(identity.providerId, callback.providerTaskId);
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
      if (error instanceof ResultImportError) return { status: error.code === 'RESULT_IMPORT_FAILED' ? 502 : 422, body: { code: error.code } };
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
      return await this.#lifecycle.requestUserDeletion(identity.userId, assetId) ? { status: 202 } : assetNotFound();
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
      return await this.#lifecycle.restoreUserDeletion(identity.userId, assetId) ? { status: 204 } : assetNotFound();
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

function parseCallbackBody(rawBody: Uint8Array): { providerTaskId: string; sourceUrl: string } | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(rawBody).toString('utf8'));
    return isExactCallbackBody(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function sameCallbackBody(body: unknown, callback: { providerTaskId: string; sourceUrl: string }): boolean {
  return isExactCallbackBody(body) && body.providerTaskId === callback.providerTaskId && body.sourceUrl === callback.sourceUrl;
}

function isExactCallbackBody(body: unknown): body is { providerTaskId: string; sourceUrl: string } {
  if (!isRecord(body) || Object.keys(body).length !== 2) return false;
  return typeof body.providerTaskId === 'string' && body.providerTaskId.length > 0 && body.providerTaskId.length <= 255 &&
    typeof body.sourceUrl === 'string' && body.sourceUrl.length > 0;
}

function isAuthorizedTask(task: AuthorizedProviderTask, requestedTaskId: string): boolean {
  return task.providerTaskId === requestedTaskId && UUID_PATTERN.test(task.authorizationId) && UUID_PATTERN.test(task.ownerId) && task.allowedHosts.length > 0 &&
    task.expectedMimeType.length > 0 && task.expectedSizeBytes > 0n && task.originalFileName.length > 0 && task.originalFileName.length <= 255;
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function unauthenticated(): AssetHttpResponse { return { status: 401, body: { code: 'UNAUTHENTICATED' } }; }
function invalidRequest(): AssetHttpResponse { return { status: 400, body: { code: 'INVALID_REQUEST' } }; }
function forbidden(): AssetHttpResponse { return { status: 403, body: { code: 'FORBIDDEN' } }; }
function assetNotFound(): AssetHttpResponse { return { status: 404, body: { code: 'ASSET_NOT_FOUND' } }; }
function internalError(): AssetHttpResponse { return { status: 500, body: { code: 'INTERNAL_ERROR' } }; }
