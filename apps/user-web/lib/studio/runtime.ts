import { CapabilityDocumentSchema } from '@repo/capability-schema';

import type {
  JsonSchemaValue,
  StudioCapabilityDocument,
  StudioJsonSchema,
  StudioModelOption,
  StudioProviderOption,
  StudioQuote,
  StudioQuoteRequest,
  StudioTaskAccepted,
} from './types';

export const SMART_ROUTING_PROMISE = '智能路由将在已报价点数内选择满足偏好的可用模型';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, code: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(code);
  return value;
}

function requireString(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(code);
  return value;
}

function requireStringArray(value: unknown, code: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(code);
  }
  return value;
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  code: string,
): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) throw new Error(code);
}

function assertSchemaNode(value: unknown): asserts value is StudioJsonSchema {
  const node = requireRecord(value, 'INVALID_CAPABILITY_SCHEMA');
  if (node.$defs !== undefined) {
    const definitions = requireRecord(node.$defs, 'INVALID_CAPABILITY_DEFINITIONS');
    for (const child of Object.values(definitions)) assertSchemaNode(child);
  }
  if (node.properties !== undefined) {
    const properties = requireRecord(node.properties, 'INVALID_CAPABILITY_PROPERTIES');
    for (const child of Object.values(properties)) assertSchemaNode(child);
  }
  if (node.enum !== undefined) {
    if (
      !Array.isArray(node.enum) ||
      !node.enum.every(
        (item) => item === null || ['string', 'number', 'boolean'].includes(typeof item),
      )
    ) {
      throw new Error('INVALID_CAPABILITY_ENUM');
    }
  }
  if (node.required !== undefined) requireStringArray(node.required, 'INVALID_CAPABILITY_REQUIRED');
  for (const keyword of ['allOf', 'anyOf', 'oneOf'] as const) {
    if (node[keyword] !== undefined) {
      if (!Array.isArray(node[keyword])) throw new Error('INVALID_CAPABILITY_COMBINATOR');
      for (const child of node[keyword]) assertSchemaNode(child);
    }
  }
  for (const keyword of ['not', 'if', 'then', 'else'] as const) {
    if (node[keyword] !== undefined) assertSchemaNode(node[keyword]);
  }
  if (node.items !== undefined) {
    if (Array.isArray(node.items)) {
      for (const child of node.items) assertSchemaNode(child);
    } else {
      assertSchemaNode(node.items);
    }
  }
  if (isRecord(node.additionalProperties)) assertSchemaNode(node.additionalProperties);
  if (node.dependentRequired !== undefined) {
    const dependencies = requireRecord(node.dependentRequired, 'INVALID_CAPABILITY_DEPENDENCIES');
    for (const fields of Object.values(dependencies)) {
      requireStringArray(fields, 'INVALID_CAPABILITY_DEPENDENCIES');
    }
  }
}

function assertUiSchema(value: unknown): void {
  const ui = requireRecord(value, 'INVALID_CAPABILITY_UI');
  assertExactKeys(ui, ['order', 'groups', 'fields', 'conditions'], 'UNKNOWN_CAPABILITY_UI_KEY');
  requireStringArray(ui.order, 'INVALID_CAPABILITY_ORDER');
  if (!Array.isArray(ui.groups)) throw new Error('INVALID_CAPABILITY_GROUPS');
  for (const rawGroup of ui.groups) {
    const group = requireRecord(rawGroup, 'INVALID_CAPABILITY_GROUP');
    assertExactKeys(group, ['key', 'title', 'fields'], 'UNKNOWN_CAPABILITY_GROUP_KEY');
    requireString(group.key, 'INVALID_CAPABILITY_GROUP_KEY');
    requireString(group.title, 'INVALID_CAPABILITY_GROUP_TITLE');
    requireStringArray(group.fields, 'INVALID_CAPABILITY_GROUP_FIELDS');
  }
  if (ui.fields !== undefined) {
    const fields = requireRecord(ui.fields, 'INVALID_CAPABILITY_UI_FIELDS');
    for (const rawMetadata of Object.values(fields)) {
      const metadata = requireRecord(rawMetadata, 'INVALID_CAPABILITY_UI_FIELD');
      assertExactKeys(
        metadata,
        ['label', 'widget', 'help', 'placeholder', 'unit', 'options'],
        'UNKNOWN_CAPABILITY_FIELD_KEY',
      );
      for (const key of ['label', 'widget', 'help', 'placeholder', 'unit'] as const) {
        if (metadata[key] !== undefined && typeof metadata[key] !== 'string') {
          throw new Error('INVALID_CAPABILITY_UI_FIELD');
        }
      }
      if (metadata.options !== undefined) {
        if (!Array.isArray(metadata.options)) throw new Error('INVALID_CAPABILITY_OPTIONS');
        for (const rawOption of metadata.options) {
          const option = requireRecord(rawOption, 'INVALID_CAPABILITY_OPTION');
          assertExactKeys(option, ['value', 'label'], 'UNKNOWN_CAPABILITY_OPTION_KEY');
          requireString(option.label, 'INVALID_CAPABILITY_OPTION_LABEL');
          if (
            !['string', 'number', 'boolean'].includes(typeof option.value) &&
            option.value !== null
          ) {
            throw new Error('INVALID_CAPABILITY_OPTION_VALUE');
          }
        }
      }
    }
  }
  if (ui.conditions !== undefined) {
    if (!Array.isArray(ui.conditions)) throw new Error('INVALID_CAPABILITY_CONDITIONS');
    for (const rawCondition of ui.conditions) {
      const condition = requireRecord(rawCondition, 'INVALID_CAPABILITY_CONDITION');
      assertExactKeys(condition, ['field', 'when'], 'UNKNOWN_CAPABILITY_CONDITION_KEY');
      requireString(condition.field, 'INVALID_CAPABILITY_CONDITION_FIELD');
      const when = requireRecord(condition.when, 'INVALID_CAPABILITY_CONDITION_WHEN');
      assertExactKeys(
        when,
        ['field', 'equals', 'notEquals', 'in'],
        'UNKNOWN_CAPABILITY_CONDITION_WHEN_KEY',
      );
      requireString(when.field, 'INVALID_CAPABILITY_CONDITION_DEPENDENCY');
      if (when.in !== undefined && !Array.isArray(when.in)) {
        throw new Error('INVALID_CAPABILITY_CONDITION_VALUES');
      }
    }
  }
}

