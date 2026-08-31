/* eslint-disable @typescript-eslint/require-await -- async fakes implement port contracts. */

import { describe, expect, it } from 'vitest';

import {
  type ResourceScopePort,
  type UserOperationPort,
  createRefreshUserAction,
} from '../lib/protected-user-action';
import { signAdminSession } from '../lib/session-auth';

const signingKey = 'protected-action-signing-key-at-least-32-bytes';

async function authorizedSession(): Promise<string> {
  return signAdminSession(
    {
      subjectId: 'admin-1',
      permissions: ['users:refresh'],
      dataScope: 'ALL',
      expiresAt: Date.now() + 60_000,
    },
    signingKey,
  );
}

function refreshForm(): FormData {
  const formData = new FormData();
  formData.set('userId', 'user-9');
  return formData;
}

describe('protected refresh user action', () => {
  it('passes the trusted server-read session token to the atomic operation', async () => {
    const trustedSessionToken = await authorizedSession();
    let operationInput: unknown;
    const scopePort: ResourceScopePort = {
      async getUserScope() {
        return { ownerAdminId: null, assignedAdminIds: [] };
      },
    };
    const operationPort: UserOperationPort = {
      async refreshUser(input) {
        operationInput = input;
      },
    };
    const action = createRefreshUserAction({
      scopePort,
      operationPort,
      guardContext: { sessionToken: trustedSessionToken, signingKey },
    });

    await action(refreshForm());

    expect(operationInput).toEqual({ userId: 'user-9', trustedSessionToken });
  });

  it('never calls the authoritative operation when the local guard denies', async () => {
    let operationCalls = 0;
    const action = createRefreshUserAction({
      scopePort: {
        async getUserScope() {
          return { ownerAdminId: null, assignedAdminIds: [] };
        },
      },
      operationPort: {
        async refreshUser() {
          operationCalls += 1;
        },
      },
      guardContext: { sessionToken: undefined, signingKey },
    });

    await expect(action(refreshForm())).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    expect(operationCalls).toBe(0);
  });

  it('fails closed when the authoritative downstream mutation denies', async () => {
    const trustedSessionToken = await authorizedSession();
    const action = createRefreshUserAction({
      scopePort: {
        async getUserScope() {
          return { ownerAdminId: null, assignedAdminIds: [] };
        },
      },
      operationPort: {
        async refreshUser() {
          throw new Error('authoritative denial');
        },
      },
      guardContext: { sessionToken: trustedSessionToken, signingKey },
    });

    await expect(action(refreshForm())).rejects.toThrow('authoritative denial');
  });
});
