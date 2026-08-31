import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020';

import type {
  JsonSchemaValue,
  StudioCapabilityDocument,
  StudioJsonSchema,
  StudioVisibilityCondition,
} from './types';

const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  '$schema',
  '$id',
  'type',
  'title',
  'description',
  'default',
  'properties',
  'required',
  'additionalProperties',
  'enum',
  'const',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'allOf',
  'anyOf',
  'oneOf',
  'not',
  'if',
  'then',
  'else',
  'dependentRequired',
  'minItems',
  'maxItems',
  'uniqueItems',
  'items',
]);

const SUPPORTED_FIELD_TYPES = new Set(['string', 'integer', 'boolean']);
const SUPPORTED_WIDGETS = new Set(['string', 'textarea', 'integer', 'boolean', 'enum', 'asset-id']);
const ajv = new Ajv2020({
  addUsedSchema: false,
  allErrors: true,
  strict: false,
  validateFormats: true,
});
ajv.addFormat('asset-id', /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/);
const validatorCache = new WeakMap<StudioJsonSchema, ValidateFunction>();

export interface CapabilityValidationError {
  readonly field?: string;
  readonly message: string;
  readonly keyword: string;
}

export interface CapabilityValidationResult {
  readonly valid: boolean;
  readonly errors: readonly CapabilityValidationError[];
}

export interface PreparedCapabilityParameters extends CapabilityValidationResult {
  readonly parameters: Readonly<Record<string, unknown>>;
}

function joinPath(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

function isSchemaArray(
  value: StudioJsonSchema | readonly StudioJsonSchema[],
): value is readonly StudioJsonSchema[] {
  return Array.isArray(value);
}

function auditNode(schema: StudioJsonSchema, path: string, unsupported: Set<string>): void {
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_SCHEMA_KEYWORDS.has(key)) unsupported.add(joinPath(path, key));
  }

  if (path.startsWith('properties.') && schema.type && !SUPPORTED_FIELD_TYPES.has(schema.type)) {
    unsupported.add(`${path}.type:${schema.type}`);
  }

  if (schema.format && schema.format !== 'asset-id') {
    unsupported.add(`${path || '$'}.format:${schema.format}`);
  }
  if (schema.format === 'asset-id' && schema.type !== 'string') {
    unsupported.add(`${path || '$'}.format:asset-id-requires-string`);
  }
  if (schema.enum && schema.type) {
    for (const value of schema.enum) {
      const matchesType =
        (schema.type === 'string' && typeof value === 'string') ||
        (schema.type === 'integer' && typeof value === 'number' && Number.isInteger(value)) ||
        (schema.type === 'boolean' && typeof value === 'boolean');
      if (!matchesType) unsupported.add(`${path || '$'}.enum:type-mismatch`);
    }
  }

  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    auditNode(child, joinPath('properties', key), unsupported);
  }
  for (const [key, child] of Object.entries(schema.$defs ?? {})) {
    auditNode(child, joinPath('$defs', key), unsupported);
  }
  for (const keyword of ['allOf', 'anyOf', 'oneOf'] as const) {
    schema[keyword]?.forEach((child, index) => {
      auditNode(child, `${path || '$'}.${keyword}[${String(index)}]`, unsupported);
    });
  }
  for (const keyword of ['not', 'if', 'then', 'else'] as const) {
    const child = schema[keyword];
    if (child) auditNode(child, `${path || '$'}.${keyword}`, unsupported);
  }
  if (schema.items && !isSchemaArray(schema.items)) {
    auditNode(schema.items, `${path || '$'}.items`, unsupported);
  }
}

function valueKey(value: JsonSchemaValue): string {
  return `${typeof value}:${String(value)}`;
}

