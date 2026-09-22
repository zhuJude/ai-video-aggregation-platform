import Ajv2020 from 'ajv/dist/2020.js';

import { isUuidV7 } from './uuid-v7';

export type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | Readonly<{ [key: string]: JsonValue }>;
export type CapabilityUiField = Readonly<{
  condition?: Readonly<{ equals: JsonValue; field: string }>;
  group?: string;
  help?: string;
  label: string;
  mutuallyExclusiveWith?: readonly string[];
  name: string;
  order: number;
  unit?: string;
}>;
export type CapabilityDefinition = Readonly<{
  costDimensions: readonly string[];
  providerMapping: Readonly<Record<string, string>>;
  schema: Readonly<Record<string, JsonValue>>;
  uiSchema: Readonly<{ fields: readonly CapabilityUiField[] }>;
}>;
export type CapabilityVersionSummary = Readonly<{
  createdAt: string;
  id: string;
  status: 'DRAFT' | 'PUBLISHED' | 'ROLLED_BACK';
  version: number;
}>;
export type CapabilityView = Readonly<{
  assignedAdminIds: readonly string[];
  definition: CapabilityDefinition;
  history: readonly CapabilityVersionSummary[];
  model: Readonly<{ code: string; displayName: string; id: string; providerId: string }>;
  ownerAdminId: string | null;
  publishedDefinition: CapabilityDefinition | null;
  sourceUpdatedAt: string;
  status: 'DRAFT' | 'PUBLISHED';
  version: number;
  versionId: string;
}>;
export type CapabilityClientView = Omit<CapabilityView, 'assignedAdminIds' | 'ownerAdminId'>;
export type CapabilityDiff = Readonly<{
  added: readonly string[];
  changed: readonly string[];
  removed: readonly string[];
}>;
export type ModelDirectoryRow = Readonly<{
  assignedAdminIds: readonly string[];
  code: string;
  displayName: string;
  draftVersion: number | null;
  id: string;
  ownerAdminId: string | null;
  providerId: string;
  providerName: string;
  publishedVersion: number | null;
  sourceUpdatedAt: string;
  status: 'DRAFT' | 'PUBLISHED' | 'DISABLED';
}>;
export type ModelDirectoryPayload = Readonly<{
  items: readonly ModelDirectoryRow[];
  partialFields: readonly ('providerName' | 'publishedVersion')[];
  sourceUpdatedAt: string;
}>;

const DRAFT_SCHEMA_URI = 'https://json-schema.org/draft/2020-12/schema';
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;
const SAFE_TEXT = /^[^\p{C}]{1,256}$/u;
const SCHEMA_KEYWORDS = new Set([
  '$defs',
  '$ref',
  '$schema',
  'additionalProperties',
  'allOf',
  'anyOf',
  'const',
  'contains',
  'contentMediaType',
  'default',
  'dependentRequired',
  'dependentSchemas',
  'description',
  'else',
  'enum',
  'exclusiveMaximum',
  'exclusiveMinimum',
  'format',
  'if',
  'items',
  'maxContains',
  'maximum',
  'maxItems',
  'maxLength',
  'maxProperties',
  'maxSizeBytes',
  'minContains',
  'minimum',
  'minItems',
  'minLength',
  'minProperties',
  'multipleOf',
  'not',
  'oneOf',
  'pattern',
  'prefixItems',
  'properties',
  'required',
  'then',
  'title',
  'type',
  'uniqueItems',
]);
function createAjv() {
  return new Ajv2020({
    allErrors: true,
    formats: { 'asset-reference': true },
    strict: false,
    validateSchema: true,
  });
}

const ajv = createAjv();

