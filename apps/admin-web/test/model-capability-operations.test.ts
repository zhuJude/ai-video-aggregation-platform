/* eslint-disable @typescript-eslint/require-await -- async fakes model protected upstream ports. */

import { describe, expect, it, vi } from 'vitest';

import {
  createCapabilityAction,
  loadModelCapabilityView,
  loadModelDirectoryView,
  parseStrictCapabilityViewPayload,
} from '../lib/model-capability-operations';
import { createOutboundRequestContext } from '../lib/outbound-request-context';
import { signAdminSession } from '../lib/session-auth';

const modelId = '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f';
const providerId = '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f';
const actorId = '0198f7a4-c6d3-7b39-8a4e-73af0c1d2e3f';
const otherAdminId = '0198f7a4-c6d4-7b39-8a4e-73af0c1d2e3f';
const versionId = '0198f7a4-c6d5-7b39-8a4e-73af0c1d2e3f';
const publishedVersionId = '0198f7a4-c6d6-7b39-8a4e-73af0c1d2e3f';
const intentId = '0198f7a4-c6d7-7b39-8a4e-73af0c1d2e3f';
const auditRecordId = '0198f7a4-c6d8-7b39-8a4e-73af0c1d2e3f';
const requestId = '0198f7a4-c6d9-7b39-8a4e-73af0c1d2e3f';
const nextVersionId = '0198f7a4-c6da-7b39-8a4e-73af0c1d2e3f';
const sessionId = '0198f7a4-c6db-7b39-8a4e-73af0c1d2e3f';
const signingKey = 'model-capability-test-signing-key-at-least-32-bytes';
const requestContext = createOutboundRequestContext(
  () => '00112233445566778899aabbccddeeff',
  () => '0198f7a4-c6dc-7b39-8a4e-73af0c1d2e3f',
);

const definition = {
  costDimensions: ['duration'],
  providerMapping: { duration: 'duration_seconds', prompt: 'prompt' },
  schema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    additionalProperties: false,
    properties: {
      duration: { default: 5, enum: [5, 10], maximum: 10, minimum: 5, type: 'integer' },
      prompt: { maxLength: 1000, minLength: 1, type: 'string' },
    },
    required: ['prompt', 'duration'],
    type: 'object',
  },
  uiSchema: {
    fields: [
      { label: '提示词', name: 'prompt', order: 1 },
      { label: '时长', name: 'duration', order: 2, unit: '秒' },
    ],
  },
} as const;

const capability = {
  assignedAdminIds: [actorId],
  definition,
  history: [
    {
      createdAt: '2026-08-27T00:00:00.000Z',
      id: publishedVersionId,
      status: 'PUBLISHED',
      version: 6,
    },
  ],
  model: { code: 'mock-video-v1', displayName: 'Mock Video V1', id: modelId, providerId },
  ownerAdminId: actorId,
  publishedDefinition: definition,
  sourceUpdatedAt: '2026-08-28T00:00:00.000Z',
  status: 'DRAFT',
  version: 7,
  versionId,
} as const;

async function context(
  permissions: readonly ('models:publish' | 'models:read' | 'models:rollback' | 'models:write')[],
  dataScope: 'ALL' | 'ASSIGNED' | 'OWN' = 'ALL',
) {
  const sessionToken = await signAdminSession(
    {
      dataScope,
      expiresAt: Date.now() + 60_000,
      permissions,
      sessionInstanceId: sessionId,
      subjectId: actorId,
    },
    signingKey,
  );
  return { sessionToken, signingKey };
}

function commandForm(kind: 'CREATE_DRAFT' | 'PUBLISH' | 'ROLLBACK' | 'SAVE' | 'VALIDATE') {
  const form = new FormData();
  form.set('kind', kind);
  form.set('modelId', modelId);
  form.set('expectedVersion', '7');
  form.set('intentId', intentId);
  form.set('sourceVersionId', versionId);
  if (kind === 'PUBLISH' || kind === 'SAVE' || kind === 'VALIDATE')
    form.set('definition', JSON.stringify(definition));
  if (kind === 'PUBLISH' || kind === 'ROLLBACK') {
    form.set('confirmed', 'true');
    form.set('modelCode', 'mock-video-v1');
    form.set('reason', '运营发布审批完成');
  }
  if (kind === 'PUBLISH') form.set('preflightToken', 'pf_abcdefghijklmnopqrstuvwxyz123456');
  if (kind === 'ROLLBACK') form.set('targetVersionId', publishedVersionId);
  return form;
}

