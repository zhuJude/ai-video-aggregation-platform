import { describe, expect, it } from 'vitest';
import { CreateTaskCommandSchema, TaskStatusSchema } from '../src/generation/index.js';
import { LedgerCommandSchema } from '../src/wallet/index.js';

describe('domain contracts', () => {
  it('parses a task command with a pricing snapshot', () => {
    expect(
      CreateTaskCommandSchema.parse({
        userId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a2',
        quoteId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a3',
        capabilityVersionId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a4',
        parameters: { prompt: 'ocean at dusk' },
        quotedPoints: '1200',
      }).quotedPoints,
    ).toBe('1200');
    expect(TaskStatusSchema.parse('RUNNING')).toBe('RUNNING');
  });

  it('requires a unique business key for ledger commands', () => {
    expect(
      LedgerCommandSchema.parse({
        businessKey: 'task:0198:reserve',
        userId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a2',
        kind: 'RESERVE',
        points: '1200',
      }).kind,
    ).toBe('RESERVE');
  });
});
