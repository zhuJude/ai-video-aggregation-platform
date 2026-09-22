/* eslint-disable @typescript-eslint/require-await -- async fakes model governance BFF calls. */

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { RoleEditor, SystemConsole, TicketConsole } from '../components/governance/governance-console';
import {
  canTransitionTicket,
  createAdminUpdateAction,
  createAuditExportAction,
  createContentDraftAction,
  createContentPublicationAction,
  createContentValidationAction,
  createRoleUpdateAction,
  createSystemMutationAction,
  createTicketMessageAction,
  parseAuditDirectory,
  parseContentDirectory,
  parseIamDirectory,
  parsePublicHttpsUrl,
  parseSystemSnapshot,
  parseTrustedObservabilityOrigins,
  parseTicketDirectory,
  type GovernanceOperationsPort,
} from '../lib/governance-operations';
import { createHttpGovernanceOperationsPort } from '../lib/http-governance-port';
import { createOutboundRequestContext } from '../lib/outbound-request-context';
import { isValidAdminPermissions } from '../lib/permissions';
import { signAdminSession } from '../lib/session-auth';

const signingKey = 'task7-signing-key-with-more-than-thirty-two-bytes';
const actorId = '0198f7a4-c6d0-7b39-8a4e-73af0c1d2e3f';
const roleId = '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f';
const contentId = '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f';
const ticketId = '0198f7a4-c6d3-7b39-8a4e-73af0c1d2e3f';
const intentId = '0198f7a4-c6d4-7b39-8a4e-73af0c1d2e3f';
const auditId = '0198f7a4-c6d5-7b39-8a4e-73af0c1d2e3f';
const attachmentId = '0198f7a4-c6d6-7b39-8a4e-73af0c1d2e3f';
const traceId = '1234567890abcdef1234567890abcdef';
const trustedObservabilityOrigins = ['https://ops.example.com'] as const;

async function session(
  permissions: readonly string[],
  subjectId = actorId,
  dataScope: 'ALL' | 'ASSIGNED' | 'OWN' = 'ALL',
) {
  return signAdminSession({
    dataScope,
    expiresAt: Date.now() + 60_000,
    permissions,
    sessionInstanceId: intentId,
    subjectId,
  }, signingKey);
}

const contentPayload = {
  items: [{
    allowedOperations: ['PUBLISH'],
    assignedAdminIds: [actorId],
    draft: {
      body: { blocks: [{ text: '安全公告', type: 'PARAGRAPH' }] },
      planPoints: '9007199254740993',
      title: '服务升级公告',
    },
    draftPreviews: [],
    id: contentId,
    ownerAdminId: actorId,
    preview: {
      diff: ['+ 服务升级公告', '+ 套餐点数 9007199254740993'],
      expiresAt: '2099-09-11T00:00:00.000Z',
      operation: 'PUBLISH',
      preflightToken: 'content-preview-signed-token',
      resultStatus: 'PUBLISHED',
      resultVersion: 4,
      renderedDocument: { blocks: [{ text: '安全公告', type: 'PARAGRAPH' }] },
    },
    publishedVersion: null,
    slug: 'service-upgrade',
    status: 'DRAFT_VALIDATED',
    validation: { errors: [], valid: true },
    version: 3,
  }],
  nextCursor: null,
  sourceUpdatedAt: '2026-09-11T00:00:00.000Z',
};

const ticketPayload = {
  items: [{
    allowedTransitions: ['IN_PROGRESS'],
    assignedAdminIds: [actorId],
    id: ticketId,
    messages: [{
      attachments: [{
        fileId: attachmentId,
        mimeType: 'image/png',
        name: 'evidence.png',
        sizeBytes: 2048,
      }],
      authorMasked: 'user-****91',
      authorType: 'USER',
      body: '任务一直处理中',
      createdAt: '2026-09-10T00:00:00.000Z',
      id: auditId,
      visibility: 'PUBLIC_REPLY',
    }],
    messagePreviews: [{
      allowedAttachmentFileIds: [attachmentId],
      expiresAt: '2099-09-11T00:00:00.000Z',
      impact: '向用户发送公开回复',
      preflightToken: 'ticket-message-preflight',
      resultVersion: 6,
      visibility: 'PUBLIC_REPLY',
    }],
    ownerAdminId: actorId,
    resolvedAt: null,
    status: 'OPEN',
    transitionPreviews: [{
      expiresAt: '2099-09-11T00:00:00.000Z',
      impact: '进入处理状态',
      preflightToken: 'ticket-transition-progress',
      resultVersion: 6,
      to: 'IN_PROGRESS',
    }],
    version: 5,
  }],
  nextCursor: null,
  sourceUpdatedAt: '2026-09-11T00:00:00.000Z',
};