describe('model capability server boundary', () => {
  it('rejects proxies and accessors without invoking a getter', () => {
    expect(() => parseStrictCapabilityViewPayload(new Proxy(capability, {}))).toThrow(
      '模型能力响应无效',
    );
    let reads = 0;
    const hostile = { ...capability } as Record<string, unknown>;
    Object.defineProperty(hostile, 'status', {
      enumerable: true,
      get() {
        reads += 1;
        return 'DRAFT';
      },
    });
    expect(() => parseStrictCapabilityViewPayload(hostile)).toThrow('模型能力响应无效');
    expect(reads).toBe(0);
  });

  it('enforces directory scope again even when upstream over-returns', async () => {
    const row = {
      assignedAdminIds: [],
      code: 'mock-video-v1',
      displayName: 'Mock',
      draftVersion: 7,
      id: modelId,
      ownerAdminId: otherAdminId,
      providerId,
      providerName: 'Provider',
      publishedVersion: 6,
      sourceUpdatedAt: '2026-08-28T00:00:00.000Z',
      status: 'PUBLISHED',
    } as const;
    const view = await loadModelDirectoryView({
      context: await context(['models:read'], 'OWN'),
      createRequestContext: () => requestContext,
      port: {
        async listModels() {
          return {
            items: [row, { ...row, id: nextVersionId, ownerAdminId: actorId }],
            partialFields: [],
            sourceUpdatedAt: row.sourceUpdatedAt,
          };
        },
      },
    });
    expect(view.items.map((item) => item.id)).toEqual([nextVersionId]);
  });

  it('checks detail data scope and strips authorization fields from client props', async () => {
    const allowed = await loadModelCapabilityView(modelId, {
      context: await context(['models:read'], 'ASSIGNED'),
      createRequestContext: () => requestContext,
      port: {
        async getCapability() {
          return capability;
        },
      },
    });
    expect(allowed.capability).not.toHaveProperty('ownerAdminId');
    expect(allowed.capability).not.toHaveProperty('assignedAdminIds');
    await expect(
      loadModelCapabilityView(modelId, {
        context: await context(['models:read'], 'OWN'),
        createRequestContext: () => requestContext,
        port: {
          async getCapability() {
            return { ...capability, ownerAdminId: otherAdminId };
          },
        },
      }),
    ).rejects.toThrow('数据范围');
  });

  it('rejects missing publish permission before reading or writing', async () => {
    const read = vi.fn();
    const execute = vi.fn();
    await expect(
      createCapabilityAction({
        context: await context(['models:write']),
        createRequestContext: () => requestContext,
        detailPort: { getCapability: read },
        port: { execute },
      })(commandForm('PUBLISH')),
    ).rejects.toThrow('权限不足');
    expect(read).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('rechecks status, scope, version and high-risk confirmation before publish', async () => {
    const execute = vi.fn(async () => ({
      auditRecordId,
      idempotencyKey: intentId,
      kind: 'PUBLISH',
      modelId,
      requestId,
      sourceVersionId: versionId,
      status: 'PUBLISHED',
      targetVersionId: null,
      version: 8,
      versionId: nextVersionId,
    }));
    const action = createCapabilityAction({
      context: await context(['models:publish'], 'OWN'),
      createRequestContext: () => requestContext,
      detailPort: {
        async getCapability() {
          return capability;
        },
      },
      port: { execute },
    });
    const form = commandForm('PUBLISH');
    const receipt = await action(form);
    expect(receipt).toMatchObject({ modelId, ok: true, status: 'PUBLISHED', version: 8 });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId,
        expectedVersion: 7,
        kind: 'PUBLISH',
        audit: { idempotencyKey: intentId, reason: '运营发布审批完成' },
      }),
    );

    const stale = commandForm('PUBLISH');
    stale.set('expectedVersion', '6');
    await expect(action(stale)).rejects.toThrow('已更新');
    const unconfirmed = commandForm('PUBLISH');
    unconfirmed.delete('confirmed');
    await expect(action(unconfirmed)).rejects.toThrow('确认高风险');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('accepts rollback only to an explicit published history version', async () => {
    const execute = vi.fn(async () => ({
      auditRecordId,
      idempotencyKey: intentId,
      kind: 'ROLLBACK',
      modelId,
      requestId,
      sourceVersionId: versionId,
      status: 'PUBLISHED',
      targetVersionId: publishedVersionId,
      version: 8,
      versionId: nextVersionId,
    }));
    const action = createCapabilityAction({
      context: await context(['models:rollback']),
      createRequestContext: () => requestContext,
      detailPort: {
        async getCapability() {
          return {
            ...capability,
            history: [
              ...capability.history,
              {
                createdAt: capability.sourceUpdatedAt,
                id: versionId.toUpperCase(),
                status: 'PUBLISHED' as const,
                version: 7,
              },
            ],
          };
        },
      },
      port: {
        execute,
        async previewRollback() {
          return {
            diff: { added: [], changed: ['duration'], removed: [] },
            expiresAt: '2099-09-11T00:05:00.000Z',
            impact: '恢复已发布能力版本并影响后续任务',
            modelId,
            preflightToken: 'pf_rollbackpreviewtoken1234567890',
            sourceVersionId: versionId,
            targetVersionId: publishedVersionId,
            version: 7,
          };
        },
      },
    });
    const invalid = commandForm('ROLLBACK');
    invalid.set('targetVersionId', versionId);
    await expect(action(invalid)).rejects.toThrow('回滚目标版本无效');
    const uppercaseCurrent = commandForm('ROLLBACK');
    uppercaseCurrent.set('targetVersionId', versionId.toUpperCase());
    await expect(action(uppercaseCurrent)).rejects.toThrow('回滚目标版本无效');
    await expect(action(commandForm('ROLLBACK'))).resolves.toMatchObject({
      status: 'PUBLISHED',
      version: 8,
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('binds rollback to a fresh authoritative preview before mutation', async () => {
    const previewRollback = vi.fn(async () => ({
      diff: { added: [], changed: ['duration'], removed: [] },
      expiresAt: '2099-09-11T00:05:00.000Z',
      impact: '恢复已发布能力版本并影响后续任务',
      modelId,
      preflightToken: 'pf_rollbackpreviewtoken1234567890',
      sourceVersionId: versionId,
      targetVersionId: publishedVersionId,
      version: 7,
    }));
    const execute = vi.fn(async () => ({
      auditRecordId,
      idempotencyKey: intentId,
      kind: 'ROLLBACK',
      modelId,
      requestId,
      sourceVersionId: versionId,
      status: 'PUBLISHED',
      targetVersionId: publishedVersionId,
      version: 8,
      versionId: nextVersionId,
    }));
    const action = createCapabilityAction({
      context: await context(['models:rollback']),
      createRequestContext: () => requestContext,
      detailPort: {
        async getCapability() {
          return capability;
        },
      },
      port: { execute, previewRollback } as never,
    });

    await action(commandForm('ROLLBACK'));

    expect(previewRollback).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedVersion: 7,
        modelId,
        sourceVersionId: versionId,
        targetVersionId: publishedVersionId,
      }),
    );
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'ROLLBACK',
        preflightToken: 'pf_rollbackpreviewtoken1234567890',
        targetVersionId: publishedVersionId,
      }),
    );
  });

  it('creates a new draft only from the current immutable published version', async () => {
    const execute = vi.fn(async () => ({
      auditRecordId,
      idempotencyKey: intentId,
      kind: 'CREATE_DRAFT',
      modelId,
      requestId,
      sourceVersionId: versionId,
      status: 'DRAFT',
      targetVersionId: null,
      version: 8,
      versionId: nextVersionId,
    }));
    const action = createCapabilityAction({
      context: await context(['models:write']),
      createRequestContext: () => requestContext,
      detailPort: {
        async getCapability() {
          return { ...capability, status: 'PUBLISHED' as const };
        },
      },
      port: { execute },
    });
    await expect(action(commandForm('CREATE_DRAFT'))).resolves.toMatchObject({
      status: 'DRAFT',
      version: 8,
    });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'CREATE_DRAFT',
        sourceVersionId: versionId,
      }),
    );
  });

  it('allows a publish-only approver to run authoritative validation', async () => {
    const execute = vi.fn(async () => ({
      diff: { added: [], changed: [], removed: [] },
      errors: [],
      expectedVersion: 7,
      modelId,
      preflightToken: 'pf_abcdefghijklmnopqrstuvwxyz123456',
      pricingImpact: '无',
      valid: true,
    }));
    const action = createCapabilityAction({
      context: await context(['models:publish']),
      createRequestContext: () => requestContext,
      detailPort: {
        async getCapability() {
          return capability;
        },
      },
      port: { execute },
    });
    await expect(action(commandForm('VALIDATE'))).resolves.toMatchObject({ valid: true });
  });

  it('rejects a mutation receipt that is not bound to the command', async () => {
    const action = createCapabilityAction({
      context: await context(['models:publish']),
      createRequestContext: () => requestContext,
      detailPort: {
        async getCapability() {
          return capability;
        },
      },
      port: {
        async execute() {
          return {
            auditRecordId,
            modelId,
            requestId,
            status: 'PUBLISHED',
            version: 8,
            versionId: nextVersionId,
          };
        },
      },
    });
    await expect(action(commandForm('PUBLISH'))).rejects.toThrow('回执无效');
  });

  it('uses a kind-specific FormData allowlist for high-risk commands', async () => {
    const execute = vi.fn();
    const action = createCapabilityAction({
      context: await context(['models:publish', 'models:rollback']),
      createRequestContext: () => requestContext,
      detailPort: {
        async getCapability() {
          return capability;
        },
      },
      port: { execute },
    });
    const publish = commandForm('PUBLISH');
    publish.set('targetVersionId', publishedVersionId);
    await expect(action(publish)).rejects.toThrow('字段无效');
    const rollback = commandForm('ROLLBACK');
    rollback.set('preflightToken', 'pf_abcdefghijklmnopqrstuvwxyz123456');
    await expect(action(rollback)).rejects.toThrow('字段无效');
    expect(execute).not.toHaveBeenCalled();
  });
});
