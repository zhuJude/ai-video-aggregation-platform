import { type Readable } from 'node:stream';
import { PublicApiError } from '@repo/service-kit';
import { Agent, request as undiciRequest } from 'undici';
import type { ServiceClient, ServiceRequestContext } from '../clients/service-client.js';
import type { TaskOwnershipVerifier, TaskStreamSource } from '../routes/task-events.route.js';

export class GenerationTaskOwnership implements TaskOwnershipVerifier {
  constructor(private readonly generation: Pick<ServiceClient, 'request'>) {}

  async isOwned(
    taskId: string,
    _userId: string,
    context?: ServiceRequestContext,
  ): Promise<boolean> {
    if (context === undefined) return false;
    const result = await this.generation.request<{ owned: boolean }>({
      context,
      method: 'GET',
      path: `/internal/v1/tasks/${encodeURIComponent(taskId)}/ownership`,
    });
    return result.owned;
  }
}

export class GenerationTaskStreamSource implements TaskStreamSource {
  private readonly baseUrl: URL;
  private readonly dispatcher = new Agent({ connectTimeout: 500 });

  constructor(baseUrl: string) {
    this.baseUrl = new URL(baseUrl);
  }

  async open(input: {
    context: ServiceRequestContext | undefined;
    lastEventId: string | undefined;
    signal: AbortSignal;
    taskId: string;
  }): Promise<Readable> {
    if (input.context === undefined) {
      throw new PublicApiError('UPSTREAM_UNAVAILABLE', '依赖服务暂时不可用', true);
    }
    const response = await undiciRequest(
      new URL(`/internal/v1/tasks/${encodeURIComponent(input.taskId)}/events`, this.baseUrl),
      {
        bodyTimeout: 0,
        dispatcher: this.dispatcher,
        headers: {
          accept: 'text/event-stream',
          authorization: `Bearer ${input.context.subjectAssertion}`,
          ...(input.lastEventId === undefined ? {} : { 'last-event-id': input.lastEventId }),
          'x-correlation-id': input.context.correlationId,
          'x-trace-id': input.context.traceId,
        },
        headersTimeout: 2_000,
        method: 'GET',
        signal: input.signal,
      },
    );
    if (response.statusCode !== 200) {
      await response.body.dump();
      throw new PublicApiError('UPSTREAM_ERROR', '依赖服务返回错误', true);
    }
    return response.body;
  }

  close(): Promise<void> {
    return this.dispatcher.destroy();
  }
}