function isSafePattern(value: string): boolean {
  if (value.length > 128 || /\\[1-9]|\\k</u.test(value)) return false;
  let escaped = false;
  let inClass = false;
  let variableRepetitions = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '[') {
      inClass = true;
      continue;
    }
    if (character === ']' && inClass) {
      inClass = false;
      continue;
    }
    if (inClass) continue;
    if (character === '*' || character === '+' || character === '?') return false;
    if (character === '{') {
      const bounded = /^\{(\d+)(?:,(\d+))?\}/u.exec(value.slice(index));
      const previous = value[index - 1];
      if (!bounded || previous === ')') return false;
      const minimum = Number(bounded[1]);
      const maximum = Number(bounded[2] ?? bounded[1]);
      if (
        !Number.isSafeInteger(minimum) ||
        !Number.isSafeInteger(maximum) ||
        minimum > maximum ||
        maximum > 64
      )
        return false;
      if (minimum !== maximum && ++variableRepetitions > 1) return false;
      index += bounded[0].length - 1;
    }
  }
  if (escaped || inClass) return false;
  try {
    new RegExp(value, 'u');
    return true;
  } catch {
    return false;
  }
}

function validateSchemaPolicy(schema: Readonly<Record<string, JsonValue>>): readonly string[] {
  const errors: string[] = [];
  let nodes = 0;
  const visit = (value: JsonValue, label: string, depth = 0): void => {
    nodes += 1;
    if (nodes > 2_048 || depth > 12) {
      errors.push('JSON Schema 复杂度超过安全限制');
      return;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const node = value as Readonly<Record<string, JsonValue>>;
    for (const [key, nested] of Object.entries(node)) {
      if (!SCHEMA_KEYWORDS.has(key)) {
        errors.push(`JSON Schema 关键字 ${key} 不受支持`);
        continue;
      }
      if (key === '$ref' && (typeof nested !== 'string' || !nested.startsWith('#/')))
        errors.push(`字段 ${label} 只能使用本地 $ref`);
      if (key === 'pattern') {
        if (typeof nested !== 'string' || !isSafePattern(nested)) {
          if (typeof nested === 'string') {
            try {
              new RegExp(nested, 'u');
              errors.push(`字段 ${label} pattern 不安全`);
            } catch {
              errors.push('JSON Schema 无法安全编译');
            }
          } else {
            errors.push(`字段 ${label} pattern 不安全`);
          }
        } else if (
          typeof node.maxLength !== 'number' ||
          !Number.isSafeInteger(node.maxLength) ||
          node.maxLength > 4_096
        ) {
          errors.push(`字段 ${label} pattern 必须设置不超过 4096 的 maxLength`);
        }
      }
      if (
        key === 'maxLength' &&
        (typeof nested !== 'number' || !Number.isSafeInteger(nested) || nested > 4_096)
      )
        errors.push(`字段 ${label} maxLength 不得超过 4096`);
      if (key === 'default' && typeof nested === 'string' && nested.length > 4_096)
        errors.push(`字段 ${label} 默认字符串不得超过 4096`);
    }
    const maps = ['$defs', 'dependentSchemas', 'properties'] as const;
    for (const keyword of maps) {
      const children = node[keyword];
      if (children && typeof children === 'object' && !Array.isArray(children)) {
        const entries = Object.entries(children);
        if (entries.length > 256) errors.push('JSON Schema 复杂度超过安全限制');
        else for (const [name, child] of entries) visit(child, name, depth + 1);
      }
    }
    const single = ['additionalProperties', 'contains', 'else', 'if', 'items', 'not', 'then'];
    for (const keyword of single) {
      const child = node[keyword];
      if (child && typeof child === 'object' && !Array.isArray(child))
        visit(child, label, depth + 1);
    }
    const arrays = ['allOf', 'anyOf', 'oneOf', 'prefixItems'];
    for (const keyword of arrays) {
      const children = node[keyword];
      if (Array.isArray(children)) {
        if (children.length > 32) errors.push('JSON Schema 复杂度超过安全限制');
        else for (const child of children as readonly JsonValue[]) visit(child, label, depth + 1);
      }
    }
  };
  visit(schema, '根');
  return Object.freeze([...new Set(errors)]);
}

function safeJsonClone(value: unknown, depth = 0, budget = { nodes: 0 }): JsonValue | undefined {
  if (depth > 20 || budget.nodes++ > 10_000) return undefined;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  try {
    if (!value || typeof value !== 'object') return undefined;
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 1_000)
        return undefined;
      const keys = Reflect.ownKeys(value);
      if (keys.some((key) => typeof key === 'symbol' || (key !== 'length' && !/^\d+$/u.test(key))))
        return undefined;
      const result: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return undefined;
        const item = safeJsonClone(descriptor.value, depth + 1, budget);
        if (item === undefined) return undefined;
        result.push(item);
      }
      return Object.freeze(result);
    }
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.length > 1_000 || keys.some((key) => typeof key !== 'string')) return undefined;
    const result: Record<string, JsonValue> = {};
    for (const key of keys as string[]) {
      if (
        !key ||
        key.length > 128 ||
        key === '__proto__' ||
        key === 'prototype' ||
        key === 'constructor'
      )
        return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return undefined;
      const item = safeJsonClone(descriptor.value, depth + 1, budget);
      if (item === undefined) return undefined;
      result[key] = item;
    }
    return Object.freeze(result);
  } catch {
    return undefined;
  }
}