const iamPayload = {
  actorAdminId: actorId,
  admins: [{
    dataScope: 'ALL',
    displayNameMasked: 'admin-****01',
    id: actorId,
    mfa: { enabled: true, lastVerifiedAt: '2026-09-11T00:00:00.000Z' },
    preview: null,
    roleIds: [roleId],
    status: 'ACTIVE',
    version: 3,
  }],
  grantablePermissions: ['users:read', 'tickets:read'],
  roles: [{
    adminCount: 1,
    assignedAdminIds: [actorId],
    dataScope: 'ALL',
    id: roleId,
    isSuperAdmin: true,
    name: '超级管理员',
    ownerAdminId: actorId,
    permissions: ['users:read', 'tickets:read'],
    preview: {
      actorImpacted: false,
      added: [],
      expiresAt: '2099-09-11T00:00:00.000Z',
      impactedAdminIdsMasked: ['admin-****01'],
      operation: 'UPDATE',
      preflightToken: 'iam-preview-signed-token',
      proposedDataScope: 'ALL',
      proposedPermissions: ['users:read'],
      removed: ['tickets:read'],
      resultVersion: 8,
    },
    version: 7,
  }],
  sourceUpdatedAt: '2026-09-11T00:00:00.000Z',
  superAdminCount: 1,
};

const auditPayload = {
  exportPreview: {
    expiresAt: '2099-09-11T00:00:00.000Z',
    filterFingerprint: 'audit-filter-fingerprint',
    filters: { action: 'iam.role.update', actor: 'admin-01', from: '2026-09-01T00:00:00.000Z', resource: 'role-01', to: '2026-09-11T00:00:00.000Z', traceId },
    preflightToken: 'audit-export-preflight',
    resultStatus: 'QUEUED',
  },
  items: [{
    action: 'iam.role.update',
    actorIdMasked: 'admin-****01',
    afterSummary: 'role permissions updated',
    at: '2026-09-11T00:00:00.000Z',
    beforeSummary: 'role permissions previous',
    id: auditId,
    ipMasked: '203.0.113.***',
    reason: '职责调整',
    resourceIdMasked: 'role-****01',
    resourceType: 'ROLE',
    traceId,
    userAgentMasked: 'Chrome/***',
  }],
  nextCursor: 'next-audit-cursor',
  sourceUpdatedAt: '2026-09-11T00:00:00.000Z',
};

const systemPayload = {
  alerts: [{ closeCondition: 'DLQ 小于 1', id: auditId, ownerMasked: 'payments-****', runbookUrl: 'https://ops.example.com/runbooks/refund', severity: 'HIGH', summary: '退款队列积压' }],
  config: {
    allowedOperations: ['PUBLISH_FLAG', 'ROLLBACK_SETTING', 'REDRIVE_DLQ'],
    featureFlags: {
      current: [{ enabled: false, key: 'new-routing', rolloutBps: 0 }],
      diff: ['rolloutBps: 0 -> 1000'],
      draft: [{ enabled: true, key: 'new-routing', rolloutBps: 1000 }],
      history: [{ publishedAt: '2026-09-10T00:00:00.000Z', version: 10 }],
      validation: { errors: [], valid: true },
    },
    flagsVersion: 11,
    preview: {
      expiresAt: '2099-09-11T00:00:00.000Z',
      impact: '灰度 10% 管理员流量',
      operation: 'PUBLISH_FLAG',
      preflightToken: 'system-preview-signed-token',
      resultVersion: 12,
    },
    publicSettings: {
      current: { publicCallbackUrl: 'https://api.example.com/callback', publicDomain: 'https://www.example.com' },
      diff: ['publicDomain changed'],
      draft: { publicCallbackUrl: 'https://api.example.com/callback-v2', publicDomain: 'https://app.example.com' },
      history: [{ publishedAt: '2026-09-10T00:00:00.000Z', version: 19 }],
      secretReferences: [{ kmsReference: 'kms://admin-web/payment-callback-signing', masked: 'sk_***91', name: 'callback signing' }],
      validation: { errors: [], valid: true },
    },
    settingsVersion: 20,
  },
  freshness: [{ source: 'queue-metrics', updatedAt: '2026-09-11T00:00:00.000Z' }],
  links: [{ label: 'Grafana', url: 'https://ops.example.com/admin' }],
  queues: [{
    depth: '9007199254740993',
    dlq: 4,
    name: 'refund-events',
    preview: {
      billingSafe: true,
      businessKey: 'refund-events:2026-09-11',
      currentOutcome: 'FAILED_RETRYABLE',
      expiresAt: '2099-09-11T00:00:00.000Z',
      impact: '重放 4 条脱敏失败事件',
      idempotencySafe: true,
      preflightToken: 'dlq-preview-signed-token',
      purchaseSafe: true,
      resultVersion: 9,
    },
    version: 8,
  }],
  releases: [{ deployedAt: '2026-09-11T00:00:00.000Z', digest: 'a'.repeat(64), environment: 'production', service: 'admin-api', version: '2026.09.11.1' }],
  services: [{ latencyMs: 42, name: 'admin-api', status: 'HEALTHY' }],
  sourceUpdatedAt: '2026-09-11T00:00:00.000Z',
};

function mutationForm(resourceKey: string, resourceId: string, version: number, token: string) {
  const form = new FormData();
  form.set(resourceKey, resourceId);
  form.set('expectedVersion', String(version));
  form.set('preflightToken', token);
  form.set('intentId', intentId);
  form.set('reason', '已核对影响范围并执行');
  form.set('confirmed', 'true');
  return form;
}

