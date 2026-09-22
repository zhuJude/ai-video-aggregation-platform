import { types as utilTypes } from 'node:util';

import {
  createOutboundRequestContext,
  parseOutboundRequestContext,
  type OutboundRequestContext,
} from './outbound-request-context';
import {
  diffCapabilityFields,
  parseCapabilityDefinition,
  parseCapabilityViewPayload,
  parseModelDirectoryPayload,
  validateCapabilityDefinition,
  type CapabilityDefinition,
  type CapabilityDiff,
  type CapabilityView,
  type ModelDirectoryPayload,
} from './model-capabilities';
import { type DataScope, hasPermission } from './permissions';
import { isUtcIso8601Z } from './frozen-scalars';
import {
  assertAdminDataScope,
  requireAdminAnyAuthorization,
  requireAdminAuthorization,
  type ServerGuardContext,
} from './server-guard';
import { isSameUuidV7, isUuidV7 } from './uuid-v7';

export type CapabilityCommandKind = 'CREATE_DRAFT' | 'PUBLISH' | 'ROLLBACK' | 'SAVE' | 'VALIDATE';

export type CapabilityValidationReceipt = Readonly<{
  diff: CapabilityDiff;
  errors: readonly string[];
  expectedVersion: number;
  modelId: string;
  preflightToken: string;
  pricingImpact: string;
  valid: boolean;
}>;

export type CapabilityMutationReceipt = Readonly<{
  auditRecordId: string;
  idempotencyKey: string;
  kind: Exclude<CapabilityCommandKind, 'VALIDATE'>;
  modelId: string;
  ok: true;
  requestId: string;
  sourceVersionId: string;
  status: 'DRAFT' | 'PUBLISHED';
  targetVersionId: string | null;
  version: number;
  versionId: string;
}>;

export type CapabilityRollbackPreviewReceipt = Readonly<{
  diff: CapabilityDiff;
  expiresAt: string;
  impact: string;
  modelId: string;
  preflightToken: string;
  sourceVersionId: string;
  targetVersionId: string;
  version: number;
}>;

type CommandInput = Readonly<{
  actorId: string;
  audit: Readonly<{ idempotencyKey: string; reason: string }>;
  definition?: CapabilityDefinition;
  expectedVersion: number;
  kind: CapabilityCommandKind;
  modelId: string;
  preflightToken?: string;
  requestContext: OutboundRequestContext;
  scope: DataScope;
  sourceVersionId: string;
  targetVersionId?: string;
  trustedSessionToken: string;
}>;

export interface ModelDirectoryPort {
  listModels(
    input: Readonly<{
      requestContext: OutboundRequestContext;
      scope: DataScope;
      trustedSessionToken: string;
    }>,
  ): Promise<unknown>;
}

export interface ModelCapabilityPort {
  getCapability(
    input: Readonly<{
      modelId: string;
      requestContext: OutboundRequestContext;
      scope: DataScope;
      trustedSessionToken: string;
    }>,
  ): Promise<unknown>;
}

export interface ModelCapabilityCommandPort {
  execute(input: CommandInput): Promise<unknown>;
  previewRollback?(input: Readonly<{
    expectedVersion: number;
    modelId: string;
    requestContext: OutboundRequestContext;
    scope: DataScope;
    sourceVersionId: string;
    targetVersionId: string;
    trustedSessionToken: string;
  }>): Promise<unknown>;
}

function assertNoProxyTree(value: unknown, depth = 0, seen = new Set<object>()): void {
  if (!value || typeof value !== 'object') return;
  if (depth > 24 || utilTypes.isProxy(value) || seen.has(value)) {
    throw new Error('模型能力响应无效');
  }
  seen.add(value);
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) {
    throw new Error('模型能力响应无效');
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) throw new Error('模型能力响应无效');
    assertNoProxyTree(descriptor.value, depth + 1, seen);
  }
  seen.delete(value);
}

export function parseStrictModelDirectoryPayload(value: unknown): ModelDirectoryPayload {
  assertNoProxyTree(value);
  return parseModelDirectoryPayload(value);
}

export function parseStrictCapabilityViewPayload(value: unknown): CapabilityView {
  assertNoProxyTree(value);
  return parseCapabilityViewPayload(value);
}

export function parseStrictCapabilityDefinition(value: unknown): CapabilityDefinition {
  assertNoProxyTree(value);
  return parseCapabilityDefinition(value);
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value))
      return null;
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length || keys.some((key) => !ownKeys.includes(key))) return null;
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return null;
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return null;
  }
}

