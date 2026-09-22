/* eslint-disable @typescript-eslint/require-await -- async test doubles implement promise-returning ports. */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AdjustmentDialog } from '../components/adjustment-dialog';
import { signAdminSession } from '../lib/session-auth';
import {
  type WalletAdjustmentRequestPort,
  createWalletAdjustmentPreviewAction,
} from '../lib/user-operation-actions';
import { isUuidV7 } from '../lib/uuid-v7';

const actorId = '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f';
const approverId = '0198f7a4-c6d3-7b39-8a4e-73af0c1d2e3f';
const userId = '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f';
const hugePoints = '900719925474099312345678901234567890';
const previewIntentId = '0198f7a4-c6d5-7b39-8a4e-73af0c1d2e3f';
const expiresAt = new Date(Date.now() + 60_000).toISOString();

const preview = {
  after: '900719925474099312345678901234567990',
  before: '100',
  direction: 'CREDIT' as const,
  expiresAt,
  impact: 'ledger',
  points: hugePoints,
  policy: 'two-person',
  previewToken: 'pv_abcdefghijklmnopqrstuvwxyz123456',
};

function fillBoundInputs() {
  fireEvent.change(screen.getByLabelText('调整方向'), { target: { value: 'CREDIT' } });
  fireEvent.change(screen.getByLabelText('调整点数'), { target: { value: hugePoints } });
  fireEvent.change(screen.getByLabelText('调整原因'), { target: { value: '人工补偿' } });
  fireEvent.change(screen.getByLabelText('复核人'), { target: { value: approverId } });
}