describe('Task 7 permission catalog and content publication', () => {
  it('recognizes Task 7 fine-grained permissions', () => {
    expect(isValidAdminPermissions([
      'content:publish', 'content:rollback', 'tickets:public-reply', 'tickets:internal-note',
      'iam:role-write', 'iam:role-delete', 'iam:admin-write', 'audit:export', 'system:config-publish', 'system:dlq-redrive',
    ])).toBe(true);
  });

  it('preserves BigInt plan values and accepts only structured rich text', () => {
    expect(parseContentDirectory(contentPayload).items[0]?.draft.planPoints)
      .toBe('9007199254740993');
    expect(() => parseContentDirectory({
      ...contentPayload,
      items: [{
        ...contentPayload.items[0],
        draft: {
          ...contentPayload.items[0]?.draft,
          body: { blocks: [{ href: '&#x6a;avascript:alert(1)', text: '点我', type: 'PARAGRAPH' }] },
        },
      }],
    })).toThrow('内容响应无效');
  });

  it('publishes only an authoritative validated preview and binds the receipt', async () => {
    const executeContentOperation = vi.fn(async () => ({
      auditRecordId: auditId,
      contentId,
      idempotencyKey: intentId,
      ok: true,
      operation: 'PUBLISH',
      requestId: roleId,
      status: 'PUBLISHED',
      version: 4,
    }));
    const action = createContentPublicationAction({
      context: { sessionToken: await session(['content:publish']), signingKey },
      port: {
        executeContentOperation,
        async getContent() { return contentPayload.items[0]; },
      } as unknown as GovernanceOperationsPort,
    });
    const form = mutationForm('contentId', contentId, 3, 'content-preview-signed-token');
    form.set('operation', 'PUBLISH');
    await expect(action(form)).resolves.toMatchObject({ status: 'PUBLISHED' });
    expect(executeContentOperation).toHaveBeenCalledWith(expect.objectContaining({
      expectedVersion: 3,
      operation: 'PUBLISH',
    }));
    form.set('bodyText', '<script>steal()</script>');
    await expect(action(form)).rejects.toThrow('内容发布字段无效');
  });

  it('saves a safe BigInt draft and validates the authoritative version before preview', async () => {
    const draftItem = {
      ...contentPayload.items[0],
      allowedOperations: ['SAVE_DRAFT', 'VALIDATE'],
      draftPreviews: [{
        expiresAt: '2099-09-11T00:00:00.000Z',
        operation: 'SAVE_DRAFT',
        preflightToken: 'draft-save-authority',
        resultStatus: 'DRAFT',
        resultVersion: 4,
      }, {
        expiresAt: '2099-09-11T00:00:00.000Z',
        operation: 'VALIDATE',
        preflightToken: 'draft-validate-authority',
        resultStatus: 'DRAFT_VALIDATED',
        resultVersion: 4,
      }],
      preview: null,
      status: 'DRAFT',
      validation: { errors: ['尚未校验'], valid: false },
    };
    const saveContentDraft = vi.fn(async () => ({
      auditRecordId: auditId, contentId, idempotencyKey: intentId, ok: true,
      operation: 'SAVE_DRAFT', requestId: roleId, status: 'DRAFT', version: 4,
    }));
    const save = createContentDraftAction({
      context: { sessionToken: await session(['content:write']), signingKey },
      port: { async getContent() { return draftItem; }, saveContentDraft } as unknown as GovernanceOperationsPort,
    });
    const saveForm = mutationForm('contentId', contentId, 3, 'draft-save-authority');
    saveForm.set('title', '升级公告');
    saveForm.set('bodyText', '新的安全内容');
    saveForm.set('planPoints', '9007199254740993');
    await expect(save(saveForm)).resolves.toMatchObject({ status: 'DRAFT' });
    expect(saveContentDraft).toHaveBeenCalledWith(expect.objectContaining({ planPoints: '9007199254740993' }));

    const validateContentDraft = vi.fn(async () => ({
      auditRecordId: auditId, contentId, idempotencyKey: intentId, ok: true,
      operation: 'VALIDATE', requestId: roleId, status: 'DRAFT_VALIDATED', version: 4,
    }));
    const validate = createContentValidationAction({
      context: { sessionToken: await session(['content:validate']), signingKey },
      port: { async getContent() { return draftItem; }, validateContentDraft } as unknown as GovernanceOperationsPort,
    });
    const validateForm = mutationForm('contentId', contentId, 3, 'draft-validate-authority');
    await expect(validate(validateForm)).resolves.toMatchObject({ status: 'DRAFT_VALIDATED' });
  });
});

