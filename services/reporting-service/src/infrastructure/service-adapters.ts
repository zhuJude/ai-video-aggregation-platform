import type { AuditSink, PrivateAssetStore } from '../application/export.service.js';
import type { BooleanHealthProbe } from '../runtime/runtime.js';

function serviceHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

function requireOk(response: Response, operation: string): void {
  if (!response.ok) throw new Error(`${operation} failed with status ${String(response.status)}`);
}

export class HttpConsumerHealthProbe implements BooleanHealthProbe {
  constructor(
    private readonly url: string,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  async check(): Promise<boolean> {
    try {
      const response = await this.fetchImplementation(this.url, {
        method: 'GET',
        signal: AbortSignal.timeout(3_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

export class HttpPrivateAssetStore implements PrivateAssetStore {
  constructor(
    private readonly baseUrl: string,
    private readonly serviceToken: string,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  async putPrivate(input: { objectKey: string; body: string; expiresAt: string }): Promise<void> {
    const response = await this.fetchImplementation(
      `${this.baseUrl}/internal/assets/report-exports`,
      {
        method: 'POST',
        headers: serviceHeaders(this.serviceToken),
        body: JSON.stringify({
          objectKey: input.objectKey,
          contentBase64: Buffer.from(input.body, 'utf8').toString('base64'),
          contentType: 'text/csv; charset=utf-8',
          visibility: 'PRIVATE',
          expiresAt: input.expiresAt,
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    requireOk(response, 'private report asset write');
  }
}

export class HttpAuditSink implements AuditSink {
  constructor(
    private readonly baseUrl: string,
    private readonly serviceToken: string,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  async record(entry: Record<string, string>): Promise<void> {
    const response = await this.fetchImplementation(`${this.baseUrl}/internal/audit/events`, {
      method: 'POST',
      headers: serviceHeaders(this.serviceToken),
      body: JSON.stringify(entry),
      signal: AbortSignal.timeout(5_000),
    });
    requireOk(response, 'audit event write');
  }
}