function record(
  value: JsonValue | undefined,
  exactKeys?: readonly string[],
): Readonly<Record<string, JsonValue>> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (exactKeys) {
    const keys = Object.keys(value);
    if (keys.length !== exactKeys.length || exactKeys.some((key) => !keys.includes(key)))
      return null;
  }
  return value as Readonly<Record<string, JsonValue>>;
}

function text(value: JsonValue | undefined, maximum = 256): string | null {
  return typeof value === 'string' && value.length <= maximum && SAFE_TEXT.test(value)
    ? value
    : null;
}

function integer(value: JsonValue | undefined, minimum = 0): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
    ? value
    : null;
}

function jsonArray(value: JsonValue | undefined): readonly JsonValue[] | null {
  return Array.isArray(value) ? (value as unknown as readonly JsonValue[]) : null;
}

function stringList(value: JsonValue | undefined, maximum = 256): readonly string[] | null {
  const source = jsonArray(value);
  if (
    !source ||
    source.length > maximum ||
    !source.every((item) => typeof item === 'string' && FIELD_NAME.test(item))
  )
    return null;
  const items = source.filter((item): item is string => typeof item === 'string');
  return new Set(items).size === items.length ? Object.freeze(items) : null;
}

export function parseCapabilityDefinition(value: unknown): CapabilityDefinition {
  const cloned = safeJsonClone(value);
  const root = record(cloned, ['costDimensions', 'providerMapping', 'schema', 'uiSchema']);
  const schema = record(root?.schema);
  const uiSchema = record(root?.uiSchema, ['fields']);
  const mapping = record(root?.providerMapping);
  const dimensions = stringList(root?.costDimensions);
  const uiFieldsSource = jsonArray(uiSchema?.fields);
  if (
    !root ||
    !schema ||
    !uiSchema ||
    !mapping ||
    !dimensions ||
    !uiFieldsSource ||
    uiFieldsSource.length > 256
  )
    throw new Error('能力定义响应无效');
  const providerMapping: Record<string, string> = {};
  for (const [key, target] of Object.entries(mapping)) {
    if (!FIELD_NAME.test(key) || typeof target !== 'string' || !FIELD_NAME.test(target))
      throw new Error('能力定义响应无效');
    providerMapping[key] = target;
  }
  const fields: CapabilityUiField[] = [];
  for (const rawField of uiFieldsSource) {
    const field = record(rawField);
    if (
      !field ||
      Object.keys(field).some(
        (key) =>
          ![
            'condition',
            'group',
            'help',
            'label',
            'mutuallyExclusiveWith',
            'name',
            'order',
            'unit',
          ].includes(key),
      )
    )
      throw new Error('能力定义响应无效');
    const name = text(field.name, 64);
    const label = text(field.label, 120);
    const order = integer(field.order);
    const group = field.group === undefined ? undefined : text(field.group, 120);
    const help = field.help === undefined ? undefined : text(field.help, 256);
    const unit = field.unit === undefined ? undefined : text(field.unit, 32);
    const mutuallyExclusiveWith =
      field.mutuallyExclusiveWith === undefined
        ? undefined
        : stringList(field.mutuallyExclusiveWith, 32);
    let condition: CapabilityUiField['condition'];
    if (field.condition !== undefined) {
      const conditionRecord = record(field.condition, ['equals', 'field']);
      const conditionField = text(conditionRecord?.field, 64);
      if (!conditionRecord || !conditionField || !FIELD_NAME.test(conditionField))
        throw new Error('能力定义响应无效');
      if (conditionRecord.equals === undefined) throw new Error('能力定义响应无效');
      condition = Object.freeze({ equals: conditionRecord.equals, field: conditionField });
    }
    if (
      !name ||
      !FIELD_NAME.test(name) ||
      !label ||
      order === null ||
      group === null ||
      help === null ||
      unit === null ||
      mutuallyExclusiveWith === null
    )
      throw new Error('能力定义响应无效');
    fields.push(
      Object.freeze({
        ...(condition ? { condition } : {}),
        ...(group ? { group } : {}),
        ...(help ? { help } : {}),
        label,
        ...(mutuallyExclusiveWith ? { mutuallyExclusiveWith } : {}),
        name,
        order,
        ...(unit ? { unit } : {}),
      }),
    );
  }
  if (new Set(fields.map((field) => field.name)).size !== fields.length)
    throw new Error('能力定义响应无效');
  return Object.freeze({
    costDimensions: dimensions,
    providerMapping: Object.freeze(providerMapping),
    schema,
    uiSchema: Object.freeze({ fields: Object.freeze(fields) }),
  });
}

