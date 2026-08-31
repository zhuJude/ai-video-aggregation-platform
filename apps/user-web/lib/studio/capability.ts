import Ajv2020, { type ErrorObject } from 'ajv/dist/2020';

import type { JsonSchemaValue, StudioCapabilityDocument, StudioJsonSchema } from './types';

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
const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: true });
ajv.addFormat('asset-id', /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/);

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

export function auditCapabilityDocument(document: StudioCapabilityDocument): readonly string[] {
  const unsupported = new Set<string>();
  auditNode(document.jsonSchema, '', unsupported);

  if (document.jsonSchema.type !== 'object') unsupported.add('$.type:root-must-be-object');
  const properties = document.jsonSchema.properties ?? {};
  for (const field of document.uiSchema.order) {
    if (!(field in properties)) unsupported.add(`uiSchema.order.${field}:unknown-field`);
  }
  for (const condition of document.uiSchema.conditions ?? []) {
    if (!(condition.field in properties)) {
      unsupported.add(`uiSchema.conditions.${condition.field}:unknown-field`);
    }
    if (!(condition.when.field in properties)) {
      unsupported.add(`uiSchema.conditions.${condition.when.field}:unknown-dependency`);
    }
  }

  return [...unsupported];
}

function normalizeSchema(schema: StudioJsonSchema): StudioJsonSchema {
  if (schema.type !== 'object') return schema;
  return { ...schema, additionalProperties: false };
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
    const validate = ajv.compile(normalizeSchema(schema));
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
  for (const [field, schema] of Object.entries(document.jsonSchema.properties ?? {})) {
    if (schema.default !== undefined) defaults[field] = schema.default;
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
  const parameters = Object.fromEntries(
    Object.entries(values).filter(([field]) => !hiddenOptional.has(field)),
  );

  const validation = validateForm(document.jsonSchema, parameters);
  return { ...validation, parameters };
}

export function errorsForField(
  errors: readonly CapabilityValidationError[],
  field: string,
): readonly CapabilityValidationError[] {
  return errors.filter((error) => error.field === field);
}
