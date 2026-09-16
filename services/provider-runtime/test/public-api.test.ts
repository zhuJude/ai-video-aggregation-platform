import { describe, expect, it } from 'vitest';
import {
  PrismaExecutionRepository,
  PrismaCallbackRepository,
  PrismaCircuitRepository,
  PrismaPollRepository,
  ProviderExecutionService,
  backoffMs,
  classifyHttpFailure,
  createPrismaExecutionRepository,
  createPrismaLifecycleRepositories,
} from '../src/index.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';

function acceptsGeneratedClient(client: PrismaClient): PrismaExecutionRepository {
  return createPrismaExecutionRepository(client);
}

describe('provider-runtime public API', () => {
  it('exports the execution service, durable repository and retry policy', () => {
    expect(ProviderExecutionService).toBeTypeOf('function');
    expect(PrismaExecutionRepository).toBeTypeOf('function');
    expect(createPrismaExecutionRepository).toBeTypeOf('function');
    expect(PrismaCallbackRepository).toBeTypeOf('function');
    expect(PrismaPollRepository).toBeTypeOf('function');
    expect(PrismaCircuitRepository).toBeTypeOf('function');
    expect(createPrismaLifecycleRepositories).toBeTypeOf('function');
    expect(acceptsGeneratedClient).toBeTypeOf('function');
    expect(classifyHttpFailure(429).code).toBe('PROVIDER_RATE_LIMITED');
    expect(backoffMs({ attempt: 20, jitterKey: 'public-api' })).toBe(300_000);
  });
});