function safeText(value: unknown, maximum = 256): string | null {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    !/[\p{C}]/u.test(value)
    ? value
    : null;
}

function versionNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : null;
}

function parseDiff(value: unknown): CapabilityDiff | null {
  const diff = exactRecord(value, ['added', 'changed', 'removed']);
  const names = (value: unknown): readonly string[] | null => {
    if (!Array.isArray(value) || value.length > 256) return null;
    const items = (value as readonly unknown[]).filter(
      (item): item is string =>
        typeof item === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(item),
    );
    return items.length === value.length && new Set(items).size === items.length ? items : null;
  };
  const added = names(diff?.added);
  const changed = names(diff?.changed);
  const removed = names(diff?.removed);
  if (!diff || !added || !changed || !removed) return null;
  return Object.freeze({
    added: Object.freeze([...added].sort()),
    changed: Object.freeze([...changed].sort()),
    removed: Object.freeze([...removed].sort()),
  });
}

export function parseCapabilityValidationReceipt(
  value: unknown,
  modelId: string,
  expectedVersion: number,
): CapabilityValidationReceipt {
  const receipt = exactRecord(value, [
    'diff',
    'errors',
    'expectedVersion',
    'modelId',
    'preflightToken',
    'pricingImpact',
    'valid',
  ]);
  const diff = parseDiff(receipt?.diff);
  const rawErrors = receipt?.errors;
  const errors = Array.isArray(rawErrors)
    ? (rawErrors as readonly unknown[]).filter(
        (item): item is string => typeof item === 'string' && Boolean(safeText(item, 300)),
      )
    : null;
  const rawErrorLength = Array.isArray(rawErrors) ? rawErrors.length : -1;
  const pricingImpact = safeText(receipt?.pricingImpact, 500);
  if (
    !receipt ||
    !diff ||
    !errors ||
    errors.length > 100 ||
    errors.length !== rawErrorLength ||
    receipt.modelId !== modelId ||
    receipt.expectedVersion !== expectedVersion ||
    typeof receipt.valid !== 'boolean' ||
    receipt.valid !== (errors.length === 0) ||
    typeof receipt.preflightToken !== 'string' ||
    !/^pf_[A-Za-z0-9_-]{24,256}$/u.test(receipt.preflightToken) ||
    !pricingImpact
  )
    throw new Error('模型能力校验回执无效');
  return Object.freeze({
    diff,
    errors: Object.freeze([...errors]),
    expectedVersion,
    modelId,
    preflightToken: receipt.preflightToken,
    pricingImpact,
    valid: receipt.valid,
  });
}

export function parseCapabilityRollbackPreviewReceipt(
  value: unknown,
  binding: Readonly<{
    expectedVersion: number;
    modelId: string;
    sourceVersionId: string;
    targetVersionId: string;
  }>,
): CapabilityRollbackPreviewReceipt {
  const receipt = exactRecord(value, [
    'diff',
    'expiresAt',
    'impact',
    'modelId',
    'preflightToken',
    'sourceVersionId',
    'targetVersionId',
    'version',
  ]);
  const diff = parseDiff(receipt?.diff);
  const expiresAt = safeText(receipt?.expiresAt, 40);
  const impact = safeText(receipt?.impact, 500);
  if (
    !receipt ||
    !diff ||
    !expiresAt ||
    !isUtcIso8601Z(expiresAt) ||
    Date.parse(expiresAt) <= Date.now() ||
    !impact ||
    !isSameUuidV7(receipt.modelId, binding.modelId) ||
    !isSameUuidV7(receipt.sourceVersionId, binding.sourceVersionId) ||
    !isSameUuidV7(receipt.targetVersionId, binding.targetVersionId) ||
    receipt.version !== binding.expectedVersion ||
    typeof receipt.preflightToken !== 'string' ||
    !/^pf_[A-Za-z0-9_-]{24,256}$/u.test(receipt.preflightToken)
  )
    throw new Error('模型能力回滚预检回执无效');
  return Object.freeze({
    diff,
    expiresAt,
    impact,
    modelId: binding.modelId,
    preflightToken: receipt.preflightToken,
    sourceVersionId: binding.sourceVersionId,
    targetVersionId: binding.targetVersionId,
    version: binding.expectedVersion,
  });
}

