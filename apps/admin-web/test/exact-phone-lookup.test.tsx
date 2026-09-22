/* eslint-disable @typescript-eslint/require-await -- fakes implement protected ports. */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ExactPhoneLookup } from '../components/exact-phone-lookup';
import {
  sealExactPhoneSearchDescriptor,
  verifyExactPhoneSearchDescriptor,
} from '../lib/exact-phone-descriptor';
import { createExactPhoneLookupAction, type ExactPhoneLookupPort } from '../lib/user-view-loaders';
import { createUserCsvExportAction, type UserExportPort } from '../lib/user-operation-actions';
import { signAdminSession } from '../lib/session-auth';

const signingKey = 'exact-phone-signing-key-at-least-32-bytes';
const descriptorSigningKey = 'exact-phone-descriptor-key-at-least-32-bytes';
const actorId = '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f';
const otherActorId = '0198f7a4-c6d3-7b39-8a4e-73af0c1d2e3f';
const upstreamHandle = 'opaque_search_handle_1234567890';
const auditId = '0198f7a4-c6d4-7b39-8a4e-73af0c1d2e3f';
const sessionInstanceId = '0198f7a4-c6da-7b39-8a4e-73af0c1d2e3f';
const otherSessionInstanceId = '0198f7a4-c6db-7b39-8a4e-73af0c1d2e3f';
const row = {
  displayName: '查询用户',
  id: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f',
  phoneMasked: '138****8000',
  status: 'ACTIVE' as const,
};

async function token(
  permissions: readonly string[],
  subjectId = actorId,
  expiresInMs = 60_000,
  instanceId = sessionInstanceId,
) {
  return signAdminSession(
    {
      dataScope: 'ASSIGNED',
      expiresAt: Date.now() + expiresInMs,
      permissions,
      sessionInstanceId: instanceId,
      subjectId,
    },
    signingKey,
  );
}

async function descriptor(
  instanceId = sessionInstanceId,
  subjectId = actorId,
  sealNow = Date.now(),
) {
  return sealExactPhoneSearchDescriptor(
    {
      expiresAt: new Date(sealNow + 60_000).toISOString(),
      handle: upstreamHandle,
      scope: 'ASSIGNED',
      sessionInstanceId: instanceId,
      subjectId,
    },
    { now: () => sealNow, signingKey: descriptorSigningKey },
  );
}

