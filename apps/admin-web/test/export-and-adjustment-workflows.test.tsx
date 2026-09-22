/* eslint-disable @typescript-eslint/require-await -- async fakes model protected ports. */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AdjustmentDialog } from '../components/adjustment-dialog';
import { CsvExportForm } from '../components/csv-export-form';
import {
  createUserCsvExportAction,
  createWalletAdjustmentPreviewAction,
  createWalletAdjustmentRequestAction,
  type UserExportPort,
  type WalletAdjustmentRequestPort,
} from '../lib/user-operation-actions';
import { signAdminSession } from '../lib/session-auth';
import { isUuidV7 } from '../lib/uuid-v7';

const key = 'export-adjustment-workflow-signing-key-at-least-32-bytes';
const userId = '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f';
const actorId = '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f';
const approverId = '0198f7a4-c6d3-7b39-8a4e-73af0c1d2e3f';
const auditId = '0198f7a4-c6d4-7b39-8a4e-73af0c1d2e3f';
const requestId = '0198f7a4-c6d5-7b39-8a4e-73af0c1d2e3f';

async function token(permissions: readonly string[]): Promise<string> {
  return signAdminSession(
    {
      dataScope: 'ALL',
      expiresAt: Date.now() + 60_000,
      permissions,
      subjectId: actorId,
      sessionInstanceId: '0198f7a4-c6da-7b39-8a4e-73af0c1d2e3f',
    },
    key,
  );
}