describe('ticket workflow', () => {
  it('keeps internal notes visibly separate and validates attachment metadata', () => {
    const view = parseTicketDirectory(ticketPayload);
    render(<TicketConsole permissions={['tickets:read']} view={view} />);
    expect(screen.getByText('公开回复')).toBeVisible();
    expect(screen.getByText(/evidence\.png/u)).toBeVisible();
    expect(() => parseTicketDirectory({
      ...ticketPayload,
      items: [{
        ...ticketPayload.items[0],
        messages: [{
          ...ticketPayload.items[0]?.messages[0],
          attachments: [{
            ...ticketPayload.items[0]?.messages[0]?.attachments[0],
            name: 'Authorization: Bearer leaked',
          }],
        }],
      }],
    })).toThrow('工单响应无效');
  });

  it('enforces the state machine, admin-public-reply resolve gate and seven-day reopen window', () => {
    expect(canTransitionTicket('OPEN', 'IN_PROGRESS', null, false, Date.parse('2026-09-11T00:00:00Z')))
      .toBe(true);
    expect(canTransitionTicket('OPEN', 'RESOLVED', null, true, Date.parse('2026-09-11T00:00:00Z')))
      .toBe(false);
    expect(canTransitionTicket('IN_PROGRESS', 'RESOLVED', null, false, Date.parse('2026-09-11T00:00:00Z')))
      .toBe(false);
    expect(canTransitionTicket('IN_PROGRESS', 'RESOLVED', null, true, Date.parse('2026-09-11T00:00:00Z')))
      .toBe(true);
    expect(canTransitionTicket('RESOLVED', 'IN_PROGRESS', '2026-09-08T00:00:00.000Z', true, Date.parse('2026-09-11T00:00:00Z')))
      .toBe(true);
    expect(canTransitionTicket('RESOLVED', 'IN_PROGRESS', '2026-09-01T00:00:00.000Z', true, Date.parse('2026-09-11T00:00:00Z')))
      .toBe(false);
    expect(canTransitionTicket('RESOLVED', 'CLOSED', '2026-09-01T00:00:00.000Z', true, Date.parse('2026-09-11T00:00:00Z')))
      .toBe(true);
  });

  it('uses distinct public reply and internal note ports after re-fetching scope/version', async () => {
    const addPublicReply = vi.fn(async () => ({
      auditRecordId: auditId, idempotencyKey: intentId, messageVisibility: 'PUBLIC_REPLY',
      ok: true, requestId: roleId, ticketId, version: 6,
    }));
    const addInternalNote = vi.fn();
    const action = createTicketMessageAction({
      context: { sessionToken: await session(['tickets:public-reply']), signingKey },
      port: {
        addInternalNote,
        addPublicReply,
        async getTicket() { return ticketPayload.items[0]; },
      } as unknown as GovernanceOperationsPort,
    });
    const form = mutationForm('ticketId', ticketId, 5, 'ticket-message-preflight');
    form.set('visibility', 'PUBLIC_REPLY');
    form.set('body', '我们已开始排查');
    form.append('attachmentFileId', attachmentId);
    await expect(action(form)).resolves.toMatchObject({ messageVisibility: 'PUBLIC_REPLY' });
    expect(addPublicReply).toHaveBeenCalledOnce();
    expect(addPublicReply).toHaveBeenCalledWith(expect.objectContaining({ attachmentFileIds: [attachmentId] }));
    expect(addInternalNote).not.toHaveBeenCalled();
  });
});

