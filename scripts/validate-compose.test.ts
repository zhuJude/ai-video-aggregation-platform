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
});