export function parseCapabilityMutationReceipt(
  value: unknown,
  modelId: string,
  expectedVersion: number,
  kind: Exclude<CapabilityCommandKind, 'VALIDATE'>,
  binding: Readonly<{
    idempotencyKey: string;
    sourceVersionId: string;
    targetVersionId?: string;
  }>,
): CapabilityMutationReceipt {
  const upstream = exactRecord(value, [
    'auditRecordId',
    'idempotencyKey',
    'kind',
    'modelId',
    'requestId',
    'sourceVersionId',
    'status',
    'targetVersionId',
    'version',
    'versionId',
  ]);
  const internal = upstream
    ? null
    : exactRecord(value, [
        'auditRecordId',
        'idempotencyKey',
        'kind',
        'modelId',
        'ok',
        'requestId',
        'sourceVersionId',
        'status',
        'targetVersionId',
        'version',
        'versionId',
      ]);
  const receipt = upstream ?? internal;
  const version = versionNumber(receipt?.version);
  const expectedStatus = kind === 'SAVE' || kind === 'CREATE_DRAFT' ? 'DRAFT' : 'PUBLISHED';
  const expectedTargetVersionId = binding.targetVersionId ?? null;
  if (
    !receipt ||
    (internal && internal.ok !== true) ||
    receipt.modelId !== modelId ||
    !isUuidV7(receipt.modelId) ||
    !isUuidV7(receipt.auditRecordId) ||
    !isUuidV7(receipt.requestId) ||
    !isUuidV7(receipt.versionId) ||
    receipt.kind !== kind ||
    !isSameUuidV7(receipt.idempotencyKey, binding.idempotencyKey) ||
    !isSameUuidV7(receipt.sourceVersionId, binding.sourceVersionId) ||
    (expectedTargetVersionId === null
      ? receipt.targetVersionId !== null
      : !isSameUuidV7(receipt.targetVersionId, expectedTargetVersionId)) ||
    receipt.status !== expectedStatus ||
    version === null ||
    version <= expectedVersion
  )
    throw new Error('模型能力操作回执无效');
  return Object.freeze({
    auditRecordId: receipt.auditRecordId,
    idempotencyKey: binding.idempotencyKey,
    kind,
    modelId,
    ok: true,
    requestId: receipt.requestId,
    sourceVersionId: binding.sourceVersionId,
    status: expectedStatus,
    targetVersionId: expectedTargetVersionId,
    version,
    versionId: receipt.versionId,
  });
}

export async function loadModelDirectoryView({
  context,
  createRequestContext = createOutboundRequestContext,
  port,
}: Readonly<{
  context?: ServerGuardContext;
  createRequestContext?: () => unknown;
  port: ModelDirectoryPort;
}>) {
  const authorization = await requireAdminAuthorization('models:read', context);
  const requestContext = parseOutboundRequestContext(createRequestContext());
  const payload = parseStrictModelDirectoryPayload(
    await port.listModels({
      requestContext,
      scope: authorization.claims.dataScope,
      trustedSessionToken: authorization.trustedSessionToken,
    }),
  );
  const items = payload.items.filter((model) => {
    if (authorization.claims.dataScope === 'ALL') return true;
    if (authorization.claims.dataScope === 'OWN') {
      return model.ownerAdminId?.toLowerCase() === authorization.claims.subjectId.toLowerCase();
    }
    return model.assignedAdminIds.some(
      (id) => id.toLowerCase() === authorization.claims.subjectId.toLowerCase(),
    );
  });
  return Object.freeze({ ...payload, items: Object.freeze(items) });
}

export async function loadModelCapabilityView(
  modelId: string,
  {
    context,
    createRequestContext = createOutboundRequestContext,
    port,
  }: Readonly<{
    context?: ServerGuardContext;
    createRequestContext?: () => unknown;
    port: ModelCapabilityPort;
  }>,
) {
  if (!isUuidV7(modelId)) throw new Error('模型标识无效');
  const authorization = await requireAdminAuthorization('models:read', context);
  const requestContext = parseOutboundRequestContext(createRequestContext());
  const capability = parseStrictCapabilityViewPayload(
    await port.getCapability({
      modelId,
      requestContext,
      scope: authorization.claims.dataScope,
      trustedSessionToken: authorization.trustedSessionToken,
    }),
  );
  if (capability.model.id.toLowerCase() !== modelId.toLowerCase())
    throw new Error('模型能力响应无效');
  assertAdminDataScope(authorization.claims, capability);
  return Object.freeze({
    capability: Object.freeze({
      definition: capability.definition,
      history: capability.history,
      model: capability.model,
      publishedDefinition: capability.publishedDefinition,
      sourceUpdatedAt: capability.sourceUpdatedAt,
      status: capability.status,
      version: capability.version,
      versionId: capability.versionId,
    }),
    permissions: Object.freeze([...authorization.claims.permissions]),
  });
}

