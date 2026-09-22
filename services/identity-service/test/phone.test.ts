import { describe, expect, it } from 'vitest';

import { Phone } from '../src/domain/phone.js';

describe('Phone', () => {
  it('normalizes a mainland number to E.164', () => {
    expect(Phone.parse('13800138000').e164).toBe('+8613800138000');
  });

  it('tolerates spaces and hyphens', () => {
    expect(Phone.parse('138 0013-8000').e164).toBe('+8613800138000');
  });

  it('rejects malformed numbers with a stable error code', () => {
    expect(() => Phone.parse('123')).toThrow('INVALID_PHONE');

    try {
      Phone.parse('123');
    } catch (error: unknown) {
      expect(error).toMatchObject({ code: 'INVALID_PHONE' });
    }
  });

  it('rejects an invalid mainland mobile prefix', () => {
    expect(() => Phone.parse('10000000000')).toThrow('INVALID_PHONE');
  });

  it('masks the middle four digits', () => {
    expect(Phone.parse('13800138000').masked()).toBe('+86138****8000');
  });
});