function schemaProperties(definition: CapabilityDefinition): Readonly<Record<string, JsonValue>> {
  const properties = definition.schema.properties;
  return properties && typeof properties === 'object' && !Array.isArray(properties)
    ? (properties as Readonly<Record<string, JsonValue>>)
    : {};
}

function valueMatchesProperty(
  value: JsonValue,
  property: Readonly<Record<string, JsonValue>>,
): boolean {
  const type = property.type;
  if (type === 'integer' && (!Number.isInteger(value) || typeof value !== 'number')) return false;
  if (type === 'number' && typeof value !== 'number') return false;
  if (type === 'string' && typeof value !== 'string') return false;
  if (type === 'boolean' && typeof value !== 'boolean') return false;
  const values = property.enum;
  if (
    Array.isArray(values) &&
    !values.some((item) => JSON.stringify(item) === JSON.stringify(value))
  )
    return false;
  if (typeof value === 'number' && typeof property.minimum === 'number' && value < property.minimum)
    return false;
  if (typeof value === 'number' && typeof property.maximum === 'number' && value > property.maximum)
    return false;
  return true;
}

function fullyMatchesProperty(
  definition: CapabilityDefinition,
  name: string,
  value: JsonValue,
): boolean {
  try {
    const scopedAjv = createAjv();
    const rootKey = 'urn:admin-web:capability-root';
    scopedAjv.addSchema(definition.schema, rootKey);
    const pointer = name.replaceAll('~', '~0').replaceAll('/', '~1');
    return scopedAjv.compile({ $ref: `${rootKey}#/properties/${pointer}` })(value);
  } catch {
    return false;
  }
}