describe('CSV export workflow', () => {
  it('fails closed before the port when a client export intent is missing or not UUIDv7', async () => {
    const sessionToken = await token(['users:export']);
    let calls = 0;
    const action = createUserCsvExportAction({
      exportPort: {
        async requestCsvExport() {
          calls += 1;
          return {
            auditRecordId: 'audit-1',
            downloadUrl: 'https://download.example.invalid/file',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          };
        },
      },
      guardContext: { sessionToken, signingKey: key },
    });
    const form = new FormData();
    form.set('reason', '合规核对');
    form.set('highRiskConfirmed', 'true');
    form.set('intentId', '550e8400-e29b-41d4-a716-446655440000');
    await expect(action(form)).rejects.toThrow('业务意图无效');
    expect(calls).toBe(0);
  });

  it('hides the export form when the server has not authorized export', () => {
    render(
      <CsvExportForm
        canExport={false}
        query="user"
        onExport={async () => ({
          auditRecordId: 'audit-1',
          downloadUrl: 'https://download.example.invalid/file',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          ok: true,
        })}
      />,
    );
    expect(screen.queryByRole('button', { name: '导出 CSV' })).not.toBeInTheDocument();
  });

  it('requires a reason and high-risk confirmation before exporting', () => {
    render(
      <CsvExportForm
        canExport
        query="user"
        onExport={async () => ({
          auditRecordId: 'audit-1',
          downloadUrl: 'https://download.example.invalid/file',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          ok: true,
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '导出 CSV' }));
    expect(screen.getByText('请填写导出原因')).toBeVisible();
  });

  it('renders the authoritative CSV audit record alongside the expiry and download', async () => {
    render(
      <CsvExportForm
        canExport
        query="user"
        onExport={async () => ({
          auditRecordId: 'audit-record-1',
          downloadUrl: 'https://download.example.invalid/file',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          ok: true,
        })}
      />,
    );
    fireEvent.change(screen.getByLabelText('导出原因'), { target: { value: '合规核对' } });
    fireEvent.click(screen.getByRole('checkbox', { name: '我确认这是高风险数据导出' }));
    fireEvent.click(screen.getByRole('button', { name: '导出 CSV' }));
    expect(await screen.findByText(/审计 audit-record-1/u)).toBeVisible();
  });

  it('preserves one signed search descriptor and one UUIDv7 intent across an exact-result export retry', async () => {
    const forms: FormData[] = [];
    let attempts = 0;
    const searchDescriptor = 'signed_descriptor_abcdefghijklmnopqrstuvwxyz1234567890';
    render(
      <CsvExportForm
        canExport
        searchDescriptor={searchDescriptor}
        onExport={async (form) => {
          forms.push(form);
          attempts += 1;
          if (attempts === 1) throw new Error('timeout');
          return {
            auditRecordId: 'audit-record-1',
            downloadUrl: 'https://download.example.invalid/file',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            ok: true,
          };
        }}
      />,
    );
    fireEvent.change(screen.getByLabelText('导出原因'), { target: { value: '合规核对' } });
    fireEvent.click(screen.getByRole('checkbox', { name: '我确认这是高风险数据导出' }));
    fireEvent.click(screen.getByRole('button', { name: '导出 CSV' }));
    await screen.findByText('导出申请被拒绝或暂时不可用');
    fireEvent.click(screen.getByRole('button', { name: '导出 CSV' }));
    await screen.findByText(/审计 audit-record-1/u);
    expect(forms[0]?.get('searchDescriptor')).toBe(searchDescriptor);
    expect(forms[0]?.get('searchHandle')).toBeNull();
    expect(forms[0]?.get('searchHandleExpiresAt')).toBeNull();
    expect(forms[0]?.get('phone')).toBeNull();
    expect(forms[0]?.get('query')).toBeNull();
    expect(forms[1]?.get('intentId')).toBe(forms[0]?.get('intentId'));
    expect(isUuidV7(forms[0]?.get('intentId'))).toBe(true);
  });

  it('coalesces a double click, disables pending, changes intent with input, and locks after success', async () => {
    let release!: (
      value: Readonly<{ auditRecordId: string; downloadUrl: string; expiresAt: string; ok: true }>,
    ) => void;
    const pending = new Promise<
      Readonly<{ auditRecordId: string; downloadUrl: string; expiresAt: string; ok: true }>
    >((resolve) => {
      release = resolve;
    });
    const forms: FormData[] = [];
    render(
      <CsvExportForm
        canExport
        query="user"
        onExport={async (form) => {
          forms.push(form);
          return pending;
        }}
      />,
    );
    fireEvent.change(screen.getByLabelText('导出原因'), { target: { value: '合规核对' } });
    fireEvent.click(screen.getByRole('checkbox', { name: '我确认这是高风险数据导出' }));
    const button = screen.getByRole('button', { name: '导出 CSV' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(forms).toHaveLength(1);
    const firstIntent = forms[0]?.get('intentId');
    release({
      auditRecordId: auditId,
      downloadUrl: 'https://download.example.invalid/file',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      ok: true,
    });
    await screen.findByText(new RegExp(auditId, 'u'));
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(forms).toHaveLength(1);
    expect(isUuidV7(firstIntent)).toBe(true);
  });

  it('creates a new CSV intent only when bound input changes', async () => {
    const forms: FormData[] = [];
    render(
      <CsvExportForm
        canExport
        query="user"
        onExport={async (form) => {
          forms.push(form);
          throw new Error('timeout');
        }}
      />,
    );
    fireEvent.change(screen.getByLabelText('导出原因'), { target: { value: '原因一' } });
    fireEvent.click(screen.getByRole('checkbox', { name: '我确认这是高风险数据导出' }));
    fireEvent.click(screen.getByRole('button', { name: '导出 CSV' }));
    await screen.findByText('导出申请被拒绝或暂时不可用');
    fireEvent.click(screen.getByRole('button', { name: '导出 CSV' }));
    await waitFor(() => {
      expect(forms).toHaveLength(2);
    });
    expect(forms[1]?.get('intentId')).toBe(forms[0]?.get('intentId'));
    fireEvent.change(screen.getByLabelText('导出原因'), { target: { value: '原因二' } });
    fireEvent.click(screen.getByRole('button', { name: '导出 CSV' }));
    await waitFor(() => {
      expect(forms).toHaveLength(3);
    });
    expect(forms[2]?.get('intentId')).not.toBe(forms[1]?.get('intentId'));
  });

  it('forwards trusted authorization and rejects an expired download descriptor', async () => {
    const received: unknown[] = [];
    const sessionToken = await token(['users:export']);
    const port: UserExportPort = {
      async requestCsvExport(input) {
        received.push(input);
        return {
          auditRecordId: auditId,
          downloadUrl: 'https://download.example.invalid/file',
          expiresAt: new Date(Date.now() - 1).toISOString(),
        };
      },
    };
    const action = createUserCsvExportAction({
      createTraceId: () => '00112233445566778899aabbccddeeff',
      exportPort: port,
      guardContext: { sessionToken, signingKey: key },
    });
    const form = new FormData();
    form.set('reason', '合规核对');
    form.set('highRiskConfirmed', 'true');
    form.set('intentId', '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f');
    await expect(action(form)).rejects.toThrow('导出下载凭证无效');
    expect(received[0]).toMatchObject({ trustedSessionToken: sessionToken });
  });

  it('rejects the legacy raw exact-phone export payload before the port', async () => {
    let calls = 0;
    const exportPort: UserExportPort = {
      async requestCsvExport() {
        calls += 1;
        return {
          auditRecordId: auditId,
          downloadUrl: 'https://download.example.invalid/file',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
      },
    };
    const form = new FormData();
    form.set('query', '13800138000');
    form.set('exactPhone', 'true');
    form.set('reason', '合规核对');
    form.set('highRiskConfirmed', 'true');
    form.set('intentId', requestId);
    await expect(
      createUserCsvExportAction({
        exportPort,
        guardContext: {
          sessionToken: await token(['users:export', 'users:phone-exact']),
          signingKey: key,
        },
      })(form),
    ).rejects.toThrow('精确手机号模式无效');
    expect(calls).toBe(0);
  });

  it.each([
    ['query', 'member-13800138000'],
    ['tag', '+86 138-0013-8000'],
    ['registrationSource', 'WEB-１３８００１３８０００'],
  ])('rejects a phone-like normal CSV %s before the export port', async (name, value) => {
    let calls = 0;
    const exportPort: UserExportPort = {
      async requestCsvExport() {
        calls += 1;
        return {
          auditRecordId: auditId,
          downloadUrl: 'https://download.example.invalid/file',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
      },
    };
    const form = new FormData();
    form.set(name, value);
    form.set('reason', '合规核对');
    form.set('highRiskConfirmed', 'true');
    form.set('intentId', requestId);
    await expect(
      createUserCsvExportAction({
        exportPort,
        guardContext: { sessionToken: await token(['users:export']), signingKey: key },
      })(form),
    ).rejects.toThrow('敏感查询');
    expect(calls).toBe(0);
  });

  it('rejects symbol-separated phones in CSV reasons and download URLs', async () => {
    let calls = 0;
    const base = new FormData();
    base.set('reason', '合规-138😀0013🚀8000');
    base.set('highRiskConfirmed', 'true');
    base.set('intentId', requestId);
    const action = createUserCsvExportAction({
      exportPort: {
        async requestCsvExport() {
          calls += 1;
          return {
            auditRecordId: auditId,
            downloadUrl: 'https://download.example.invalid/file',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          };
        },
      },
      guardContext: { sessionToken: await token(['users:export']), signingKey: key },
    });
    await expect(action(base)).rejects.toThrow();
    expect(calls).toBe(0);

    base.set('reason', '合规核对');
    const taintedUrlAction = createUserCsvExportAction({
      exportPort: {
        async requestCsvExport() {
          return {
            auditRecordId: auditId,
            downloadUrl: 'https://download.example.invalid/file-138😀0013🚀8000',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          };
        },
      },
      guardContext: { sessionToken: await token(['users:export']), signingKey: key },
    });
    await expect(taintedUrlAction(base)).rejects.toThrow('导出下载凭证无效');
  });

  it.each([`138\n0013\r8000`, `138\u00000013\ue0008000`, '138%0A0013%0D8000'])(
    'rejects control/private-use separated phone-like CSV input and authority: %s',
    async (phoneLike) => {
      let calls = 0;
      const form = new FormData();
      form.set('reason', `合规-${phoneLike}`);
      form.set('highRiskConfirmed', 'true');
      form.set('intentId', requestId);
      const action = createUserCsvExportAction({
        exportPort: {
          async requestCsvExport() {
            calls += 1;
            return {
              auditRecordId: auditId,
              downloadUrl: 'https://download.example.invalid/file',
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            };
          },
        },
        guardContext: { sessionToken: await token(['users:export']), signingKey: key },
      });
      await expect(action(form)).rejects.toThrow();
      expect(calls).toBe(0);

      form.set('reason', '合规核对');
      const tainted = createUserCsvExportAction({
        exportPort: {
          async requestCsvExport() {
            return {
              auditRecordId: auditId,
              downloadUrl: `https://download.example.invalid/file-${phoneLike}`,
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            };
          },
        },
        guardContext: { sessionToken: await token(['users:export']), signingKey: key },
      });
      await expect(tainted(form)).rejects.toThrow('导出下载凭证无效');
    },
  );
});

describe('wallet adjustment workflow', () => {
  it('rejects symbol-separated phones in adjustment reasons and preview authority', async () => {
    let previews = 0;
    const adjustmentPort: WalletAdjustmentRequestPort = {
      async getEligibleApprovers() {
        return [{ displayName: '复核管理员', id: approverId }];
      },
      async previewAdjustment() {
        previews += 1;
        return {
          after: '110',
          before: '100',
          direction: 'CREDIT',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          impact: 'ledger-138😀0013🚀8000',
          points: '10',
          policy: 'two-person',
          previewToken: 'preview-token-1234',
        };
      },
      async submitAdjustmentRequest() {
        throw new Error('not used');
      },
    };
    const form = new FormData();
    form.set('userId', userId);
    form.set('approverId', approverId);
    form.set('direction', 'CREDIT');
    form.set('points', '10');
    form.set('reason', `人工-1\u03003800138000`);
    form.set('previewIntentId', requestId);
    const action = createWalletAdjustmentPreviewAction({
      adjustmentPort,
      guardContext: { sessionToken: await token(['wallet:adjust']), signingKey: key },
      scopePort: {
        async getUserScope() {
          return { assignedAdminIds: [], ownerAdminId: null };
        },
      },
    });
    await expect(action(form)).rejects.toThrow();
    expect(previews).toBe(0);
    form.set('reason', '人工补偿');
    await expect(action(form)).rejects.toThrow('调整预览无效');
    expect(previews).toBe(1);
  });

  it.each([`138\n0013\r8000`, `138\u00000013\ue0008000`, `138\ud8000013\udfff8000`])(
    'rejects control/private-use separated phones in adjustment reason and preview: %s',
    async (phoneLike) => {
      let previews = 0;
      const form = new FormData();
      form.set('userId', userId);
      form.set('approverId', approverId);
      form.set('direction', 'CREDIT');
      form.set('points', '10');
      form.set('reason', `人工-${phoneLike}`);
      form.set('previewIntentId', requestId);
      const port: WalletAdjustmentRequestPort = {
        async getEligibleApprovers() {
          return [{ displayName: '复核管理员', id: approverId }];
        },
        async previewAdjustment() {
          previews += 1;
          return {
            after: '110',
            before: '100',
            direction: 'CREDIT',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            impact: `ledger-${phoneLike}`,
            points: '10',
            policy: 'two-person',
            previewToken: 'preview-token-1234',
          };
        },
        async submitAdjustmentRequest() {
          throw new Error('not used');
        },
      };
      const action = createWalletAdjustmentPreviewAction({
        adjustmentPort: port,
        guardContext: { sessionToken: await token(['wallet:adjust']), signingKey: key },
        scopePort: {
          async getUserScope() {
            return { assignedAdminIds: [], ownerAdminId: null };
          },
        },
      });
      await expect(action(form)).rejects.toThrow();
      expect(previews).toBe(0);
      form.set('reason', '人工补偿');
      await expect(action(form)).rejects.toThrow('调整预览无效');
      expect(previews).toBe(1);
    },
  );

  it.each([
    ['userId', ` ${userId}`],
    ['approverId', `${approverId} `],
    ['previewToken', ' preview-token-1234'],
    ['intentId', `${requestId} `],
  ])(
    'rejects whitespace-wrapped raw %s before any scope or adjustment port call',
    async (field, value) => {
      let portCalls = 0;
      let scopeCalls = 0;
      const adjustmentPort: WalletAdjustmentRequestPort = {
        async getEligibleApprovers() {
          portCalls += 1;
          return [{ displayName: '复核管理员', id: approverId }];
        },
        async submitAdjustmentRequest() {
          portCalls += 1;
          return { auditRecordId: auditId, requestId, status: 'PENDING_APPROVAL' };
        },
      };
      const form = new FormData();
      form.set('userId', userId);
      form.set('approverId', approverId);
      form.set('direction', 'CREDIT');
      form.set('points', '10');
      form.set('reason', ' 人工补偿 ');
      form.set('previewToken', 'preview-token-1234');
      form.set('highRiskConfirmed', 'true');
      form.set('intentId', requestId);
      form.set(field, value);
      const action = createWalletAdjustmentRequestAction({
        adjustmentPort,
        guardContext: { sessionToken: await token(['wallet:adjust']), signingKey: key },
        scopePort: {
          async getUserScope() {
            scopeCalls += 1;
            return { assignedAdminIds: [], ownerAdminId: null };
          },
        },
      });

      await expect(action(form)).rejects.toThrow();
      expect({ portCalls, scopeCalls }).toEqual({ portCalls: 0, scopeCalls: 0 });
    },
  );

  it('rejects a whitespace-wrapped preview intent before any scope or adjustment port call', async () => {
    let portCalls = 0;
    let scopeCalls = 0;
    const adjustmentPort: WalletAdjustmentRequestPort = {
      async getEligibleApprovers() {
        portCalls += 1;
        return [{ displayName: '复核管理员', id: approverId }];
      },
      async previewAdjustment() {
        portCalls += 1;
        return {
          after: '11',
          before: '1',
          direction: 'CREDIT',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          impact: 'ledger',
          points: '10',
          policy: 'two-person',
          previewToken: 'preview-token-1234',
        };
      },
      async submitAdjustmentRequest() {
        throw new Error('not used');
      },
    };
    const form = new FormData();
    form.set('userId', userId);
    form.set('approverId', approverId);
    form.set('direction', 'CREDIT');
    form.set('points', '10');
    form.set('reason', '人工补偿');
    form.set('previewIntentId', ` ${requestId}`);
    const action = createWalletAdjustmentPreviewAction({
      adjustmentPort,
      guardContext: { sessionToken: await token(['wallet:adjust']), signingKey: key },
      scopePort: {
        async getUserScope() {
          scopeCalls += 1;
          return { assignedAdminIds: [], ownerAdminId: null };
        },
      },
    });

    await expect(action(form)).rejects.toThrow('预览审计上下文无效');
    expect({ portCalls, scopeCalls }).toEqual({ portCalls: 0, scopeCalls: 0 });
  });

  it('requires an authoritative preview token and rejects self approval before request', async () => {
    let requests = 0;
    const port: WalletAdjustmentRequestPort = {
      async getEligibleApprovers() {
        return [{ displayName: '复核管理员', id: approverId }];
      },
      async previewAdjustment() {
        return {
          after: '110',
          before: '100',
          direction: 'CREDIT',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          impact: 'ledger',
          points: '10',
          policy: 'two-person',
          previewToken: 'preview-token-1234',
        };
      },
      async submitAdjustmentRequest() {
        requests += 1;
        return {
          auditRecordId: 'audit-1',
          requestId: 'request-1',
          status: 'PENDING_APPROVAL' as const,
        };
      },
    };
    const preview = createWalletAdjustmentPreviewAction({
      adjustmentPort: port,
      guardContext: { sessionToken: await token(['wallet:adjust']), signingKey: key },
      scopePort: {
        async getUserScope() {
          return { assignedAdminIds: [], ownerAdminId: null };
        },
      },
    });
    const form = new FormData();
    form.set('userId', userId);
    form.set('direction', 'CREDIT');
    form.set('points', '10');
    form.set('reason', '人工补偿');
    form.set('approverId', actorId);
    form.set('previewIntentId', requestId);
    await expect(preview(form)).rejects.toThrow('复核人无效');
    form.set('approverId', approverId);
    await expect(preview(form)).resolves.toMatchObject({ previewToken: 'preview-token-1234' });
    form.set('previewToken', 'tampered');
    form.set('highRiskConfirmed', 'true');
    const request = createWalletAdjustmentRequestAction({
      adjustmentPort: port,
      guardContext: { sessionToken: await token(['wallet:adjust']), signingKey: key },
      scopePort: {
        async getUserScope() {
          return { assignedAdminIds: [], ownerAdminId: null };
        },
      },
    });
    await expect(request(form)).rejects.toThrow('preview');
    expect(requests).toBe(0);
  });

  it('matches eligible UUIDv7 approvers case-insensitively without rewriting the submitted identifier', async () => {
    let submittedApprover = '';
    const port: WalletAdjustmentRequestPort = {
      async getEligibleApprovers() {
        return [{ displayName: '复核管理员', id: approverId }];
      },
      async previewAdjustment(input) {
        submittedApprover = input.approverId;
        return {
          after: '110',
          before: '100',
          direction: 'CREDIT',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          impact: 'ledger',
          points: '10',
          policy: 'two-person',
          previewToken: 'preview-token-1234',
        };
      },
      async submitAdjustmentRequest() {
        throw new Error('not used');
      },
    };
    const form = new FormData();
    form.set('userId', userId);
    form.set('direction', 'CREDIT');
    form.set('points', '10');
    form.set('reason', '人工补偿');
    form.set('approverId', approverId.toUpperCase());
    form.set('previewIntentId', requestId);
    await expect(
      createWalletAdjustmentPreviewAction({
        adjustmentPort: port,
        guardContext: { sessionToken: await token(['wallet:adjust']), signingKey: key },
        scopePort: {
          async getUserScope() {
            return { assignedAdminIds: [], ownerAdminId: null };
          },
        },
      })(form),
    ).resolves.toMatchObject({ previewToken: 'preview-token-1234' });
    expect(submittedApprover).toBe(approverId.toUpperCase());
  });

  it('re-fetches eligible approvers for preview and request and denies a stale selection', async () => {
    let lookups = 0;
    let previews = 0;
    let requests = 0;
    const port: WalletAdjustmentRequestPort = {
      async getEligibleApprovers() {
        lookups += 1;
        return lookups === 1 ? [{ displayName: '复核管理员', id: approverId }] : [];
      },
      async previewAdjustment() {
        previews += 1;
        return {
          after: '110',
          before: '100',
          direction: 'CREDIT',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          impact: 'ledger',
          points: '10',
          policy: 'two-person',
          previewToken: 'preview-token-1234',
        };
      },
      async submitAdjustmentRequest() {
        requests += 1;
        return { auditRecordId: auditId, requestId, status: 'PENDING_APPROVAL' };
      },
    };
    const context = { sessionToken: await token(['wallet:adjust']), signingKey: key };
    const scopePort = {
      async getUserScope() {
        return { assignedAdminIds: [], ownerAdminId: null };
      },
    };
    const form = new FormData();
    form.set('userId', userId);
    form.set('direction', 'CREDIT');
    form.set('points', '10');
    form.set('reason', '人工补偿');
    form.set('approverId', approverId);
    form.set('previewIntentId', requestId);
    const preview = await createWalletAdjustmentPreviewAction({
      adjustmentPort: port,
      guardContext: context,
      scopePort,
    })(form);
    form.set('previewToken', preview.previewToken);
    form.set('highRiskConfirmed', 'true');
    form.set('intentId', requestId);
    await expect(
      createWalletAdjustmentRequestAction({
        adjustmentPort: port,
        guardContext: context,
        scopePort,
      })(form),
    ).rejects.toThrow('复核人无效');
    expect({ lookups, previews, requests }).toEqual({ lookups: 2, previews: 1, requests: 0 });
  });

  it('keeps one adjustment intent across retry, suppresses double click, and locks success', async () => {
    const requests: FormData[] = [];
    let attempt = 0;
    render(
      <AdjustmentDialog
        currentActorId={actorId}
        eligibleApprovers={[{ displayName: '复核管理员', id: approverId }]}
        userId={userId}
        onPreview={async () => ({
          after: '110',
          before: '100',
          direction: 'CREDIT',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          impact: 'ledger',
          points: '10',
          policy: 'two-person',
          previewToken: 'pv_abcdefghijklmnopqrstuvwxyz123456',
        })}
        onRequest={async (form) => {
          requests.push(form);
          attempt += 1;
          if (attempt === 1) throw new Error('timeout');
          return { auditRecordId: auditId, ok: true, requestId, status: 'PENDING_APPROVAL' };
        }}
      />,
    );
    fireEvent.change(screen.getByLabelText('调整方向'), { target: { value: 'CREDIT' } });
    fireEvent.change(screen.getByLabelText('调整点数'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('调整原因'), { target: { value: '人工补偿' } });
    fireEvent.change(screen.getByLabelText('复核人'), { target: { value: approverId } });
    fireEvent.click(screen.getByRole('button', { name: '获取权威预览' }));
    await screen.findByText(/调整后/u);
    fireEvent.click(
      screen.getByRole('checkbox', { name: '我已核对影响范围，并确认提交双人审批申请' }),
    );
    const submit = screen.getByRole('button', { name: '提交申请' });
    fireEvent.click(submit);
    fireEvent.click(submit);
    await screen.findByText('调整申请被拒绝或暂时不可用');
    expect(requests).toHaveLength(1);
    fireEvent.click(submit);
    await screen.findByText(/申请待审批/u);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.get('intentId')).toBe(requests[0]?.get('intentId'));
    expect(isUuidV7(requests[0]?.get('intentId'))).toBe(true);
    expect(submit).toBeDisabled();
    fireEvent.click(submit);
    expect(requests).toHaveLength(2);
  });

  it('shows the service preview before it allows a final request', async () => {
    render(
      <AdjustmentDialog
        userId={userId}
        onPreview={async () => ({
          after: '110',
          before: '100',
          direction: 'CREDIT',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          impact: 'ledger',
          points: '10',
          policy: 'two-person',
          previewToken: 'preview-token-1234',
        })}
        onRequest={async () => ({
          auditRecordId: 'audit-1',
          ok: true,
          requestId: 'request-1',
          status: 'PENDING_APPROVAL',
        })}
      />,
    );
    fireEvent.change(screen.getByLabelText('调整方向'), { target: { value: 'CREDIT' } });
    fireEvent.change(screen.getByLabelText('调整点数'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('调整原因'), { target: { value: '人工补偿' } });
    fireEvent.change(screen.getByLabelText('复核人'), {
      target: { value: '0198f7a4-c6d3-7b39-8a4e-73af0c1d2e3f' },
    });
    fireEvent.click(screen.getByRole('button', { name: '获取权威预览' }));
    expect(await screen.findByText(/调整后：\s*110/u)).toBeVisible();
  });

  it('enables high-risk confirmation only after a current preview and resets it after every new successful preview', async () => {
    let previews = 0;
    render(
      <AdjustmentDialog
        userId={userId}
        onPreview={async () => {
          previews += 1;
          return {
            after: '110',
            before: '100',
            direction: 'CREDIT',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            impact: `ledger-${String(previews)}`,
            points: '10',
            policy: 'two-person',
            previewToken: `pv_abcdefghijklmnopqrstuvwxyz12345${String(previews)}`,
          };
        }}
        onRequest={async () => ({
          auditRecordId: auditId,
          ok: true,
          requestId,
          status: 'PENDING_APPROVAL',
        })}
      />,
    );
    const confirmation = screen.getByRole('checkbox', {
      name: '我已核对影响范围，并确认提交双人审批申请',
    });
    expect(confirmation).toBeDisabled();
    fireEvent.change(screen.getByLabelText('调整方向'), { target: { value: 'CREDIT' } });
    fireEvent.change(screen.getByLabelText('调整点数'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('调整原因'), { target: { value: '人工补偿' } });
    fireEvent.change(screen.getByLabelText('复核人'), { target: { value: approverId } });
    fireEvent.click(screen.getByRole('button', { name: '获取权威预览' }));
    await screen.findByText(/ledger-1/u);
    expect(confirmation).toBeEnabled();
    expect(confirmation).not.toBeChecked();
    fireEvent.click(confirmation);
    expect(confirmation).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: '获取权威预览' }));
    await screen.findByText(/ledger-2/u);
    expect(confirmation).not.toBeChecked();
  });

  it('shows preview expiry and clears a preview plus confirmation when a bound field changes', async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    render(
      <AdjustmentDialog
        userId={userId}
        onPreview={async () => ({
          after: '110',
          before: '100',
          direction: 'CREDIT',
          expiresAt,
          impact: 'ledger',
          points: '10',
          policy: 'two-person',
          previewToken: 'pv_abcdefghijklmnopqrstuvwxyz123456',
        })}
        onRequest={async () => ({
          auditRecordId: 'audit-1',
          ok: true,
          requestId: 'request-1',
          status: 'PENDING_APPROVAL',
        })}
      />,
    );
    fireEvent.change(screen.getByLabelText('调整方向'), { target: { value: 'CREDIT' } });
    fireEvent.change(screen.getByLabelText('调整点数'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('调整原因'), { target: { value: '人工补偿' } });
    fireEvent.change(screen.getByLabelText('复核人'), {
      target: { value: '0198f7a4-c6d3-7b39-8a4e-73af0c1d2e3f' },
    });
    fireEvent.click(screen.getByRole('button', { name: '获取权威预览' }));
    expect(await screen.findByText(/预览到期/u)).toHaveTextContent(expiresAt);
    fireEvent.click(
      screen.getByRole('checkbox', { name: '我已核对影响范围，并确认提交双人审批申请' }),
    );
    fireEvent.change(screen.getByLabelText('调整点数'), { target: { value: '11' } });
    expect(screen.queryByText(/预览到期/u)).not.toBeInTheDocument();
    expect(
      screen.getByRole('checkbox', { name: '我已核对影响范围，并确认提交双人审批申请' }),
    ).not.toBeChecked();
  });

  it('locally rejects an already expired authoritative preview before request submission', async () => {
    let requests = 0;
    render(
      <AdjustmentDialog
        userId={userId}
        onPreview={async () => ({
          after: '110',
          before: '100',
          direction: 'CREDIT',
          expiresAt: new Date(Date.now() - 1).toISOString(),
          impact: 'ledger',
          points: '10',
          policy: 'two-person',
          previewToken: 'pv_abcdefghijklmnopqrstuvwxyz123456',
        })}
        onRequest={async () => {
          requests += 1;
          return {
            auditRecordId: 'audit-1',
            ok: true,
            requestId: 'request-1',
            status: 'PENDING_APPROVAL',
          };
        }}
      />,
    );
    fireEvent.change(screen.getByLabelText('调整方向'), { target: { value: 'CREDIT' } });
    fireEvent.change(screen.getByLabelText('调整点数'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('调整原因'), { target: { value: '人工补偿' } });
    fireEvent.change(screen.getByLabelText('复核人'), {
      target: { value: '0198f7a4-c6d3-7b39-8a4e-73af0c1d2e3f' },
    });
    fireEvent.click(screen.getByRole('button', { name: '获取权威预览' }));
    await screen.findByText(/调整后/u);
    expect(
      screen.getByRole('checkbox', { name: '我已核对影响范围，并确认提交双人审批申请' }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '提交申请' }));
    expect(await screen.findByText('预览已过期，请重新获取权威预览')).toBeVisible();
    expect(requests).toBe(0);
  });

  it.each(['401 denied', '403 denied', '409 conflict', 'network failure', 'malformed receipt'])(
    'shows no success identifiers when final submission has %s',
    async (failure) => {
      const onRequest = async () => {
        throw new Error(failure);
      };
      render(
        <AdjustmentDialog
          userId={userId}
          onPreview={async () => ({
            after: '110',
            before: '100',
            direction: 'CREDIT',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            impact: 'ledger',
            points: '10',
            policy: 'two-person',
            previewToken: 'pv_abcdefghijklmnopqrstuvwxyz123456',
          })}
          onRequest={onRequest}
        />,
      );
      fireEvent.change(screen.getByLabelText('调整方向'), { target: { value: 'CREDIT' } });
      fireEvent.change(screen.getByLabelText('调整点数'), { target: { value: '10' } });
      fireEvent.change(screen.getByLabelText('调整原因'), { target: { value: '人工补偿' } });
      fireEvent.change(screen.getByLabelText('复核人'), {
        target: { value: '0198f7a4-c6d3-7b39-8a4e-73af0c1d2e3f' },
      });
      fireEvent.click(screen.getByRole('button', { name: '获取权威预览' }));
      await screen.findByText(/调整后/u);
      fireEvent.click(
        screen.getByRole('checkbox', { name: '我已核对影响范围，并确认提交双人审批申请' }),
      );
      fireEvent.click(screen.getByRole('button', { name: '提交申请' }));
      expect(await screen.findByText('调整申请被拒绝或暂时不可用')).toBeVisible();
      expect(screen.queryByText(/申请待审批/u)).not.toBeInTheDocument();
    },
  );

  it('shows authoritative pending status plus request and audit identifiers after final success', async () => {
    render(
      <AdjustmentDialog
        userId={userId}
        onPreview={async () => ({
          after: '110',
          before: '100',
          direction: 'CREDIT',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          impact: 'ledger',
          points: '10',
          policy: 'two-person',
          previewToken: 'pv_abcdefghijklmnopqrstuvwxyz123456',
        })}
        onRequest={async () => ({
          auditRecordId: 'audit-record-1',
          ok: true,
          requestId: 'request-1',
          status: 'PENDING_APPROVAL',
        })}
      />,
    );
    fireEvent.change(screen.getByLabelText('调整方向'), { target: { value: 'CREDIT' } });
    fireEvent.change(screen.getByLabelText('调整点数'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('调整原因'), { target: { value: '人工补偿' } });
    fireEvent.change(screen.getByLabelText('复核人'), {
      target: { value: '0198f7a4-c6d3-7b39-8a4e-73af0c1d2e3f' },
    });
    fireEvent.click(screen.getByRole('button', { name: '获取权威预览' }));
    await screen.findByText(/调整后/u);
    fireEvent.click(
      screen.getByRole('checkbox', { name: '我已核对影响范围，并确认提交双人审批申请' }),
    );
    fireEvent.click(screen.getByRole('button', { name: '提交申请' }));
    expect(await screen.findByText(/申请待审批/u)).toHaveTextContent('request-1');
    expect(screen.getByText(/申请待审批/u)).toHaveTextContent('audit-record-1');
  });
});