describe('authoritative IAM controls', () => {
  it('disables permissions absent from the authoritative grantable matrix', () => {
    render(<RoleEditor actorPermissions={['iam:role-write', 'users:read']} directory={parseIamDirectory(iamPayload)} roleId={roleId} />);
    expect(screen.getByLabelText('wallet:adjust')).toBeDisabled();
    expect(screen.getByText('影响 1 位管理员')).toBeVisible();
  });

  it('prevents self escalation and deleting the last superadmin', async () => {
    const updateRole = vi.fn();
    const action = createRoleUpdateAction({
      context: { sessionToken: await session(['iam:role-delete']), signingKey },
      port: {
        async getIamDirectory() { return { ...iamPayload, roles: [{ ...iamPayload.roles[0], preview: {
          ...iamPayload.roles[0]?.preview, added: [], operation: 'DELETE', proposedDataScope: null,
          proposedPermissions: [], removed: ['users:read', 'tickets:read'],
        } }] }; },
        updateRole,
      } as unknown as GovernanceOperationsPort,
    });
    const form = mutationForm('roleId', roleId, 7, 'iam-preview-signed-token');
    form.set('operation', 'DELETE');
    await expect(action(form)).rejects.toThrow('最后一名超级管理员');
    expect(updateRole).not.toHaveBeenCalled();
  });

  it('rejects a grant not possessed by the actor even if submitted by the client', async () => {
    const action = createRoleUpdateAction({
      context: { sessionToken: await session(['iam:role-write', 'users:read']), signingKey },
      port: {
        async getIamDirectory() {
          return iamPayload;
        },
        updateRole: vi.fn(),
      } as unknown as GovernanceOperationsPort,
    });
    const form = mutationForm('roleId', roleId, 7, 'iam-preview-signed-token');
    form.set('operation', 'UPDATE');
    form.set('dataScope', 'ALL');
    form.append('permission', 'wallet:adjust');
    await expect(action(form)).rejects.toThrow('不可授予未持有权限');
  });

  it('rejects an authoritative role diff that would elevate the acting administrator', async () => {
    const selfEscalating = {
      ...iamPayload,
      grantablePermissions: [...iamPayload.grantablePermissions, 'content:read'],
      roles: [{
        ...iamPayload.roles[0],
        preview: {
          ...iamPayload.roles[0]?.preview,
          actorImpacted: true,
          added: ['content:read'],
          proposedPermissions: ['users:read', 'tickets:read', 'content:read'],
          removed: [],
        },
      }],
    };
    const updateRole = vi.fn();
    const action = createRoleUpdateAction({
      context: { sessionToken: await session(['iam:role-write', 'users:read', 'tickets:read', 'content:read']), signingKey },
      port: { async getIamDirectory() { return selfEscalating; }, updateRole } as unknown as GovernanceOperationsPort,
    });
    const form = mutationForm('roleId', roleId, 7, 'iam-preview-signed-token');
    form.set('operation', 'UPDATE');
    form.set('dataScope', 'ALL');
    form.append('permission', 'users:read');
    form.append('permission', 'tickets:read');
    form.append('permission', 'content:read');
    await expect(action(form)).rejects.toThrow('不可通过当前角色为自己提权');
    expect(updateRole).not.toHaveBeenCalled();
  });

  it('does not render a role mutation form without the operation-specific permission', () => {
    render(<RoleEditor actorPermissions={['iam:read']} directory={parseIamDirectory(iamPayload)} roleId={roleId} />);
    expect(screen.queryByRole('button', { name: '应用角色变更' })).not.toBeInTheDocument();
    expect(screen.getByText('当前账号只有查看权限，未呈现可提交表单。')).toBeVisible();
  });

  it('allows deleting an ordinary role only with iam:role-delete and a bound DELETE preview', async () => {
    const superRole = { ...iamPayload.roles[0], id: contentId, preview: null };
    const ordinaryRole = { ...iamPayload.roles[0], adminCount: 0, assignedAdminIds: [], isSuperAdmin: false,
      preview: { ...iamPayload.roles[0]?.preview, added: [], impactedAdminIdsMasked: [], operation: 'DELETE', proposedDataScope: null,
        proposedPermissions: [], removed: ['users:read', 'tickets:read'] } };
    const deletePayload = { ...iamPayload, admins: [{ ...iamPayload.admins[0], roleIds: [contentId] }],
      roles: [ordinaryRole, superRole] };
    const updateRole = vi.fn(async () => ({ auditRecordId: auditId, idempotencyKey: intentId, ok: true,
      operation: 'DELETE', requestId: contentId, roleId, version: 8 }));
    const action = createRoleUpdateAction({ context: { sessionToken: await session(['iam:role-delete']), signingKey },
      port: { async getIamDirectory() { return deletePayload; }, updateRole } as unknown as GovernanceOperationsPort });
    const form = mutationForm('roleId', roleId, 7, 'iam-preview-signed-token');
    form.set('operation', 'DELETE');
    await expect(action(form)).resolves.toMatchObject({ operation: 'DELETE', roleId });
    expect(updateRole).toHaveBeenCalledOnce();
  });

  it('rejects dangling role assignments and inconsistent authoritative IAM counts', () => {
    expect(() => parseIamDirectory({ ...iamPayload, admins: [{ ...iamPayload.admins[0], roleIds: [contentId] }] }))
      .toThrow('权限响应无效');
    expect(() => parseIamDirectory({ ...iamPayload, roles: [{ ...iamPayload.roles[0], adminCount: 0 }] }))
      .toThrow('权限响应无效');
    expect(() => parseIamDirectory({ ...iamPayload, superAdminCount: 2 })).toThrow('权限响应无效');
  });

  it('rejects IAM mutations when the authoritative actor does not match the session subject', async () => {
    const action = createAdminUpdateAction({
      context: { sessionToken: await session(['iam:admin-write'], ticketId), signingKey },
      port: { async getIamDirectory() { return iamPayload; }, updateAdmin: vi.fn() } as unknown as GovernanceOperationsPort,
    });
    const form = mutationForm('adminId', actorId, 3, 'unused-preview');
    form.set('operation', 'UPDATE_SCOPE'); form.set('dataScope', 'ALL'); form.set('status', 'ACTIVE'); form.append('roleId', roleId);
    await expect(action(form)).rejects.toThrow('权限权威上下文不一致');
  });

  it('expands target roles and rejects assignment of a role whose permissions are not held by the actor', async () => {
    const restrictedRole = { adminCount: 0, assignedAdminIds: [], dataScope: 'OWN', id: contentId,
      isSuperAdmin: false, name: '发布员', ownerAdminId: null, permissions: ['content:publish'], preview: null, version: 1 };
    const targetAdmin = { dataScope: 'OWN', displayNameMasked: 'admin-****02', id: ticketId,
      mfa: { enabled: true, lastVerifiedAt: '2026-09-11T00:00:00.000Z' }, preview: {
        actorImpacted: false, expiresAt: '2099-09-11T00:00:00.000Z', operation: 'UPDATE_ASSIGNMENTS',
        preflightToken: 'admin-assignment-token', proposedDataScope: 'OWN', proposedRoleIds: [contentId],
        proposedStatus: 'ACTIVE', removesLastSuperAdmin: false, resultVersion: 2,
      }, roleIds: [], status: 'ACTIVE', version: 1 };
    const directory = { ...iamPayload, admins: [...iamPayload.admins, targetAdmin],
      grantablePermissions: [...iamPayload.grantablePermissions, 'content:publish'], roles: [...iamPayload.roles, restrictedRole] };
    const updateAdmin = vi.fn();
    const action = createAdminUpdateAction({ context: { sessionToken: await session(['iam:admin-write']), signingKey },
      port: { async getIamDirectory() { return directory; }, updateAdmin } as unknown as GovernanceOperationsPort });
    const form = mutationForm('adminId', ticketId, 1, 'admin-assignment-token');
    form.set('operation', 'UPDATE_ASSIGNMENTS'); form.set('dataScope', 'OWN'); form.set('status', 'ACTIVE'); form.append('roleId', contentId);
    await expect(action(form)).rejects.toThrow('不可分配未持有权限的角色');
    expect(updateAdmin).not.toHaveBeenCalled();
  });

  it('derives self-escalation and last-superadmin protection instead of trusting preview booleans', async () => {
    const elevatedRole = { adminCount: 0, assignedAdminIds: [], dataScope: 'ALL', id: contentId,
      isSuperAdmin: false, name: '发布员', ownerAdminId: null, permissions: ['content:publish'], preview: null, version: 1 };
    const selfEscalating = { ...iamPayload, admins: [{ ...iamPayload.admins[0], preview: {
      actorImpacted: false, expiresAt: '2099-09-11T00:00:00.000Z', operation: 'UPDATE_ASSIGNMENTS',
      preflightToken: 'admin-self-token', proposedDataScope: 'ALL', proposedRoleIds: [roleId, contentId],
      proposedStatus: 'ACTIVE', removesLastSuperAdmin: false, resultVersion: 4,
    } }], grantablePermissions: [...iamPayload.grantablePermissions, 'content:publish'], roles: [...iamPayload.roles, elevatedRole] };
    const selfAction = createAdminUpdateAction({ context: { sessionToken: await session(['iam:admin-write', 'users:read', 'tickets:read', 'content:publish']), signingKey },
      port: { async getIamDirectory() { return selfEscalating; }, updateAdmin: vi.fn() } as unknown as GovernanceOperationsPort });
    const selfForm = mutationForm('adminId', actorId, 3, 'admin-self-token');
    selfForm.set('operation', 'UPDATE_ASSIGNMENTS'); selfForm.set('dataScope', 'ALL'); selfForm.set('status', 'ACTIVE');
    selfForm.append('roleId', roleId); selfForm.append('roleId', contentId);
    await expect(selfAction(selfForm)).rejects.toThrow('不可为自己提权');

    const removesSuper = { ...iamPayload, admins: [{ ...iamPayload.admins[0], preview: {
      actorImpacted: false, expiresAt: '2099-09-11T00:00:00.000Z', operation: 'UPDATE_ASSIGNMENTS',
      preflightToken: 'admin-super-token', proposedDataScope: 'ALL', proposedRoleIds: [],
      proposedStatus: 'ACTIVE', removesLastSuperAdmin: false, resultVersion: 4,
    } }] };
    const superAction = createAdminUpdateAction({ context: { sessionToken: await session(['iam:admin-write']), signingKey },
      port: { async getIamDirectory() { return removesSuper; }, updateAdmin: vi.fn() } as unknown as GovernanceOperationsPort });
    const superForm = mutationForm('adminId', actorId, 3, 'admin-super-token');
    superForm.set('operation', 'UPDATE_ASSIGNMENTS'); superForm.set('dataScope', 'ALL'); superForm.set('status', 'ACTIVE');
    await expect(superAction(superForm)).rejects.toThrow('不可移除最后一名超级管理员');
  });
});