export function parseProviders(value: unknown): readonly StudioProviderOption[] {
  if (!Array.isArray(value)) throw new Error('INVALID_PROVIDER_CATALOG');
  const seen = new Set<string>();
  return value.map((rawProvider) => {
    const provider = requireRecord(rawProvider, 'INVALID_PROVIDER');
    const id = requireString(provider.id, 'INVALID_PROVIDER_ID');
    const name = requireString(provider.name, 'INVALID_PROVIDER_NAME');
    if (seen.has(id)) throw new Error('DUPLICATE_PROVIDER_ID');
    seen.add(id);
    return { id, name };
  });
}

export function parseModels(value: unknown): readonly StudioModelOption[] {
  if (!Array.isArray(value)) throw new Error('INVALID_MODEL_CATALOG');
  const seen = new Set<string>();
  return value.map((rawModel) => {
    const model = requireRecord(rawModel, 'INVALID_MODEL');
    const id = requireString(model.id, 'INVALID_MODEL_ID');
    const providerId = requireString(model.providerId, 'INVALID_MODEL_PROVIDER');
    const name = requireString(model.name, 'INVALID_MODEL_NAME');
    const capabilityVersion = requireString(
      model.capabilityVersion,
      'INVALID_MODEL_CAPABILITY_VERSION',
    );
    if (!['ACTIVE', 'MAINTENANCE', 'DISABLED'].includes(String(model.status))) {
      throw new Error('INVALID_MODEL_STATUS');
    }
    if (seen.has(id)) throw new Error('DUPLICATE_MODEL_ID');
    seen.add(id);
    return {
      id,
      providerId,
      name,
      status: model.status as StudioModelOption['status'],
      capabilityVersion,
    };
  });
}

export function assertCatalogConsistency(
  providers: readonly StudioProviderOption[],
  models: readonly StudioModelOption[],
): void {
  const providerIds = new Set(providers.map((provider) => provider.id));
  if (models.some((model) => !providerIds.has(model.providerId))) {
    throw new Error('MODEL_REFERENCES_UNKNOWN_PROVIDER');
  }
}

export function parseCapability(value: unknown): StudioCapabilityDocument {
  if (!CapabilityDocumentSchema.safeParse(value).success) throw new Error('INVALID_CAPABILITY');
  const raw = requireRecord(value, 'INVALID_CAPABILITY');
  assertExactKeys(
    raw,
    ['schemaVersion', 'capabilityVersion', 'mode', 'jsonSchema', 'uiSchema', 'costDimensions'],
    'UNKNOWN_CAPABILITY_KEY',
  );
  requireString(raw.capabilityVersion, 'INVALID_CAPABILITY_VERSION');
  assertSchemaNode(raw.jsonSchema);
  assertUiSchema(raw.uiSchema);
  return value as StudioCapabilityDocument;
}

export function stableDeepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => stableDeepEqual(item, right[index]))
    );
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && stableDeepEqual(left[key], right[key]),
    )
  );
}