describe('frozen points adjustment and preview intent', () => {
  it.each([' 1', '1 ', '\t1'])(
    'rejects noncanonical whitespace-wrapped points at the server action boundary: %j',
    async (points) => {
      const signingKey = 'preview-points-signing-key-at-least-32-bytes';
      const sessionToken = await signAdminSession(
        {
          dataScope: 'ALL',
          expiresAt: Date.now() + 60_000,
          permissions: ['wallet:adjust'],
          subjectId: actorId,
          sessionInstanceId: '0198f7a4-c6da-7b39-8a4e-73af0c1d2e3f',
        },
        signingKey,
      );
      let previews = 0;
      const port: WalletAdjustmentRequestPort = {
        async getEligibleApprovers() {
          return [{ displayName: '复核管理员', id: approverId }];
        },
        async previewAdjustment() {
          previews += 1;
          return preview;
        },
        async submitAdjustmentRequest() {
          throw new Error('not used');
        },
      };
      const form = new FormData();
      form.set('userId', userId);
      form.set('direction', 'CREDIT');
      form.set('points', points);
      form.set('reason', '人工补偿');
      form.set('approverId', approverId);
      form.set('previewIntentId', previewIntentId);

      await expect(
        createWalletAdjustmentPreviewAction({
          adjustmentPort: port,
          guardContext: { sessionToken, signingKey },
          scopePort: {
            async getUserScope() {
              return { assignedAdminIds: [], ownerAdminId: null };
            },
          },
        })(form),
      ).rejects.toThrow('调整点数格式无效');
      expect(previews).toBe(0);
    },
  );

  it('rejects a whitespace-normalized preview intent instead of silently changing the idempotency key', async () => {
    const signingKey = 'preview-points-signing-key-at-least-32-bytes';
    const sessionToken = await signAdminSession(
      {
        dataScope: 'ALL',
        expiresAt: Date.now() + 60_000,
        permissions: ['wallet:adjust'],
        subjectId: actorId,
        sessionInstanceId: '0198f7a4-c6da-7b39-8a4e-73af0c1d2e3f',
      },
      signingKey,
    );
    let previews = 0;
    const port: WalletAdjustmentRequestPort = {
      async getEligibleApprovers() {
        return [{ displayName: '复核管理员', id: approverId }];
      },
      async previewAdjustment() {
        previews += 1;
        return preview;
      },
      async submitAdjustmentRequest() {
        throw new Error('not used');
      },
    };
    const form = new FormData();
    form.set('userId', userId);
    form.set('direction', 'CREDIT');
    form.set('points', '1');
    form.set('reason', '人工补偿');
    form.set('approverId', approverId);
    form.set('previewIntentId', ` ${previewIntentId}`);

    await expect(
      createWalletAdjustmentPreviewAction({
        adjustmentPort: port,
        guardContext: { sessionToken, signingKey },
        scopePort: {
          async getUserScope() {
            return { assignedAdminIds: [], ownerAdminId: null };
          },
        },
      })(form),
    ).rejects.toThrow('预览审计上下文无效');
    expect(previews).toBe(0);
  });

  it('suppresses preview double clicks while pending and rotates intent only after bound input changes', async () => {
    const forms: FormData[] = [];
    let resolvePreview: ((value: typeof preview) => void) | undefined;
    render(
      <AdjustmentDialog
        currentActorId={actorId}
        eligibleApprovers={[{ displayName: '复核管理员', id: approverId }]}
        userId={userId}
        onPreview={(form) => {
          forms.push(form);
          return new Promise((resolve) => {
            resolvePreview = resolve;
          });
        }}
        onRequest={async () => ({
          auditRecordId: '0198f7a4-c6d7-7b39-8a4e-73af0c1d2e3f',
          ok: true,
          requestId: '0198f7a4-c6d8-7b39-8a4e-73af0c1d2e3f',
          status: 'PENDING_APPROVAL',
        })}
      />,
    );
    fillBoundInputs();
    const button = screen.getByRole('button', { name: '获取权威预览' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(forms).toHaveLength(1);
    expect(button).toBeDisabled();
    const firstIntent = forms[0]?.get('previewIntentId');
    expect(isUuidV7(firstIntent)).toBe(true);
    resolvePreview?.(preview);
    await screen.findByText(/CREDIT/u);
    fireEvent.change(screen.getByLabelText('调整点数'), { target: { value: '2' } });
    fireEvent.click(button);
    await waitFor(() => {
      expect(forms).toHaveLength(2);
    });
    expect(forms[1]?.get('previewIntentId')).not.toBe(firstIntent);
  });

  it('reuses the same preview intent after a timeout retry', async () => {
    const forms: FormData[] = [];
    render(
      <AdjustmentDialog
        currentActorId={actorId}
        eligibleApprovers={[{ displayName: '复核管理员', id: approverId }]}
        userId={userId}
        onPreview={async (form) => {
          forms.push(form);
          if (forms.length === 1) throw new Error('timeout');
          return preview;
        }}
        onRequest={async () => ({
          auditRecordId: '0198f7a4-c6d7-7b39-8a4e-73af0c1d2e3f',
          ok: true,
          requestId: '0198f7a4-c6d8-7b39-8a4e-73af0c1d2e3f',
          status: 'PENDING_APPROVAL',
        })}
      />,
    );
    fillBoundInputs();
    const button = screen.getByRole('button', { name: '获取权威预览' });
    fireEvent.click(button);
    await screen.findByText('权威预览不可用或已被拒绝');
    fireEvent.click(button);
    await screen.findByText(/CREDIT/u);
    expect(forms).toHaveLength(2);
    expect(forms[1]?.get('previewIntentId')).toBe(forms[0]?.get('previewIntentId'));
  });

  it('invalidates an in-flight preview when its bound user changes and rotates the preview intent', async () => {
    const otherUserId = '0198f7a4-c6d9-7b39-8a4e-73af0c1d2e3f';
    const forms: FormData[] = [];
    const resolvers: Array<(value: typeof preview) => void> = [];
    const onPreview = (form: FormData) => {
      forms.push(form);
      return new Promise<typeof preview>((resolve) => {
        resolvers.push(resolve);
      });
    };
    const onRequest = async () => ({
      auditRecordId: '0198f7a4-c6d7-7b39-8a4e-73af0c1d2e3f',
      ok: true as const,
      requestId: '0198f7a4-c6d8-7b39-8a4e-73af0c1d2e3f',
      status: 'PENDING_APPROVAL' as const,
    });
    const approvers = [{ displayName: '复核管理员', id: approverId }] as const;
    const { rerender } = render(
      <AdjustmentDialog
        currentActorId={actorId}
        eligibleApprovers={approvers}
        userId={userId}
        onPreview={onPreview}
        onRequest={onRequest}
      />,
    );
    fillBoundInputs();
    const button = screen.getByRole('button', { name: '获取权威预览' });
    fireEvent.click(button);
    expect(forms).toHaveLength(1);
    const firstIntent = forms[0]?.get('previewIntentId');

    rerender(
      <AdjustmentDialog
        currentActorId={actorId}
        eligibleApprovers={approvers}
        userId={otherUserId}
        onPreview={onPreview}
        onRequest={onRequest}
      />,
    );
    resolvers[0]?.(preview);
    await waitFor(() => {
      expect(button).not.toBeDisabled();
    });
    expect(screen.queryByText(/调整前：/u)).not.toBeInTheDocument();
    fireEvent.click(button);
    await waitFor(() => {
      expect(forms).toHaveLength(2);
    });
    expect(forms[1]?.get('userId')).toBe(otherUserId);
    expect(forms[1]?.get('previewIntentId')).not.toBe(firstIntent);
    resolvers[1]?.(preview);
  });

  it('forwards exact huge integer points, direction, UUIDv7 preview intent, and a separate trace', async () => {
    const signingKey = 'preview-points-signing-key-at-least-32-bytes';
    const sessionToken = await signAdminSession(
      {
        dataScope: 'ALL',
        expiresAt: Date.now() + 60_000,
        permissions: ['wallet:adjust'],
        subjectId: actorId,
        sessionInstanceId: '0198f7a4-c6da-7b39-8a4e-73af0c1d2e3f',
      },
      signingKey,
    );
    let received: unknown;
    let receivedEligible: unknown;
    let receivedScope: unknown;
    const port: WalletAdjustmentRequestPort = {
      async getEligibleApprovers(input) {
        receivedEligible = input;
        return [{ displayName: '复核管理员', id: approverId }];
      },
      async previewAdjustment(input) {
        received = input;
        return preview;
      },
      async submitAdjustmentRequest() {
        throw new Error('not used');
      },
    };
    const form = new FormData();
    form.set('userId', userId);
    form.set('direction', 'CREDIT');
    form.set('points', hugePoints);
    form.set('reason', '人工补偿');
    form.set('approverId', approverId);
    form.set('previewIntentId', previewIntentId);

    await expect(
      createWalletAdjustmentPreviewAction({
        adjustmentPort: port,
        createCorrelationId: () => '0198f7a4-c6d9-7b39-8a4e-73af0c1d2e3f',
        createTraceId: () => '00112233445566778899aabbccddeeff',
        guardContext: { sessionToken, signingKey },
        scopePort: {
          async getUserScope(input) {
            receivedScope = input;
            return { assignedAdminIds: [], ownerAdminId: null };
          },
        },
      })(form),
    ).resolves.toMatchObject(preview);
    expect(received).toMatchObject({
      audit: { idempotencyKey: previewIntentId },
      direction: 'CREDIT',
      points: BigInt(hugePoints),
      requestContext: {
        correlationId: '0198f7a4-c6d9-7b39-8a4e-73af0c1d2e3f',
        traceId: '00112233445566778899aabbccddeeff',
      },
      trustedSessionToken: sessionToken,
    });
    expect(receivedEligible).toMatchObject({
      requestContext: {
        correlationId: '0198f7a4-c6d9-7b39-8a4e-73af0c1d2e3f',
        traceId: '00112233445566778899aabbccddeeff',
      },
    });
    expect(receivedScope).toMatchObject({
      requestContext: {
        correlationId: '0198f7a4-c6d9-7b39-8a4e-73af0c1d2e3f',
        traceId: '00112233445566778899aabbccddeeff',
      },
    });
    expect(received).not.toHaveProperty('amountMinor');
  });

  it.each([
    [
      'credit mismatch',
      { after: '109', before: '100', direction: 'CREDIT' as const, points: '10' },
    ],
    ['debit mismatch', { after: '91', before: '100', direction: 'DEBIT' as const, points: '10' }],
    ['debit underflow', { after: '0', before: '5', direction: 'DEBIT' as const, points: '10' }],
  ])(
    'rejects semantically incoherent preview at the server action boundary: %s',
    async (_name, values) => {
      const signingKey = 'preview-points-signing-key-at-least-32-bytes';
      const sessionToken = await signAdminSession(
        {
          dataScope: 'ALL',
          expiresAt: Date.now() + 60_000,
          permissions: ['wallet:adjust'],
          subjectId: actorId,
          sessionInstanceId: '0198f7a4-c6da-7b39-8a4e-73af0c1d2e3f',
        },
        signingKey,
      );
      const port: WalletAdjustmentRequestPort = {
        async getEligibleApprovers() {
          return [{ displayName: '复核管理员', id: approverId }];
        },
        async previewAdjustment() {
          return {
            ...values,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            impact: 'ledger',
            policy: 'two-person',
            previewToken: 'pv_abcdefghijklmnopqrstuvwxyz123456',
          };
        },
        async submitAdjustmentRequest() {
          throw new Error('not used');
        },
      };
      const form = new FormData();
      form.set('userId', userId);
      form.set('direction', values.direction);
      form.set('points', values.points);
      form.set('reason', '人工补偿');
      form.set('approverId', approverId);
      form.set('previewIntentId', previewIntentId);
      await expect(
        createWalletAdjustmentPreviewAction({
          adjustmentPort: port,
          guardContext: { sessionToken, signingKey },
          scopePort: {
            async getUserScope() {
              return { assignedAdminIds: [], ownerAdminId: null };
            },
          },
        })(form),
      ).rejects.toThrow('调整预览无效');
    },
  );
});
