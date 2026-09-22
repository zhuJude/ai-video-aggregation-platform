import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('local compose', () => {
  it('contains postgres, redis, RocketMQ, minio and mailpit', async () => {
    const yaml = await readFile('infra/local/compose.yaml', 'utf8');
    for (const service of [
      'postgres:',
      'redis:',
      'rocketmq-namesrv:',
      'rocketmq-broker:',
      'minio:',
      'mailpit:',
    ]) {
      expect(yaml).toContain(service);
    }
  });

  it('declares every platform process in the services overlay', async () => {
    const yaml = await readFile('infra/local/compose.services.yaml', 'utf8');
    for (const service of [
      'user-web:',
      'admin-web:',
      'edge-gateway:',
      'identity-service:',
      'iam-service:',
      'catalog-service:',
      'quote-routing-service:',
      'wallet-service:',
      'payment-service:',
      'generation-service:',
      'provider-runtime:',
      'asset-service:',
      'notification-service:',
      'operations-service:',
      'reporting-service:',
      'mock-provider:',
    ]) {
      expect(yaml).toContain(service);
    }
    expect(yaml).toContain('condition: service_healthy');
  });
});