function formString(formData: FormData, key: string): string | null {
  const value = formData.get(key);
  return typeof value === 'string' ? value : null;
}

function parseExpectedVersion(formData: FormData): number {
  const raw = formString(formData, 'expectedVersion');
  if (!raw || !/^[1-9]\d{0,15}$/u.test(raw)) throw new Error('权威版本无效');
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error('权威版本无效');
  return value;
}

function parseDefinitionForm(formData: FormData): CapabilityDefinition {
  const raw = formString(formData, 'definition');
  if (!raw || raw.length > 200_000) throw new Error('能力定义字段无效');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('能力定义字段无效');
  }
  const definition = parseCapabilityDefinition(parsed);
  const errors = validateCapabilityDefinition(definition);
  if (errors.length > 0) throw new Error(errors.join('；'));
  return definition;
}

function validateAllowedKeys(formData: FormData, allowed: readonly string[]): void {
  const set = new Set(allowed);
  if ([...formData.keys()].some((key) => !set.has(key))) throw new Error('模型能力操作字段无效');
}

async function currentForAction(
  modelId: string,
  expectedVersion: number,
  authorization: Awaited<ReturnType<typeof requireAdminAuthorization>>,
  requestContext: OutboundRequestContext,
  detailPort: ModelCapabilityPort,
): Promise<CapabilityView> {
  const current = parseStrictCapabilityViewPayload(
    await detailPort.getCapability({
      modelId,
      requestContext,
      scope: authorization.claims.dataScope,
      trustedSessionToken: authorization.trustedSessionToken,
    }),
  );
  if (current.model.id.toLowerCase() !== modelId.toLowerCase()) throw new Error('模型能力响应无效');
  assertAdminDataScope(authorization.claims, current);
  if (current.version !== expectedVersion) throw new Error('模型能力已更新，请刷新后重试');
  return current;
}