describe('protected exact-phone lookup', () => {
  it('clears the phone, renders only the mask, and submits one opaque signed descriptor for export', async () => {
    const lookupForms: FormData[] = [];
    const exportForms: FormData[] = [];
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const searchDescriptor = 'A'.repeat(64);
    const { container } = render(
      <ExactPhoneLookup
        canExport
        onExport={async (form) => {
          exportForms.push(form);
          return {
            auditRecordId: auditId,
            downloadUrl: 'https://download.example.invalid/exact',
            expiresAt,
            ok: true,
          };
        }}
        onLookup={async (form) => {
          lookupForms.push(form);
          return { expiresAt, items: [row], ok: true, searchDescriptor };
        }}
      />,
    );
    fireEvent.change(screen.getByRole('textbox', { name: '精确手机号' }), {
      target: { value: '13800138000' },
    });
    fireEvent.click(screen.getByRole('button', { name: '受保护查询' }));
    await screen.findByText('138****8000');
    expect(lookupForms[0]?.get('phone')).toBe('13800138000');
    expect(screen.getByRole('textbox', { name: '精确手机号' })).toHaveValue('');
    expect(container.innerHTML).not.toContain('13800138000');
    fireEvent.change(screen.getByLabelText('导出原因'), { target: { value: '合规核对' } });
    fireEvent.click(screen.getByRole('checkbox', { name: '我确认这是高风险数据导出' }));
    fireEvent.click(screen.getByRole('button', { name: '导出 CSV' }));
    await waitFor(() => {
      expect(exportForms).toHaveLength(1);
    });
    expect(Object.fromEntries(exportForms[0]?.entries() ?? [])).toMatchObject({ searchDescriptor });
    expect(exportForms[0]?.get('searchHandle')).toBeNull();
    expect(exportForms[0]?.get('searchHandleExpiresAt')).toBeNull();
    expect(JSON.stringify(Object.fromEntries(exportForms[0]?.entries() ?? []))).not.toContain(
      '13800138000',
    );
  });

  it('re-requires both permissions and rejects whitespace-wrapped exact phone before the port', async () => {
    let calls = 0;
    const port: ExactPhoneLookupPort = {
      async lookupExactPhone() {
        calls += 1;
        return {
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          items: [row],
          searchHandle: upstreamHandle,
        };
      },
    };
    const form = new FormData();
    form.set('phone', '13800138000');
    await expect(
      createExactPhoneLookupAction({
        descriptorSigningKey,
        port,
        guardContext: { sessionToken: await token(['users:read']), signingKey },
      })(form),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(calls).toBe(0);
    form.set('phone', ' 13800138000');
    await expect(
      createExactPhoneLookupAction({
        descriptorSigningKey,
        port,
        guardContext: {
          sessionToken: await token(['users:read', 'users:phone-exact']),
          signingKey,
        },
      })(form),
    ).rejects.toThrow('精确手机号格式无效');
    expect(calls).toBe(0);
  });

  it('seals the internal upstream handle and returns no plaintext or raw handle', async () => {
    let received: unknown;
    const now = Date.now();
    const expiresAt = new Date(now + 60_000).toISOString();
    const port: ExactPhoneLookupPort = {
      async lookupExactPhone(input) {
        received = input;
        return { expiresAt, items: [row], searchHandle: upstreamHandle };
      },
    };
    const form = new FormData();
    form.set('phone', '13800138000');
    const sessionToken = await token(['users:read', 'users:phone-exact']);
    const result = await createExactPhoneLookupAction({
      createCorrelationId: () => '0198f7a4-c6d9-7b39-8a4e-73af0c1d2e3f',
      createTraceId: () => '00112233445566778899aabbccddeeff',
      descriptorSigningKey,
      now: () => now,
      port,
      guardContext: { sessionToken, signingKey },
    })(form);
    expect(received).toMatchObject({
      phone: '13800138000',
      requestContext: {
        correlationId: '0198f7a4-c6d9-7b39-8a4e-73af0c1d2e3f',
        traceId: '00112233445566778899aabbccddeeff',
      },
      scope: 'ASSIGNED',
    });
    expect(JSON.stringify(result)).not.toContain('13800138000');
    expect(result).not.toHaveProperty('searchHandle');
    await expect(
      verifyExactPhoneSearchDescriptor(result.searchDescriptor, {
        now: () => now,
        scope: 'ASSIGNED',
        sessionInstanceId,
        signingKey: descriptorSigningKey,
        subjectId: actorId,
      }),
    ).resolves.toEqual({ expiresAt, handle: upstreamHandle });
  });
});

describe('opaque signed-descriptor CSV export', () => {
  it('rejects malformed, tampered, expired, and session-mismatched descriptors before the export port', async () => {
    let calls = 0;
    const port: UserExportPort = {
      async requestCsvExport() {
        calls += 1;
        return {
          auditRecordId: auditId,
          downloadUrl: 'https://download.example.invalid/file',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
      },
    };
    const now = Date.now();
    const authorizedSession = await token(['users:export', 'users:phone-exact']);
    const valid = await descriptor(sessionInstanceId, actorId, now);
    const expired = await descriptor(sessionInstanceId, actorId, now - 120_000);
    const values = [
      'malformed token',
      `${valid.slice(0, -1)}${valid.endsWith('A') ? 'B' : 'A'}`,
      expired,
      await descriptor(otherSessionInstanceId, otherActorId, now),
      await descriptor(otherSessionInstanceId, actorId, now),
    ];
    for (const searchDescriptor of values) {
      const form = new FormData();
      form.set('searchDescriptor', searchDescriptor);
      form.set('reason', '合规核对');
      form.set('highRiskConfirmed', 'true');
      form.set('intentId', '0198f7a4-c6d5-7b39-8a4e-73af0c1d2e3f');
      await expect(
        createUserCsvExportAction({
          descriptorSigningKey,
          exportPort: port,
          guardContext: { sessionToken: authorizedSession, signingKey },
          now: () => now,
        })(form),
      ).rejects.toThrow('搜索凭证无效');
    }
    expect(calls).toBe(0);
  });

  it('re-authorizes exact export and sends only the verified internal handle downstream', async () => {
    let received: unknown;
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const port: UserExportPort = {
      async requestCsvExport(input) {
        received = input;
        return {
          auditRecordId: auditId,
          downloadUrl: 'https://download.example.invalid/file',
          expiresAt,
        };
      },
    };
    const authorizedSession = await token(['users:export', 'users:phone-exact']);
    const form = new FormData();
    form.set('searchDescriptor', await descriptor());
    form.set('reason', '合规核对');
    form.set('highRiskConfirmed', 'true');
    form.set('intentId', '0198f7a4-c6d5-7b39-8a4e-73af0c1d2e3f');
    await expect(
      createUserCsvExportAction({
        descriptorSigningKey,
        exportPort: port,
        guardContext: { sessionToken: await token(['users:export']), signingKey },
      })(form),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await createUserCsvExportAction({
      descriptorSigningKey,
      exportPort: port,
      guardContext: { sessionToken: authorizedSession, signingKey },
    })(form);
    expect(received).toMatchObject({ searchHandle: upstreamHandle });
    expect(received).not.toHaveProperty('searchDescriptor');
    expect(received).not.toHaveProperty('phone');
    expect(received).not.toHaveProperty('query');
  });

  it('rejects legacy client-controlled handle/expiry fields and missing production signing config', async () => {
    let calls = 0;
    const port: UserExportPort = {
      async requestCsvExport() {
        calls += 1;
        return {
          auditRecordId: auditId,
          downloadUrl: 'https://download.example.invalid/file',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
      },
    };
    const context = {
      sessionToken: await token(['users:export', 'users:phone-exact']),
      signingKey,
    };
    for (const [name, value] of [
      ['searchHandle', upstreamHandle],
      ['searchHandleExpiresAt', new Date(Date.now() + 60_000).toISOString()],
    ] as const) {
      const form = new FormData();
      form.set(name, value);
      form.set('reason', '合规核对');
      form.set('highRiskConfirmed', 'true');
      form.set('intentId', '0198f7a4-c6d5-7b39-8a4e-73af0c1d2e3f');
      await expect(
        createUserCsvExportAction({
          descriptorSigningKey,
          exportPort: port,
          guardContext: context,
        })(form),
      ).rejects.toThrow('精确手机号模式无效');
    }
    const form = new FormData();
    form.set('searchDescriptor', await descriptor());
    form.set('reason', '合规核对');
    form.set('highRiskConfirmed', 'true');
    form.set('intentId', '0198f7a4-c6d5-7b39-8a4e-73af0c1d2e3f');
    await expect(
      createUserCsvExportAction({
        descriptorSigningKey: undefined,
        exportPort: port,
        guardContext: context,
      })(form),
    ).rejects.toThrow('搜索凭证签名配置无效');
    expect(calls).toBe(0);
  });
});
