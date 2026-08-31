import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createSafeLogger } from '../src/logger.js';

function captureLog(payload: Record<string, unknown>): string {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  const logger = createSafeLogger({
    service: 'reporting-service',
    environment: 'test',
    version: 'test',
    stream,
  });
  logger.info(payload, 'processed event');
  return chunks.join('');
}

describe('createSafeLogger', () => {
  it('recursively redacts secrets, phone numbers and callback signatures', () => {
    const output = captureLog({
      authorization: 'Bearer secret',
      phone: '13800138000',
      nested: {
        token: 'access-token',
        verificationCode: '123456',
        signature: 'wx-signature',
      },
      taskId: 'task-1',
    });

    expect(output).not.toContain('secret');
    expect(output).not.toContain('13800138000');
    expect(output).not.toContain('access-token');
    expect(output).not.toContain('123456');
    expect(output).not.toContain('wx-signature');
    expect(output).toContain('task-1');
    expect(output).toContain('reporting-service');
  });
});