describe('audit and system operations', () => {
  it('strictly parses read-only audit data with cursor and trace filters', () => {
    expect(parseAuditDirectory(auditPayload).nextCursor).toBe('next-audit-cursor');
    expect(() => parseAuditDirectory({ ...auditPayload, editAllowed: true })).toThrow('审计响应无效');
  });

  it('creates only a controlled asynchronous audit export job', async () => {
    const requestAuditExport = vi.fn(async () => ({
      auditRecordId: auditId, exportJobId: contentId, idempotencyKey: intentId,
      filterFingerprint: 'audit-filter-fingerprint', ok: true, requestId: roleId, status: 'QUEUED',
    }));
    const action = createAuditExportAction({
      context: { sessionToken: await session(['audit:export']), signingKey },
      port: {
        async getAuditExportPreview() {
          return {
            expiresAt: '2099-09-11T00:00:00.000Z',
            filterFingerprint: 'audit-filter-fingerprint',
            preflightToken: 'audit-export-preflight',
            resultStatus: 'QUEUED',
          };
        },
        requestAuditExport,
      } as unknown as GovernanceOperationsPort,
    });
    const form = new FormData();
    form.set('actor', 'admin-01');
    form.set('action', 'iam.role.update');
    form.set('resource', 'role-01');
    form.set('traceId', traceId);
    form.set('from', '2026-09-01T00:00:00.000Z');
    form.set('to', '2026-09-11T00:00:00.000Z');
    form.set('format', 'CSV');
    form.set('filterFingerprint', 'audit-filter-fingerprint');
    form.set('intentId', intentId);
    form.set('preflightToken', 'audit-export-preflight');
    form.set('reason', '合规抽查');
    form.set('confirmed', 'true');
    await expect(action(form)).resolves.toMatchObject({ status: 'QUEUED' });
    expect(requestAuditExport).toHaveBeenCalledWith(expect.objectContaining({ format: 'CSV' }));
  });

  it('rejects an audit export receipt whose fingerprint is not bound to the requested filters', async () => {
    const action = createAuditExportAction({
      context: { sessionToken: await session(['audit:export']), signingKey },
      port: {
        async getAuditExportPreview() { return { expiresAt: auditPayload.exportPreview.expiresAt,
          filterFingerprint: auditPayload.exportPreview.filterFingerprint, preflightToken: auditPayload.exportPreview.preflightToken,
          resultStatus: auditPayload.exportPreview.resultStatus }; },
        async requestAuditExport() { return { auditRecordId: auditId, exportJobId: contentId,
          filterFingerprint: 'different-filter', idempotencyKey: intentId, ok: true, requestId: roleId, status: 'QUEUED' }; },
      } as unknown as GovernanceOperationsPort,
    });
    const form = new FormData();
    for (const [key, value] of Object.entries(auditPayload.exportPreview.filters)) form.set(key, value);
    form.set('format', 'CSV'); form.set('filterFingerprint', 'audit-filter-fingerprint'); form.set('intentId', intentId);
    form.set('preflightToken', 'audit-export-preflight'); form.set('reason', '合规抽查'); form.set('confirmed', 'true');
    await expect(action(form)).rejects.toThrow('运营操作回执无效');
  });

  it('shows trusted health links and never renders secrets or DLQ payloads', () => {
    const view = parseSystemSnapshot(systemPayload, trustedObservabilityOrigins);
    render(<SystemConsole permissions={['system:read']} view={view} />);
    expect(screen.getByRole('link', { name: 'Grafana' })).toHaveAttribute(
      'href', 'https://ops.example.com/admin',
    );
    expect(document.body.textContent).toContain('kms://admin-web/payment-callback-signing');
    expect(document.body.textContent).not.toContain('PRIVATE KEY');
    expect(document.body.textContent).not.toContain('dlqPayload');
  });

  it('rejects untrusted observability links and non-KMS secret references', () => {
    expect(() => parseSystemSnapshot({
      ...systemPayload,
      links: [{ label: 'Grafana', url: 'https://evil.example/phish' }],
    }, trustedObservabilityOrigins)).toThrow('系统运行响应无效');
    expect(() => parseSystemSnapshot({
      ...systemPayload,
      config: { ...systemPayload.config, publicSettings: { ...systemPayload.config.publicSettings,
        secretReferences: [{ kmsReference: 'PRIVATE KEY=leaked', masked: '***', name: 'bad' }] } },
    }, trustedObservabilityOrigins)).toThrow('系统运行响应无效');
  });

  it('uses only explicitly configured production HTTPS origins and rejects URL authority tricks', () => {
    expect(parseTrustedObservabilityOrigins('https://ops.example.com')).toEqual(trustedObservabilityOrigins);
    for (const value of ['https://user@ops.example.com', 'https://ops.example.com/path?token=x',
      'https://127.0.0.1', 'https://10.1.2.3', 'https://observability.internal.example']) {
      expect(parsePublicHttpsUrl(value)).toBeNull();
    }
    expect(() => parseTrustedObservabilityOrigins('https://observability.internal.example')).toThrow('可信观测域配置无效');
  });

  it('requires valid domain validation before publish and an explicit REDRIVE_DLQ capability', () => {
    expect(() => parseSystemSnapshot({ ...systemPayload, config: { ...systemPayload.config,
      featureFlags: { ...systemPayload.config.featureFlags, validation: { errors: ['invalid flag'], valid: false } } } },
    trustedObservabilityOrigins)).toThrow('系统运行响应无效');
    expect(() => parseSystemSnapshot({ ...systemPayload, config: { ...systemPayload.config,
      allowedOperations: systemPayload.config.allowedOperations.filter((operation) => operation !== 'REDRIVE_DLQ') } },
    trustedObservabilityOrigins)).toThrow('系统运行响应无效');
  });

  it('re-fetches a DLQ preview and binds its versioned idempotent receipt', async () => {
    const executeSystemOperation = vi.fn(async () => ({
      auditRecordId: auditId, idempotencyKey: intentId, ok: true, operation: 'REDRIVE_DLQ',
      businessKey: 'refund-events:2026-09-11', currentOutcome: 'FAILED_RETRYABLE', requestId: roleId, resourceId: 'refund-events', version: 9,
    }));
    const action = createSystemMutationAction({
      context: { sessionToken: await session(['system:dlq-redrive']), signingKey },
      trustedObservabilityOrigins,
      port: {
        executeSystemOperation,
        async getSystemSnapshot() { return systemPayload; },
      } as unknown as GovernanceOperationsPort,
    });
    const form = mutationForm('resourceId', 'refund-events', 8, 'dlq-preview-signed-token');
    form.set('operation', 'REDRIVE_DLQ');
    await expect(action(form)).resolves.toMatchObject({ operation: 'REDRIVE_DLQ', version: 9 });
    expect(JSON.stringify(executeSystemOperation.mock.calls[0])).not.toContain('"payload"');
  });

  it('refuses DLQ redrive unless every authoritative machine safety gate passes', async () => {
    const unsafe = { ...systemPayload, queues: [{ ...systemPayload.queues[0], preview: {
      ...systemPayload.queues[0]?.preview, billingSafe: false } }] };
    const executeSystemOperation = vi.fn();
    const action = createSystemMutationAction({ context: { sessionToken: await session(['system:dlq-redrive']), signingKey },
      port: { executeSystemOperation, async getSystemSnapshot() { return unsafe; } } as unknown as GovernanceOperationsPort,
      trustedObservabilityOrigins });
    const form = mutationForm('resourceId', 'refund-events', 8, 'dlq-preview-signed-token');
    form.set('operation', 'REDRIVE_DLQ');
    await expect(action(form)).rejects.toThrow('DLQ 重放安全条件不满足');
    expect(executeSystemOperation).not.toHaveBeenCalled();
  });

  it('uses system:config-write for a validated public-setting draft and keeps its secret write-only', async () => {
    const draftSnapshot = { ...systemPayload, config: { ...systemPayload.config,
      allowedOperations: ['SAVE_SETTING_DRAFT', 'REDRIVE_DLQ'], preview: { ...systemPayload.config.preview,
        operation: 'SAVE_SETTING_DRAFT', preflightToken: 'settings-draft-token', resultVersion: 21 } } };
    const executeSystemOperation = vi.fn(async (input: Parameters<GovernanceOperationsPort['executeSystemOperation']>[0]) => {
      void input;
      return { auditRecordId: auditId, idempotencyKey: intentId, ok: true,
        operation: 'SAVE_SETTING_DRAFT', requestId: roleId, resourceId: 'public-settings', version: 21 };
    });
    const action = createSystemMutationAction({ context: { sessionToken: await session(['system:config-write']), signingKey },
      port: { executeSystemOperation, async getSystemSnapshot() { return draftSnapshot; } } as unknown as GovernanceOperationsPort,
      trustedObservabilityOrigins });
    const form = mutationForm('resourceId', 'public-settings', 20, 'settings-draft-token');
    form.set('operation', 'SAVE_SETTING_DRAFT'); form.set('publicDomain', 'https://app.example.com');
    form.set('publicCallbackUrl', 'https://api.example.com/callback-v2'); form.set('replacementSecret', 'replacement-secret-value');
    await expect(action(form)).resolves.toMatchObject({ operation: 'SAVE_SETTING_DRAFT', version: 21 });
    expect(executeSystemOperation.mock.calls[0]?.[0].draft).toMatchObject({
      publicDomain: 'https://app.example.com/', replacementSecret: 'replacement-secret-value',
    });
  });

  it('rejects sensitive operation reasons including cookies and plain signatures', async () => {
    const action = createSystemMutationAction({ context: { sessionToken: await session(['system:dlq-redrive']), signingKey },
      port: { executeSystemOperation: vi.fn(), async getSystemSnapshot() { return systemPayload; } } as unknown as GovernanceOperationsPort,
      trustedObservabilityOrigins });
    for (const reason of ['Cookie: session=abc', 'Cookie=session=abc', 'Set-Cookie: auth=x', 'Set-Cookie=auth=x', 'Wechatpay-Signature: x', 'signature=abc']) {
      const form = mutationForm('resourceId', 'refund-events', 8, 'dlq-preview-signed-token');
      form.set('operation', 'REDRIVE_DLQ'); form.set('reason', reason);
      await expect(action(form)).rejects.toThrow('系统操作字段无效');
    }
  });

  it('uses trusted headers, no-store and Idempotency-Key at the HTTP boundary', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('{}', {
      headers: { 'Content-Type': 'application/json' }, status: 200,
    }));
    const port = createHttpGovernanceOperationsPort({
      apiUrl: 'https://operations.internal',
      kmsIdentityReference: 'kms://admin-web/operations-client',
    }, { fetchImpl });
    await port.executeSystemOperation({
      actorId,
      audit: { idempotencyKey: intentId, reason: '已核对影响范围并执行' },
      confirmed: true,
      expectedVersion: 8,
      operation: 'REDRIVE_DLQ',
      preflightToken: 'dlq-preview-signed-token',
      requestContext: createOutboundRequestContext(() => traceId, () => intentId),
      resourceId: 'refund-events',
      scope: 'ALL',
      trustedSessionToken: 'trusted-session-token',
    });
    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const headers = new Headers(init?.headers);
    expect(init?.cache).toBe('no-store');
    expect(headers.get('Idempotency-Key')).toBe(intentId);
    expect(headers.get('X-Service-Identity-Kms-Ref')).toBe('kms://admin-web/operations-client');
  });
});
