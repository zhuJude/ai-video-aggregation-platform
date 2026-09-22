import 'server-only';

import type { AppShellUser } from '../components/app-shell';
import { accountGateway } from './account/gateway';
import { maskPhone, parseProfile } from './account/runtime';
import {
  authenticatedGatewayFetch,
  readAuthenticatedServerSessionState,
  requireMutableAuthenticatedServerSessionIdentity,
} from './auth/server-session';
import { commerceGateway } from './commerce/gateway';
import { parseWalletPage } from './commerce/runtime';

type Identity = Awaited<ReturnType<typeof requireMutableAuthenticatedServerSessionIdentity>>;

async function liveJson(path: `/v1/${string}`): Promise<unknown> {
  const response = await authenticatedGatewayFetch(path, { handshakeTimeoutMs: 3_000 });
  if (!response.ok || !response.headers.get('content-type')?.startsWith('application/json')) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('WORKSPACE_SHELL_GATEWAY_UNAVAILABLE');
  }
  return response.json() as Promise<unknown>;
}

async function profileNickname(identity: Identity): Promise<string> {
  const value =
    process.env.USER_WEB_SUPPORT_MODE === 'mock'
      ? await accountGateway.getProfile({
          ownerId: identity.ownerId,
          currentSessionId: identity.sessionId,
          verifiedPhone: identity.verifiedPhone,
        })
      : await liveJson('/v1/profile');
  return parseProfile(value).nickname;
}

async function walletSummary(
  identity: Identity,
): Promise<Pick<AppShellUser, 'points' | 'frozenPoints'>> {
  const value =
    process.env.USER_WEB_COMMERCE_MODE === 'mock'
      ? await commerceGateway.getWallet({}, { ownerId: identity.ownerId })
      : await liveJson('/v1/wallet');
  const wallet = parseWalletPage(value);
  return { points: wallet.balance.available, frozenPoints: wallet.balance.frozen };
}

export async function readWorkspaceShellUser(): Promise<AppShellUser | null> {
  const state = await readAuthenticatedServerSessionState();
  if (state.kind === 'invalid') return null;
  if (state.kind === 'needs-refresh') return { nickname: '正在恢复会话' };

  let identity: Identity;
  try {
    identity = await requireMutableAuthenticatedServerSessionIdentity();
  } catch {
    return { nickname: '已登录用户' };
  }

  const [profile, wallet] = await Promise.allSettled([
    profileNickname(identity),
    walletSummary(identity),
  ]);
  return {
    nickname: profile.status === 'fulfilled' ? profile.value : maskPhone(identity.verifiedPhone),
    ...(wallet.status === 'fulfilled' ? wallet.value : {}),
  };
}
