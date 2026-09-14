import { readFile } from 'node:fs/promises';
import type {
  AttachmentAuthorizationGateway,
  AttachmentReservation,
  SupportUploadSessionOutcome,
} from '../application/ticket.service.js';

export interface WorkloadIdentityToken {
  get(): Promise<string>;
}

export class FileWorkloadIdentityToken implements WorkloadIdentityToken {
  constructor(private readonly path: string) {}
  async get(): Promise<string> {
    const token = (await readFile(this.path, 'utf8')).trim();
    if (token.length < 8 || token.length > 16_384)
      throw new AssetDependencyError('WORKLOAD_IDENTITY_UNAVAILABLE', true);
    return token;
  }
}

export class AssetDependencyError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code);
    this.name = 'AssetDependencyError';
  }
}

export class HttpAssetAuthorizationGateway implements AttachmentAuthorizationGateway {
  constructor(
    private readonly base: URL,
    private readonly token: WorkloadIdentityToken,
    private readonly timeoutMs = 2_000,
  ) {
    if (base.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(base.hostname))
      throw new Error('INSECURE_ASSET_SERVICE_URL');
  }
  async findAvailableAsset(assetId: string): Promise<{ id: string; ownerId: string } | null> {
    const response = await this.request(`/internal/assets/${encodeURIComponent(assetId)}`, 'GET');
    if (response.status === 404) return null;
    return this.body<{ id: string; ownerId: string }>(response);
  }
  async reserveSupportUploadSession(
    input: Parameters<AttachmentAuthorizationGateway['reserveSupportUploadSession']>[0],
  ): Promise<SupportUploadSessionOutcome> {
    return this.body(await this.request('/internal/support-uploads/reserve', 'POST', input));
  }
  async finalizeSupportUploadSession(
    input: Parameters<AttachmentAuthorizationGateway['finalizeSupportUploadSession']>[0],
  ): Promise<void> {
    await this.ok(await this.request('/internal/support-uploads/finalize', 'POST', input));
  }
  async releaseSupportUploadSession(
    input: Parameters<AttachmentAuthorizationGateway['releaseSupportUploadSession']>[0],
  ): Promise<void> {
    await this.ok(await this.request('/internal/support-uploads/release', 'POST', input));
  }
  async lookupSupportUploadReservation(operationId: string): Promise<AttachmentReservation | null> {
    const response = await this.request(
      `/internal/support-uploads/reservations/${encodeURIComponent(operationId)}`,
      'GET',
    );
    if (response.status === 404) return null;
    const value = await this.body<Omit<AttachmentReservation, 'expiresAt'> & { expiresAt: string }>(
      response,
    );
    return { ...value, expiresAt: new Date(value.expiresAt) };
  }
  async ping(): Promise<void> {
    const response = await this.request('/health/live', 'GET');
    await this.ok(response);
  }
  private async request(path: string, method: 'GET' | 'POST', body?: unknown): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(new URL(path, this.base), {
        method,
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${await this.token.get()}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new AssetDependencyError('ASSET_SERVICE_UNAVAILABLE', true);
    }
    return response;
  }
  private async ok(response: Response): Promise<void> {
    if (!response.ok) throw await mapped(response);
  }
  private async body<T>(response: Response): Promise<T> {
    await this.ok(response);
    try {
      return (await response.json()) as T;
    } catch {
      throw new AssetDependencyError('ASSET_SERVICE_INVALID_RESPONSE', true);
    }
  }
}

async function mapped(response: Response): Promise<AssetDependencyError> {
  let code = `ASSET_SERVICE_${String(response.status)}`;
  try {
    const value = (await response.json()) as { code?: unknown };
    if (typeof value.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(value.code)) code = value.code;
  } catch {
    /* response body is optional */
  }
  return new AssetDependencyError(code, response.status >= 500 || response.status === 429);
}