function valueMatchesField(schema: StudioJsonSchema, value: JsonSchemaValue): boolean {
  if (schema.enum && !schema.enum.some((candidate) => valueKey(candidate) === valueKey(value))) {
    return false;
  }
  if (schema.type === 'string') return typeof value === 'string';
  if (schema.type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (schema.type === 'boolean') return typeof value === 'boolean';
  return false;
}

function auditRequiredReferences(
  schema: StudioJsonSchema,
  properties: Readonly<Record<string, StudioJsonSchema>>,
  path: string,
  unsupported: Set<string>,
): void {
  for (const field of schema.required ?? []) {
    if (!(field in properties)) unsupported.add(`${path || '$'}.required.${field}:unknown-field`);
  }
  if (schema.dependentRequired) {
    unsupported.add(`${path || '$'}.dependentRequired:unsupported-rendering`);
  }
  for (const keyword of ['allOf', 'anyOf', 'oneOf'] as const) {
    schema[keyword]?.forEach((child, index) => {
      auditRequiredReferences(
        child,
        properties,
        `${path || '$'}.${keyword}[${String(index)}]`,
        unsupported,
      );
    });
  }
  for (const keyword of ['not', 'if', 'then', 'else'] as const) {
    const child = schema[keyword];
    if (child) auditRequiredReferences(child, properties, `${path || '$'}.${keyword}`, unsupported);
  }
}

function widgetMatches(schema: StudioJsonSchema, widget: string): boolean {
  if (widget === 'enum') return Boolean(schema.enum);
  if (widget === 'integer') return schema.type === 'integer' && !schema.enum;
  if (widget === 'boolean') return schema.type === 'boolean' && !schema.enum;
  if (widget === 'asset-id') return schema.type === 'string' && !schema.enum;
  if (widget === 'string' || widget === 'textarea') {
    return schema.type === 'string' && !schema.enum;
  }
  return false;
}

interface RequirementPredicate {
  readonly field: string;
  readonly values: readonly JsonSchemaValue[];
}

function predicateFromIf(schema: StudioJsonSchema): RequirementPredicate | undefined {
  const entries = Object.entries(schema.properties ?? {});
  if (entries.length !== 1) return undefined;
  const [field, fieldSchema] = entries[0] ?? [];
  if (!field || !fieldSchema) return undefined;
  if (fieldSchema.const !== undefined) return { field, values: [fieldSchema.const] };
  if (fieldSchema.enum?.length) return { field, values: fieldSchema.enum };
  return undefined;
}

function requirementPredicates(
  schema: StudioJsonSchema,
  target: string,
  activePredicate?: RequirementPredicate,
): readonly (RequirementPredicate | undefined)[] {
  const predicates: (RequirementPredicate | undefined)[] = [];
  if (schema.required?.includes(target)) predicates.push(activePredicate);
  for (const keyword of ['allOf', 'anyOf', 'oneOf'] as const) {
    for (const child of schema[keyword] ?? []) {
      predicates.push(...requirementPredicates(child, target, activePredicate));
    }
  }
  if (schema.if) {
    if (schema.then) {
      predicates.push(...requirementPredicates(schema.then, target, predicateFromIf(schema.if)));
    }
    if (schema.else) predicates.push(...requirementPredicates(schema.else, target));
  }
  return predicates;
}

function visibilityCoversPredicate(
  condition: StudioVisibilityCondition,
  predicate: RequirementPredicate,
): boolean {
  if (condition.when.field !== predicate.field) return false;
  if ('equals' in condition.when) {
    return (
      predicate.values.length === 1 &&
      valueKey(predicate.values[0] ?? null) === valueKey(condition.when.equals)
    );
  }
  if ('notEquals' in condition.when) {
    const excludedKey = valueKey(condition.when.notEquals);
    return predicate.values.every((value) => valueKey(value) !== excludedKey);
  }
  if ('in' in condition.when) {
    const visibleValues = new Set(condition.when.in.map(valueKey));
    return predicate.values.every((value) => visibleValues.has(valueKey(value)));
  }
  return false;
}

export function auditCapabilityDocument(document: StudioCapabilityDocument): readonly string[] {
  const unsupported = new Set<string>();
  auditNode(document.jsonSchema, '', unsupported);

  if (document.jsonSchema.type !== 'object') unsupported.add('$.type:root-must-be-object');
  const properties = document.jsonSchema.properties ?? {};
  const propertyNames = Object.keys(properties);
  const orderCounts = new Map<string, number>();
  for (const field of document.uiSchema.order) {
    orderCounts.set(field, (orderCounts.get(field) ?? 0) + 1);
    if (!(field in properties)) unsupported.add(`uiSchema.order.${field}:unknown-field`);
  }
  for (const field of propertyNames) {
    if ((orderCounts.get(field) ?? 0) !== 1) {
      unsupported.add(`uiSchema.order.${field}:must-appear-once`);
    }
  }
  for (const [field, count] of orderCounts) {
    if (count !== 1) unsupported.add(`uiSchema.order.${field}:duplicate`);
  }

  const groupCounts = new Map<string, number>();
  const groupKeys = new Set<string>();
  for (const group of document.uiSchema.groups) {
    if (groupKeys.has(group.key)) unsupported.add(`uiSchema.groups.${group.key}:duplicate-key`);
    groupKeys.add(group.key);
    for (const field of group.fields) {
      groupCounts.set(field, (groupCounts.get(field) ?? 0) + 1);
      if (!(field in properties)) unsupported.add(`uiSchema.groups.${field}:unknown-field`);
      if (!orderCounts.has(field)) unsupported.add(`uiSchema.groups.${field}:not-in-order`);
    }
  }
  for (const field of document.uiSchema.order) {
    if ((groupCounts.get(field) ?? 0) !== 1) {
      unsupported.add(`uiSchema.groups.${field}:must-appear-once`);
    }
  }

  for (const field of Object.keys(document.uiSchema.fields ?? {})) {
    if (!(field in properties)) unsupported.add(`uiSchema.fields.${field}:unknown-field`);
  }

  auditRequiredReferences(document.jsonSchema, properties, '', unsupported);
  const rootRequired = new Set(document.jsonSchema.required ?? []);
  const conditionTargets = new Set<string>();
  for (const condition of document.uiSchema.conditions ?? []) {
    if (conditionTargets.has(condition.field)) {
      unsupported.add(`uiSchema.conditions.${condition.field}:duplicate`);
    }
    conditionTargets.add(condition.field);
    if (!(condition.field in properties)) {
      unsupported.add(`uiSchema.conditions.${condition.field}:unknown-field`);
    }
    if (!(condition.when.field in properties)) {
      unsupported.add(`uiSchema.conditions.${condition.when.field}:unknown-dependency`);
    }
    const operators = [
      'equals' in condition.when,
      'notEquals' in condition.when,
      'in' in condition.when,
    ].filter(Boolean).length;
    const inValues: unknown = condition.when.in;
    if (
      operators !== 1 ||
      ('in' in condition.when && (!Array.isArray(inValues) || inValues.length === 0))
    ) {
      unsupported.add(`uiSchema.conditions.${condition.field}:invalid-predicate`);
    }
    if (rootRequired.has(condition.field)) {
      unsupported.add(`uiSchema.conditions.${condition.field}:required-field-can-be-hidden`);
    }
    const dependencySchema = properties[condition.when.field];
    const conditionValues =
      'equals' in condition.when
        ? [condition.when.equals]
        : 'notEquals' in condition.when
          ? [condition.when.notEquals]
          : condition.when.in;
    if (
      dependencySchema &&
      conditionValues?.some((value) => !valueMatchesField(dependencySchema, value))
    ) {
      unsupported.add(`uiSchema.conditions.${condition.field}:predicate-type-mismatch`);
    }
    const requiredPredicates = requirementPredicates(document.jsonSchema, condition.field);
    if (
      requiredPredicates.some(
        (predicate) => !predicate || !visibilityCoversPredicate(condition, predicate),
      )
    ) {
      unsupported.add(`uiSchema.conditions.${condition.field}:hidden-when-required`);
    }
  }

  for (const [field, schema] of Object.entries(properties)) {
    const metadata = document.uiSchema.fields?.[field];
    const widget = metadata?.widget;
    if (widget && !SUPPORTED_WIDGETS.has(widget)) {
      unsupported.add(`uiSchema.fields.${field}.widget:${widget}`);
    } else if (widget && !widgetMatches(schema, widget)) {
      unsupported.add(`uiSchema.fields.${field}.widget:type-mismatch`);
    }
    if (metadata?.options) {
      const enumKeys = new Set((schema.enum ?? []).map(valueKey));
      const optionKeys = metadata.options.map((option) => valueKey(option.value));
      if (
        !schema.enum ||
        new Set(optionKeys).size !== optionKeys.length ||
        optionKeys.length !== enumKeys.size ||
        optionKeys.some((key) => !enumKeys.has(key))
      ) {
        unsupported.add(`uiSchema.fields.${field}.options:enum-mismatch`);
      }
    }
  }

  return [...unsupported];
}

function normalizeSchema(schema: StudioJsonSchema): StudioJsonSchema {
  if (schema.type !== 'object') return schema;
  return { ...schema, additionalProperties: false };
}

function validatorFor(schema: StudioJsonSchema): ValidateFunction {
  const cached = validatorCache.get(schema);
  if (cached) return cached;
  const compiled = ajv.compile(normalizeSchema(schema));
  validatorCache.set(schema, compiled);
  return compiled;
}

function fieldFromError(error: ErrorObject): string | undefined {
  if (error.keyword === 'required' && 'missingProperty' in error.params) {
    return String(error.params.missingProperty);
  }
  if (error.keyword === 'additionalProperties' && 'additionalProperty' in error.params) {
    return String(error.params.additionalProperty);
  }
  const lastSegment = error.instancePath.split('/').filter(Boolean).at(-1);
  return lastSegment?.replaceAll('~1', '/').replaceAll('~0', '~');
}

function normalizeErrors(
  errors: readonly ErrorObject[] | null | undefined,
): CapabilityValidationError[] {
  return (errors ?? []).map((error) => {
    const field = fieldFromError(error);
    const normalized = {
      keyword: error.keyword,
      message: error.message ?? '参数不符合模型配置。',
    };
    return field ? { ...normalized, field } : normalized;
  });
}

export function validateForm(
  schema: StudioJsonSchema,
  values: Readonly<Record<string, unknown>>,
): CapabilityValidationResult {
  try {
    const validate = validatorFor(schema);
    const valid = validate(values);
    return { valid, errors: normalizeErrors(validate.errors) };
  } catch (error) {
    return {
      valid: false,
      errors: [
        {
          keyword: 'compile',
          message: error instanceof Error ? error.message : '模型配置无法校验。',
        },
      ],
    };
  }
}

export function isFieldVisible(
  document: StudioCapabilityDocument,
  field: string,
  values: Readonly<Record<string, unknown>>,
): boolean {
  const condition = document.uiSchema.conditions?.find((candidate) => candidate.field === field);
  if (!condition) return true;

  const dependencyValue = values[condition.when.field] as JsonSchemaValue | undefined;
  if ('equals' in condition.when) return dependencyValue === condition.when.equals;
  if ('notEquals' in condition.when) return dependencyValue !== condition.when.notEquals;
  if (condition.when.in) return condition.when.in.includes(dependencyValue ?? null);
  return true;
}

export function defaultCapabilityValues(
  document: StudioCapabilityDocument,
): Readonly<Record<string, unknown>> {
  const defaults: Record<string, unknown> = {};
  const properties = document.jsonSchema.properties ?? {};
  const required = new Set(document.jsonSchema.required ?? []);
  for (const field of document.uiSchema.order) {
    const schema = properties[field];
    if (!schema) continue;
    if (schema.default !== undefined) defaults[field] = schema.default;
    else if (schema.type === 'boolean' && required.has(field)) defaults[field] = false;
  }
  return defaults;
}

export function prepareCapabilityParameters(
  document: StudioCapabilityDocument,
  values: Readonly<Record<string, unknown>>,
): PreparedCapabilityParameters {
  const required = new Set(document.jsonSchema.required ?? []);
  const hiddenOptional = new Set<string>();
  for (const field of document.uiSchema.order) {
    if (!required.has(field) && !isFieldVisible(document, field, values)) {
      hiddenOptional.add(field);
    }
  }
  const order = new Set(document.uiSchema.order);
  const parameters = Object.fromEntries(
    Object.entries(values).filter(([field]) => order.has(field) && !hiddenOptional.has(field)),
  );
  const unknownValues = Object.fromEntries(
    Object.entries(values).filter(([field]) => !order.has(field)),
  );

  const validation = validateForm(document.jsonSchema, { ...parameters, ...unknownValues });
  return { ...validation, parameters };
}

export function errorsForField(
  errors: readonly CapabilityValidationError[],
  field: string,
): readonly CapabilityValidationError[] {
  return errors.filter((error) => error.field === field);
}
