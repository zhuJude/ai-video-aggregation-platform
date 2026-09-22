import type { FeedbackSubjectAuthorizationPort } from '../application/ticket.service.js';
import type { WorkloadIdentityToken } from './asset-authorization.gateway.js';
import { AssetDependencyError } from './asset-authorization.gateway.js';

export class HttpGenerationAuthorizationGateway implements FeedbackSubjectAuthorizationPort {
  constructor(
    private readonly base: URL,
    private readonly token: WorkloadIdentityToken,
    private readonly timeoutMs = 2_000,
  ) {
    if (base.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(base.hostname))
      throw new Error('INSECURE_GENERATION_SERVICE_URL');
  }
  async assertTaskOwned(taskId: string, userId: string): Promise<void> {
    const response = await this.request('/internal/tasks/assert-owner', 'POST', { taskId, userId });
    if (!response.ok)
      throw new AssetDependencyError(
        response.status === 403 || response.status === 404
          ? 'FEEDBACK_SUBJECT_NOT_AUTHORIZED'
          : 'GENERATION_SERVICE_UNAVAILABLE',
        response.status >= 500 || response.status === 429,
      );
  }
  async ping(): Promise<void> {
    const response = await this.request('/health/live', 'GET');
    if (!response.ok) throw new AssetDependencyError('GENERATION_SERVICE_UNAVAILABLE', true);
  }
  private async request(path: string, method: 'GET' | 'POST', body?: unknown): Promise<Response> {
    try {
      return await fetch(new URL(path, this.base), {
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
      throw new AssetDependencyError('GENERATION_SERVICE_UNAVAILABLE', true);
    }
  }
}