export function validateCapabilityDefinition(value: unknown): readonly string[] {
  let definition: CapabilityDefinition;
  try {
    definition = parseCapabilityDefinition(value);
  } catch {
    return Object.freeze(['能力定义格式无效']);
  }
  const errors: string[] = [];
  const policyErrors = validateSchemaPolicy(definition.schema);
  errors.push(...policyErrors);
  if (definition.schema.$schema !== DRAFT_SCHEMA_URI)
    errors.push('必须使用 JSON Schema Draft 2020-12');
  if (policyErrors.length === 0) {
    try {
      if (!ajv.validateSchema(definition.schema)) errors.push('JSON Schema 元模式校验失败');
      else ajv.compile(definition.schema);
    } catch {
      errors.push('JSON Schema 无法安全编译');
    }
  }
  if (definition.schema.type !== 'object') errors.push('JSON Schema 根类型必须为 object');
  if (definition.schema.additionalProperties !== false)
    errors.push('JSON Schema 必须禁止未声明字段');
  const properties = schemaProperties(definition);
  const propertyNames = Object.keys(properties);
  const required = definition.schema.required;
  if (
    !Array.isArray(required) ||
    !required.every((item) => typeof item === 'string' && propertyNames.includes(item))
  )
    errors.push('required 必须只引用已声明字段');
  for (const field of definition.uiSchema.fields) {
    if (!propertyNames.includes(field.name)) errors.push(`UI 字段 ${field.name} 不存在`);
    if (field.condition && !propertyNames.includes(field.condition.field))
      errors.push(`条件字段 ${field.condition.field} 不存在`);
    for (const other of field.mutuallyExclusiveWith ?? [])
      if (!propertyNames.includes(other)) errors.push(`互斥字段 ${other} 不存在`);
      else if (other === field.name) errors.push(`字段 ${field.name} 不能与自身互斥`);
    if (field.condition) {
      const conditionProperty = properties[field.condition.field];
      if (
        conditionProperty &&
        typeof conditionProperty === 'object' &&
        !Array.isArray(conditionProperty) &&
        policyErrors.length === 0 &&
        !fullyMatchesProperty(definition, field.condition.field, field.condition.equals)
      )
        errors.push(`条件字段 ${field.condition.field} 的比较值无效`);
    }
  }
  const orders = definition.uiSchema.fields.map((field) => field.order);
  if (new Set(orders).size !== orders.length || orders.some((order) => order > 10_000))
    errors.push('UI 字段顺序必须唯一且不超过 10000');
  for (const name of definition.costDimensions) {
    if (!propertyNames.includes(name)) {
      errors.push(`成本维度 ${name} 不存在`);
      continue;
    }
    const property = properties[name];
    const uiField = definition.uiSchema.fields.find((field) => field.name === name);
    const propertyRecord =
      property && typeof property === 'object' && !Array.isArray(property)
        ? (property as Readonly<Record<string, JsonValue>>)
        : null;
    const finiteEnum =
      propertyRecord &&
      Array.isArray(propertyRecord.enum) &&
      propertyRecord.enum.length > 0 &&
      propertyRecord.enum.length <= 64;
    const numeric =
      propertyRecord && (propertyRecord.type === 'number' || propertyRecord.type === 'integer');
    if (!finiteEnum && !numeric) errors.push(`成本维度 ${name} 缺少可计价语义`);
    if (!uiField?.unit) errors.push(`成本维度 ${name} 缺少单位`);
  }
  for (const name of propertyNames) {
    if (!definition.providerMapping[name]) errors.push(`字段 ${name} 缺少供应商映射`);
    const property = properties[name];
    if (!property || typeof property !== 'object' || Array.isArray(property)) {
      errors.push(`字段 ${name} Schema 无效`);
      continue;
    }
    const propertyRecord = property as Readonly<Record<string, JsonValue>>;
    if (
      'default' in propertyRecord &&
      !valueMatchesProperty(propertyRecord.default, propertyRecord)
    )
      errors.push(`字段 ${name} 默认值不符合枚举或范围`);
    if (
      'default' in propertyRecord &&
      policyErrors.length === 0 &&
      !fullyMatchesProperty(definition, name, propertyRecord.default)
    )
      errors.push(`字段 ${name} 默认值不符合完整 Schema`);
    if (
      typeof propertyRecord.minimum === 'number' &&
      typeof propertyRecord.maximum === 'number' &&
      propertyRecord.minimum > propertyRecord.maximum
    )
      errors.push(`字段 ${name} 范围无效`);
  }
  for (const name of Object.keys(definition.providerMapping))
    if (!propertyNames.includes(name)) errors.push(`供应商映射字段 ${name} 不存在`);
  return Object.freeze([...new Set(errors)]);
}

