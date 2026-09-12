import { beforeEach, describe, expect, it, vi } from 'vitest';

const refresh = vi.hoisted(() => vi.fn<() => Promise<boolean>>());

vi.mock('../lib/auth/client-session', () => ({ coordinateSessionRefresh: refresh }));

import { runCommerceActionWithRefresh } from '../lib/commerce/client-command';

describe('commerce command session recovery', () => {
  beforeEach(() => {
    refresh.mockReset();
  });

  it('refreshes then retries once with the same logical idempotency key', async () => {
    const keys: string[] = [];
    const key = '0198f4d4-21c2-7b7d-8a03-08a0da2a7901';
    const operation = vi.fn(() => {
      keys.push(key);
      return Promise.resolve(
        keys.length === 1
          ? ({ ok: false, outcome: 'SESSION_REFRESH_REQUIRED' } as const)
          : ({ ok: true, data: { accepted: true } } as const),
      );
    });
    refresh.mockResolvedValue(true);

    await expect(runCommerceActionWithRefresh(operation)).resolves.toEqual({
      ok: true,
      data: { accepted: true },
    });
    expect(keys).toEqual([key, key]);
    expect(operation).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('returns an explicit login-required outcome when refresh fails without retrying', async () => {
    const operation = vi
      .fn()
      .mockResolvedValue({ ok: false, outcome: 'SESSION_REFRESH_REQUIRED' } as const);
    refresh.mockResolvedValue(false);

    await expect(runCommerceActionWithRefresh(operation)).resolves.toEqual({
      ok: false,
      outcome: 'LOGIN_REQUIRED',
    });
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
