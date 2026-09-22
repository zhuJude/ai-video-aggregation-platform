/* eslint-disable @typescript-eslint/require-await -- wiring fakes deliberately preserve async port signatures. */
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

const captured = vi.hoisted(() => ({
  csvProps: undefined as unknown,
  detailProps: undefined as unknown,
  factories: [] as unknown[],
}));

vi.mock('../lib/http-user-operation-port', () => ({
  createHttpUserOperationPorts: () => ({
    adjustmentPort: { name: 'adjustment' },
    directoryPort: { name: 'directory' },
    exactPhonePort: { name: 'exact-phone' },
    exportPort: { name: 'export' },
    scopePort: { name: 'scope' },
    statusPort: { name: 'status' },
  }),
}));
vi.mock('../lib/user-view-loaders', () => ({
  REGISTRATION_SOURCES: [],
  SPENDING_TIERS: [],
  USER_STATUSES: [],
  createExactPhoneLookupAction: (input: unknown) => {
    captured.factories.push(['exact-phone', input]);
    return async () => ({
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      items: [],
      ok: true,
      searchDescriptor: 'signed_descriptor_abcdefghijklmnopqrstuvwxyz1234567890',
    });
  },
  loadUsersView: async () => ({
    canExport: true,
    canUseExactPhone: false,
    filters: {},
    items: [],
    nextCursor: null,
  }),
}));
vi.mock('../lib/user-detail-view-loader', () => ({
  loadUserDetailView: async () => ({
    ok: true,
    view: {
      canRequestWalletAdjustment: true,
      tabs: [],
      user: {
        displayName: '用户',
        id: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f',
        phoneMasked: '138****8000',
        status: 'ACTIVE',
      },
    },
  }),
}));
vi.mock('../lib/user-operation-actions', () => ({
  createUserCsvExportAction: (input: unknown) => {
    captured.factories.push(['csv', input]);
    return async () => ({
      auditRecordId: 'audit-1',
      downloadUrl: 'https://download.example.invalid/file',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      ok: true,
    });
  },
  createWalletAdjustmentPreviewAction: (input: unknown) => {
    captured.factories.push(['preview', input]);
    return async () => ({
      after: '2',
      before: '1',
      direction: 'CREDIT',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      impact: 'ledger',
      points: '1',
      policy: 'two-person',
      previewToken: 'pv_abcdefghijklmnopqrstuvwxyz123456',
    });
  },
  createWalletAdjustmentRequestAction: (input: unknown) => {
    captured.factories.push(['request', input]);
    return async () => ({ ok: true, status: 'PENDING_APPROVAL' as const });
  },
}));
vi.mock('../lib/protected-user-action', () => ({
  createUserStatusAction: (input: unknown) => {
    captured.factories.push(['status', input]);
    return async () => ({ auditRecordId: 'audit-1', ok: true, requestId: 'request-1' });
  },
}));
vi.mock('../components/csv-export-form', () => ({
  CsvExportForm: (props: unknown) => {
    captured.csvProps = props;
    return null;
  },
}));
vi.mock('../components/user-detail', () => ({
  UserDetail: (props: unknown) => {
    captured.detailProps = props;
    return null;
  },
}));

import UsersPage from '../app/(secure)/users/page';
import { renderUserDetailRoute } from '../app/(secure)/users/[id]/page';
import {
  lookupExactPhoneAction,
  previewWalletAdjustmentAction,
  requestUserStatusChangeAction,
  requestUsersCsvExportAction,
  requestWalletAdjustmentAction,
} from '../app/(secure)/users/actions';

describe('real users route action wiring', () => {
  it('routes all exported server actions to their concrete port factories', async () => {
    await lookupExactPhoneAction(new FormData());
    await requestUsersCsvExportAction(new FormData());
    await previewWalletAdjustmentAction(new FormData());
    await requestWalletAdjustmentAction(new FormData());
    await requestUserStatusChangeAction(new FormData());
    expect(captured.factories).toEqual(
      expect.arrayContaining([
        ['csv', expect.objectContaining({ exportPort: { name: 'export' } })],
        ['exact-phone', expect.objectContaining({ port: { name: 'exact-phone' } })],
        [
          'preview',
          expect.objectContaining({
            adjustmentPort: { name: 'adjustment' },
            scopePort: { name: 'scope' },
          }),
        ],
        [
          'request',
          expect.objectContaining({
            adjustmentPort: { name: 'adjustment' },
            scopePort: { name: 'scope' },
          }),
        ],
        [
          'status',
          expect.objectContaining({ port: { name: 'status' }, scopePort: { name: 'scope' } }),
        ],
      ]),
    );
  });

  it('passes the real CSV and detail action exports into the users pages', async () => {
    render(await UsersPage({ searchParams: Promise.resolve({}) }));
    const detailPort = {
      async getUserDetail() {
        return {
          canRequestWalletAdjustment: true,
          deniedTabs: ['tasks', 'wallet', 'orders', 'tickets', 'audit'] as const,
          tabs: [],
          user: {
            displayName: '用户',
            id: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f',
            phoneMasked: '138****8000',
            status: 'ACTIVE' as const,
          },
        };
      },
    };
    render(
      await renderUserDetailRoute('0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f', { port: detailPort }),
    );
    expect(captured.csvProps).toEqual(
      expect.objectContaining({ onExport: requestUsersCsvExportAction }),
    );
    expect(captured.detailProps).toEqual(
      expect.objectContaining({
        onAdjustmentPreview: previewWalletAdjustmentAction,
        onAdjustmentRequest: requestWalletAdjustmentAction,
        onStatusChange: requestUserStatusChangeAction,
      }),
    );
  });
});