export function diffCapabilityFields(
  previous: CapabilityDefinition | null,
  next: CapabilityDefinition,
): CapabilityDiff {
  const previousProperties = previous ? schemaProperties(previous) : {};
  const nextProperties = schemaProperties(next);
  const previousFields = new Set(Object.keys(previousProperties));
  const nextFields = new Set(Object.keys(nextProperties));
  const canonical = (value: unknown): string => {
    const normalize = (item: unknown): unknown => {
      if (Array.isArray(item)) return item.map(normalize);
      if (item && typeof item === 'object')
        return Object.fromEntries(
          Object.entries(item)
            .filter(([, nested]) => nested !== undefined)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, nested]) => [key, normalize(nested)]),
        );
      return item;
    };
    return JSON.stringify(normalize(value));
  };
  const descriptor = (
    definition: CapabilityDefinition,
    name: string,
    property: JsonValue | undefined,
  ) => ({
    costDimension: definition.costDimensions.includes(name),
    property,
    providerMapping: definition.providerMapping[name] ?? null,
    required: Array.isArray(definition.schema.required)
      ? definition.schema.required.includes(name)
      : false,
    uiField: definition.uiSchema.fields.find((field) => field.name === name) ?? null,
  });
  const rootSemantics = (definition: CapabilityDefinition) =>
    Object.fromEntries(
      Object.entries(definition.schema).filter(
        ([key]) => key !== 'properties' && key !== 'required',
      ),
    );
  const globalSchemaChanged =
    previous !== null && canonical(rootSemantics(previous)) !== canonical(rootSemantics(next));
  return Object.freeze({
    added: Object.freeze([...nextFields].filter((field) => !previousFields.has(field)).sort()),
    changed: Object.freeze(
      previous
        ? [...nextFields]
            .filter(
              (field) =>
                previousFields.has(field) &&
                (globalSchemaChanged ||
                  canonical(descriptor(previous, field, previousProperties[field])) !==
                    canonical(descriptor(next, field, nextProperties[field]))),
            )
            .sort()
        : [],
    ),
    removed: Object.freeze([...previousFields].filter((field) => !nextFields.has(field)).sort()),
  });
}

function utc(value: JsonValue | undefined): string | null {
  return typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    !Number.isNaN(Date.parse(value))
    ? value
    : null;
}

export function parseCapabilityViewPayload(value: unknown): CapabilityView {
  const root = record(safeJsonClone(value), [
    'assignedAdminIds',
    'definition',
    'history',
    'model',
    'ownerAdminId',
    'publishedDefinition',
    'sourceUpdatedAt',
    'status',
    'version',
    'versionId',
  ]);
  const model = record(root?.model, ['code', 'displayName', 'id', 'providerId']);
  const sourceUpdatedAt = utc(root?.sourceUpdatedAt);
  const version = integer(root?.version, 1);
  const historySource = jsonArray(root?.history);
  const code = text(model?.code, 64);
  const displayName = text(model?.displayName, 120);
  const assignedAdminIds = uuidList(root?.assignedAdminIds);
  const ownerAdminId = root?.ownerAdminId;
  if (
    !root ||
    !model ||
    !code ||
    !FIELD_NAME.test(code) ||
    !displayName ||
    !isUuidV7(model.id) ||
    !isUuidV7(model.providerId) ||
    !assignedAdminIds ||
    (ownerAdminId !== null && !isUuidV7(ownerAdminId)) ||
    !sourceUpdatedAt ||
    (root.status !== 'DRAFT' && root.status !== 'PUBLISHED') ||
    version === null ||
    !isUuidV7(root.versionId) ||
    !historySource ||
    historySource.length > 100
  )
    throw new Error('模型能力响应无效');
  const history = historySource.map((item) => {
    const entry = record(item, ['createdAt', 'id', 'status', 'version']);
    const createdAt = utc(entry?.createdAt);
    const entryVersion = integer(entry?.version, 1);
    if (
      !entry ||
      !createdAt ||
      !isUuidV7(entry.id) ||
      !['DRAFT', 'PUBLISHED', 'ROLLED_BACK'].includes(entry.status as string) ||
      entryVersion === null
    )
      throw new Error('模型能力响应无效');
    return Object.freeze({
      createdAt,
      id: entry.id,
      status: entry.status as CapabilityVersionSummary['status'],
      version: entryVersion,
    });
  });
  if (
    new Set(history.map((entry) => entry.id.toLowerCase())).size !== history.length ||
    new Set(history.map((entry) => entry.version)).size !== history.length
  )
    throw new Error('模型能力响应无效');
  const definition = parseCapabilityDefinition(root.definition);
  const publishedDefinition =
    root.publishedDefinition === null ? null : parseCapabilityDefinition(root.publishedDefinition);
  if (
    validateCapabilityDefinition(definition).length > 0 ||
    (publishedDefinition && validateCapabilityDefinition(publishedDefinition).length > 0)
  )
    throw new Error('模型能力响应无效');
  return Object.freeze({
    assignedAdminIds,
    definition,
    history: Object.freeze(history),
    model: Object.freeze({
      code,
      displayName,
      id: model.id,
      providerId: model.providerId,
    }),
    ownerAdminId: ownerAdminId,
    publishedDefinition,
    sourceUpdatedAt,
    status: root.status,
    version,
    versionId: root.versionId,
  });
}