export function createCapabilityAction({
  context,
  createRequestContext = createOutboundRequestContext,
  detailPort,
  port,
}: Readonly<{
  context?: ServerGuardContext;
  createRequestContext?: () => unknown;
  detailPort: ModelCapabilityPort;
  port: ModelCapabilityCommandPort;
}>) {
  return async function capabilityAction(
    formData: FormData,
  ): Promise<CapabilityMutationReceipt | CapabilityValidationReceipt> {
    const kind = formString(formData, 'kind') as CapabilityCommandKind | null;
    if (!kind || !['CREATE_DRAFT', 'PUBLISH', 'ROLLBACK', 'SAVE', 'VALIDATE'].includes(kind))
      throw new Error('模型能力操作无效');
    const permission =
      kind === 'PUBLISH'
        ? 'models:publish'
        : kind === 'ROLLBACK'
          ? 'models:rollback'
          : 'models:write';
    const highRisk = kind === 'PUBLISH' || kind === 'ROLLBACK';
    const commonKeys = ['expectedVersion', 'intentId', 'kind', 'modelId', 'sourceVersionId'];
    const keysByKind: Readonly<Record<CapabilityCommandKind, readonly string[]>> = {
      CREATE_DRAFT: [...commonKeys, 'reason'],
      PUBLISH: [...commonKeys, 'confirmed', 'definition', 'modelCode', 'preflightToken', 'reason'],
      ROLLBACK: [...commonKeys, 'confirmed', 'modelCode', 'reason', 'targetVersionId'],
      SAVE: [...commonKeys, 'definition', 'reason'],
      VALIDATE: [...commonKeys, 'definition', 'reason'],
    };
    validateAllowedKeys(formData, keysByKind[kind]);
    const authorization =
      kind === 'VALIDATE'
        ? await requireAdminAnyAuthorization(['models:write', 'models:publish'], context)
        : await requireAdminAuthorization(permission, context);
    const modelId = formString(formData, 'modelId');
    const intentId = formString(formData, 'intentId');
    const sourceVersionId = formString(formData, 'sourceVersionId');
    const reason =
      formString(formData, 'reason')?.trim() ??
      (kind === 'VALIDATE'
        ? 'validate capability draft'
        : kind === 'CREATE_DRAFT'
          ? 'create capability draft'
          : 'save capability draft');
    if (
      !isUuidV7(modelId) ||
      !isUuidV7(intentId) ||
      !isUuidV7(sourceVersionId) ||
      !safeText(reason, 200)
    )
      throw new Error('模型能力操作字段无效');
    const expectedVersion = parseExpectedVersion(formData);
    const requestContext = parseOutboundRequestContext(createRequestContext());
    const current = await currentForAction(
      modelId,
      expectedVersion,
      authorization,
      requestContext,
      detailPort,
    );
    if (!isSameUuidV7(sourceVersionId, current.versionId))
      throw new Error('模型能力已更新，请刷新后重试');
    if (kind === 'CREATE_DRAFT' && current.status !== 'PUBLISHED')
      throw new Error('只有已发布版本可以创建新草稿');
    if (kind !== 'ROLLBACK' && kind !== 'CREATE_DRAFT' && current.status !== 'DRAFT')
      throw new Error('已发布版本不可修改');
    let definition: CapabilityDefinition | undefined;
    if (kind === 'VALIDATE' || kind === 'SAVE') definition = parseDefinitionForm(formData);
    if (kind === 'PUBLISH') {
      const submitted = parseDefinitionForm(formData);
      if (JSON.stringify(submitted) !== JSON.stringify(current.definition))
        throw new Error('能力草稿尚未保存或已经变化，请保存并重新校验');
    }
    if (highRisk) {
      if (formString(formData, 'confirmed') !== 'true') throw new Error('请确认高风险操作');
      if (formString(formData, 'modelCode') !== current.model.code)
        throw new Error('模型代码确认不匹配');
      if (!safeText(formString(formData, 'reason')?.trim(), 200)) throw new Error('请填写操作原因');
    }
    let targetVersionId: string | undefined;
    let preflightToken: string | undefined;
    if (kind === 'ROLLBACK') {
      targetVersionId = formString(formData, 'targetVersionId') ?? undefined;
      if (
        !isUuidV7(targetVersionId) ||
        isSameUuidV7(targetVersionId, current.versionId) ||
        !current.history.some(
          (entry) =>
            entry.id.toLowerCase() === targetVersionId?.toLowerCase() &&
            entry.status === 'PUBLISHED',
        )
      )
        throw new Error('回滚目标版本无效');
      if (!port.previewRollback) throw new Error('模型能力回滚预检不可用');
      const preview = parseCapabilityRollbackPreviewReceipt(
        await port.previewRollback({
          expectedVersion,
          modelId,
          requestContext,
          scope: authorization.claims.dataScope,
          sourceVersionId,
          targetVersionId,
          trustedSessionToken: authorization.trustedSessionToken,
        }),
        { expectedVersion, modelId, sourceVersionId, targetVersionId },
      );
      preflightToken = preview.preflightToken;
    }
    if (kind === 'PUBLISH') {
      preflightToken = formString(formData, 'preflightToken') ?? undefined;
      if (!preflightToken || !/^pf_[A-Za-z0-9_-]{24,256}$/u.test(preflightToken))
        throw new Error('请先完成权威校验');
    }
    const result = await port.execute({
      actorId: authorization.claims.subjectId,
      audit: Object.freeze({ idempotencyKey: intentId, reason }),
      ...(definition ? { definition } : {}),
      expectedVersion,
      kind,
      modelId,
      ...(preflightToken ? { preflightToken } : {}),
      requestContext,
      scope: authorization.claims.dataScope,
      sourceVersionId,
      ...(targetVersionId ? { targetVersionId } : {}),
      trustedSessionToken: authorization.trustedSessionToken,
    });
    if (kind === 'VALIDATE')
      return parseCapabilityValidationReceipt(result, modelId, expectedVersion);
    return parseCapabilityMutationReceipt(result, modelId, expectedVersion, kind, {
      idempotencyKey: intentId,
      sourceVersionId,
      ...(targetVersionId ? { targetVersionId } : {}),
    });
  };
}

export function capabilityDraftDiff(view: CapabilityView): CapabilityDiff {
  return diffCapabilityFields(view.publishedDefinition, view.definition);
}

export function canWriteCapability(
  permissions: readonly string[],
  status: CapabilityView['status'],
): boolean {
  return status === 'DRAFT' && hasPermission({ permissions }, 'models:write');
}
