import { describe, expect, it } from 'vitest';

import { domainFormData } from '../lib/server-action-form';

describe('server action form boundary', () => {
  it('removes React action metadata while preserving domain fields and values', () => {
    const form = new FormData();
    form.set('$ACTION_ID_example', 'opaque');
    form.set('confirmed', 'true');
    form.append('permission', 'finance:read');
    form.append('permission', 'finance:write');

    const result = domainFormData(form);

    expect([...result.entries()]).toEqual([
      ['confirmed', 'true'],
      ['permission', 'finance:read'],
      ['permission', 'finance:write'],
    ]);
  });
});