function uuidList(value: JsonValue | undefined): readonly string[] | null {
  const source = jsonArray(value);
  if (!source || source.length > 100 || !source.every(isUuidV7)) return null;
  const items = source.filter((item): item is string => typeof item === 'string');
  return new Set(items.map((item) => item.toLowerCase())).size === items.length
    ? Object.freeze(items)
    : null;
}

export function parseModelDirectoryPayload(value: unknown): ModelDirectoryPayload {
  const root = record(safeJsonClone(value), ['items', 'partialFields', 'sourceUpdatedAt']);
  const sourceUpdatedAt = utc(root?.sourceUpdatedAt);
  const allowedPartial = new Set(['providerName', 'publishedVersion']);
  const itemsSource = jsonArray(root?.items);
  const partialSource = jsonArray(root?.partialFields);
  if (
    !root ||
    !sourceUpdatedAt ||
    !itemsSource ||
    itemsSource.length > 200 ||
    !partialSource ||
    partialSource.length > 2 ||
    !partialSource.every((item) => typeof item === 'string' && allowedPartial.has(item)) ||
    new Set(partialSource).size !== partialSource.length
  )
    throw new Error('模型目录响应无效');
  const items = itemsSource.map((raw) => {
    const row = record(raw, [
      'assignedAdminIds',
      'code',
      'displayName',
      'draftVersion',
      'id',
      'ownerAdminId',
      'providerId',
      'providerName',
      'publishedVersion',
      'sourceUpdatedAt',
      'status',
    ]);
    const assignedAdminIds = uuidList(row?.assignedAdminIds);
    const code = text(row?.code, 64);
    const displayName = text(row?.displayName, 120);
    const providerName = text(row?.providerName, 120);
    const rowUpdatedAt = utc(row?.sourceUpdatedAt);
    const draftVersion = row?.draftVersion === null ? null : integer(row?.draftVersion, 1);
    const publishedVersion =
      row?.publishedVersion === null ? null : integer(row?.publishedVersion, 1);
    if (
      !row ||
      !assignedAdminIds ||
      !code ||
      !FIELD_NAME.test(code) ||
      !displayName ||
      !providerName ||
      !isUuidV7(row.id) ||
      !isUuidV7(row.providerId) ||
      (row.ownerAdminId !== null && !isUuidV7(row.ownerAdminId)) ||
      !rowUpdatedAt ||
      !['DRAFT', 'PUBLISHED', 'DISABLED'].includes(row.status as string) ||
      (draftVersion === null && row.draftVersion !== null) ||
      (publishedVersion === null && row.publishedVersion !== null)
    )
      throw new Error('模型目录响应无效');
    return Object.freeze({
      assignedAdminIds,
      code,
      displayName,
      draftVersion,
      id: row.id,
      ownerAdminId: row.ownerAdminId,
      providerId: row.providerId,
      providerName,
      publishedVersion,
      sourceUpdatedAt: rowUpdatedAt,
      status: row.status as ModelDirectoryRow['status'],
    });
  });
  return Object.freeze({
    items: Object.freeze(items),
    partialFields: Object.freeze(
      partialSource.filter(
        (item): item is 'providerName' | 'publishedVersion' =>
          item === 'providerName' || item === 'publishedVersion',
      ),
    ),
    sourceUpdatedAt,
  });
}
