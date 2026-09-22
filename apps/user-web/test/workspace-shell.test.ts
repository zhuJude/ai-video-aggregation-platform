import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const readState = vi.hoisted(() => vi.fn());
const requireIdentity = vi.hoisted(() => vi.fn());
const authenticatedFetch = vi.hoisted(() => vi.fn());
const getProfile = vi.hoisted(() => vi.fn());
const getWallet = vi.hoisted(() => vi.fn());

vi.mock('../lib/auth/server-session', () => ({
  authenticatedGatewayFetch: authenticatedFetch,
  readAuthenticatedServerSessionState: readState,
  requireMutableAuthenticatedServerSessionIdentity: requireIdentity,
}));
vi.mock('../lib/account/gateway', () => ({ accountGateway: { getProfile } }));
vi.mock('../lib/commerce/gateway', () => ({ commerceGateway: { getWallet } }));

import { readWorkspaceShellUser } from '../lib/workspace-shell';

const originalModes = {
  commerce: process.env.USER_WEB_COMMERCE_MODE,
  support: process.env.USER_WEB_SUPPORT_MODE,
};
const identity = {
  ownerId: '0198f4d4-21c2-7b7d-8a03-08a0da2a7401',
  sessionId: '0198f4d4-21c2-7b7d-8a03-08a0da2a7402',
  verifiedPhone: '+8613800138000',
};

beforeEach(() => {
  vi.clearAllMocks();
  requireIdentity.mockResolvedValue(identity);
});

afterEach(() => {
  if (originalModes.commerce === undefined) delete process.env.USER_WEB_COMMERCE_MODE;
  else process.env.USER_WEB_COMMERCE_MODE = originalModes.commerce;
  if (originalModes.support === undefined) delete process.env.USER_WEB_SUPPORT_MODE;
  else process.env.USER_WEB_SUPPORT_MODE = originalModes.support;
});

describe('workspace shell server data', () => {
  it('keeps invalid sessions signed out and refreshable sessions visibly authenticated', async () => {
    readState.mockResolvedValueOnce({ kind: 'invalid' });
    await expect(readWorkspaceShellUser()).resolves.toBeNull();
    expect(requireIdentity).not.toHaveBeenCalled();

    readState.mockResolvedValueOnce({ kind: 'needs-refresh' });
    await expect(readWorkspaceShellUser()).resolves.toEqual({ nickname: '正在恢复会话' });
    expect(requireIdentity).not.toHaveBeenCalled();
  });

  it('reads profile and wallet from the same authenticated mock owner', async () => {
    process.env.USER_WEB_SUPPORT_MODE = 'mock';
    process.env.USER_WEB_COMMERCE_MODE = 'mock';
    readState.mockResolvedValue({ kind: 'active', session: { ownerId: identity.ownerId } });
    getProfile.mockResolvedValue({
      nickname: '小林',
      phoneMasked: '138****8000',
      avatarPreset: 'AMBER',
      updatedAt: '2026-09-13T00:00:00.000Z',
    });
    getWallet.mockResolvedValue({
      balance: {
        available: '9007199254740993',
        frozen: '80',
        totalRecharged: '9007199254741073',
        totalConsumed: '0',
      },
      transactions: [],
      pageInfo: {},
    });

    await expect(readWorkspaceShellUser()).resolves.toEqual({
      nickname: '小林',
      points: '9007199254740993',
      frozenPoints: '80',
    });
    expect(getProfile).toHaveBeenCalledWith(expect.objectContaining({ ownerId: identity.ownerId }));
    expect(getWallet).toHaveBeenCalledWith({}, { ownerId: identity.ownerId });
  });

  it('keeps a live authenticated identity visible when wallet data fails closed', async () => {
    delete process.env.USER_WEB_SUPPORT_MODE;
    delete process.env.USER_WEB_COMMERCE_MODE;
    readState.mockResolvedValue({ kind: 'active', session: { ownerId: identity.ownerId } });
    authenticatedFetch.mockImplementation((path: string) => {
      if (path === '/v1/profile') {
        return Promise.resolve(
          Response.json({
            nickname: '远程创作者',
            phoneMasked: '138****8000',
            avatarPreset: 'BLUE',
            updatedAt: '2026-09-13T00:00:00.000Z',
          }),
        );
      }
      return Promise.resolve(new Response(null, { status: 503 }));
    });

    await expect(readWorkspaceShellUser()).resolves.toEqual({ nickname: '远程创作者' });
  });
});