function parseQuoteShape(value: unknown): StudioQuote {
  const quote = requireRecord(value, 'INVALID_QUOTE');
  requireString(quote.id, 'INVALID_QUOTE_ID');
  requireString(quote.capabilityVersion, 'INVALID_QUOTE_CAPABILITY_VERSION');
  requireRecord(quote.parameters, 'INVALID_QUOTE_PARAMETERS');
  if (!/^\d+$/.test(requireString(quote.quotedPoints, 'INVALID_QUOTED_POINTS'))) {
    throw new Error('INVALID_QUOTED_POINTS');
  }
  const expiresAt = requireString(quote.expiresAt, 'INVALID_QUOTE_EXPIRY');
  if (!Number.isFinite(Date.parse(expiresAt))) throw new Error('INVALID_QUOTE_EXPIRY');
  requireString(quote.failureRefundRule, 'INVALID_REFUND_RULE');
  requireString(quote.cancellationRule, 'INVALID_CANCELLATION_RULE');
  if (!Array.isArray(quote.parameterSummary)) throw new Error('INVALID_QUOTE_SUMMARY');
  for (const rawItem of quote.parameterSummary) {
    const item = requireRecord(rawItem, 'INVALID_QUOTE_SUMMARY_ITEM');
    requireString(item.key, 'INVALID_QUOTE_SUMMARY_KEY');
    requireString(item.label, 'INVALID_QUOTE_SUMMARY_LABEL');
    if (typeof item.value !== 'string') throw new Error('INVALID_QUOTE_SUMMARY_VALUE');
    if (item.unit !== undefined && typeof item.unit !== 'string') {
      throw new Error('INVALID_QUOTE_SUMMARY_UNIT');
    }
  }
  const routing = requireRecord(quote.routing, 'INVALID_QUOTE_ROUTING');
  if (routing.kind === 'SMART_ROUTING') {
    requireString(routing.promise, 'INVALID_QUOTE_ROUTING_PROMISE');
  } else if (routing.kind === 'EXACT_MODEL') {
    requireString(routing.modelId, 'INVALID_QUOTE_MODEL_ID');
    requireString(routing.modelName, 'INVALID_QUOTE_MODEL_NAME');
  } else {
    throw new Error('INVALID_QUOTE_ROUTING_KIND');
  }
  return value as StudioQuote;
}

function summaryValue(document: StudioCapabilityDocument, field: string, value: unknown): string {
  const option = document.uiSchema.fields?.[field]?.options?.find(
    (candidate) => candidate.value === (value as JsonSchemaValue),
  );
  if (option) return option.label;
  if (typeof value === 'boolean') return value ? '开启' : '关闭';
  return String(value);
}

function deriveParameterSummary(
  document: StudioCapabilityDocument,
  parameters: Readonly<Record<string, unknown>>,
): StudioQuote['parameterSummary'] {
  const summary = document.uiSchema.order.flatMap((field) => {
    const value = parameters[field];
    if (value === undefined) return [];
    const metadata = document.uiSchema.fields?.[field];
    const item = {
      key: field,
      label: metadata?.label ?? document.jsonSchema.properties?.[field]?.title ?? field,
      value: summaryValue(document, field, value),
    };
    return [metadata?.unit ? { ...item, unit: metadata.unit } : item];
  });
  const summaryKeys = new Set(summary.map((item) => item.key));
  if (
    summaryKeys.size !== summary.length ||
    Object.keys(parameters).some((field) => !summaryKeys.has(field))
  ) {
    throw new Error('QUOTE_SUMMARY_DERIVATION_MISMATCH');
  }
  return summary;
}

export function parseQuote(
  value: unknown,
  request: StudioQuoteRequest,
  document: StudioCapabilityDocument,
  exactModel?: StudioModelOption,
): StudioQuote {
  const quote = parseQuoteShape(value);
  if (
    quote.capabilityVersion !== request.capabilityVersion ||
    !stableDeepEqual(quote.parameters, request.parameters)
  ) {
    throw new Error('QUOTE_SNAPSHOT_MISMATCH');
  }
  if (request.routing.kind === 'SMART' && quote.routing.kind !== 'SMART_ROUTING') {
    throw new Error('QUOTE_ROUTING_MISMATCH');
  }
  if (
    request.routing.kind === 'EXACT_MODEL' &&
    (quote.routing.kind !== 'EXACT_MODEL' || quote.routing.modelId !== request.routing.modelId)
  ) {
    throw new Error('QUOTE_ROUTING_MISMATCH');
  }
  const routing: StudioQuote['routing'] =
    request.routing.kind === 'SMART'
      ? { kind: 'SMART_ROUTING', promise: SMART_ROUTING_PROMISE }
      : exactModel?.id === request.routing.modelId
        ? { kind: 'EXACT_MODEL', modelId: exactModel.id, modelName: exactModel.name }
        : (() => {
            throw new Error('QUOTE_MODEL_CATALOG_MISMATCH');
          })();
  return {
    ...quote,
    routing,
    parameterSummary: deriveParameterSummary(document, request.parameters),
  };
}

export function parseTaskAccepted(value: unknown): StudioTaskAccepted {
  const task = requireRecord(value, 'INVALID_TASK_ACCEPTANCE');
  const taskId = requireString(task.taskId, 'INVALID_TASK_ID');
  if (task.status !== 'QUEUED') throw new Error('INVALID_TASK_STATUS');
  return { taskId, status: 'QUEUED' };
}
