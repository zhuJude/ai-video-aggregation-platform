import { describe, expect, it } from 'vitest';
import { PublicationService } from '../src/application/publication.service.js';
import { OperationsOutboxDispatcher, OperationsOutboxJob } from '../src/adapters/operations-outbox.dispatcher.js';
import { OperationsHttpModule } from '../src/http/operations-http.module.js';
import { createOperationsSupportingServices } from '../src/application/operations-service.factory.js';

describe('production operations composition', () => {
  it('wires Prisma publication/outbox, verified admin auth and HTTP controllers', () => {
    const result = createOperationsSupportingServices({
      prisma: { $transaction: () => Promise.reject(new Error('not called during composition')) } as never,
      eventPublisher: { publish: () => Promise.resolve() },
      adminTokenVerifier: { verify: () => Promise.reject(new Error('not called during composition')) },
      auth: { issuer: 'https://identity.internal', audience: 'operations-service' },
      trustedIframeOrigins: ['https://media.example.cn'],
    });
    expect(result.publication).toBeInstanceOf(PublicationService);
    expect(result.outbox).toBeInstanceOf(OperationsOutboxDispatcher);
    expect(result.http).toBeInstanceOf(OperationsHttpModule);
    expect(result.outboxJob).toBeInstanceOf(OperationsOutboxJob);
  });
});
