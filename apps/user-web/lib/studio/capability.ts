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
  if (path && schema.dependentRequired) {
    unsupported.add(`${path}.dependentRequired:root-only`);
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
  const entries = Object.entries(schema.properties ?? {}).filter(
    ([, fieldSchema]) => fieldSchema.const !== undefined || fieldSchema.enum?.length,
  );
  if (entries.length !== 1) return undefined;
  const [field, fieldSchema] = entries[0] ?? [];
  if (!field || !fieldSchema) return undefined;
  if (fieldSchema.const !== undefined) return { field, values: [fieldSchema.const] };
  if (fieldSchema.enum?.length) return { field, values: fieldSchema.enum };
  return undefined;
}

function schemaHasRequiredFields(schema: StudioJsonSchema | undefined): boolean {
  if (!schema) return false;
  if (schema.required?.length) return true;
  for (const keyword of ['allOf', 'anyOf', 'oneOf'] as const) {
    if (schema[keyword]?.some(schemaHasRequiredFields)) return true;
  }
  return (
    schemaHasRequiredFields(schema.then) ||
    schemaHasRequiredFields(schema.else) ||
    schemaHasRequiredFields(schema.if)
  );
}

function rootGuaranteesField(
  root: StudioJsonSchema,
  branch: StudioJsonSchema,
  field: string,
): boolean {
  return (
    root.required?.includes(field) === true ||
    root.properties?.[field]?.default !== undefined ||
    branch.required?.includes(field) === true
  );
}

function predicateUsesFiniteRootEnum(
  predicate: RequirementPredicate,
  properties: Readonly<Record<string, StudioJsonSchema>>,
): boolean {
  const dependency = properties[predicate.field];
  return (
    Boolean(dependency?.enum?.length) &&
    predicate.values.length > 0 &&
    predicate.values.every((value) => (dependency ? valueMatchesField(dependency, value) : false))
  );
}

function predicatesOverlap(left: RequirementPredicate, right: RequirementPredicate): boolean {
  const rightValues = new Set(right.values.map(valueKey));
  return left.values.some((value) => rightValues.has(valueKey(value)));
}

function auditConditionalPredicates(
  schema: StudioJsonSchema,
  root: StudioJsonSchema,
  properties: Readonly<Record<string, StudioJsonSchema>>,
  path: string,
  unsupported: Set<string>,
): void {
  if (schema.if && (schemaHasRequiredFields(schema.then) || schemaHasRequiredFields(schema.else))) {
    const predicate = predicateFromIf(schema.if);
    if (!predicate || !predicateUsesFiniteRootEnum(predicate, properties)) {
      unsupported.add(`${path || '$'}.if:finite-enum-discriminator-required`);
    } else if (!rootGuaranteesField(root, schema.if, predicate.field)) {
      unsupported.add(`${path || '$'}.if.${predicate.field}:optional-discriminator`);
    }
  }

  for (const keyword of ['anyOf', 'oneOf'] as const) {
    const branches = schema[keyword] ?? [];
    if (branches.some(schemaHasRequiredFields)) {
      const predicates = branches.map(predicateFromIf);
      const discriminator = predicates[0]?.field;
      if (
        !discriminator ||
        predicates.some(
          (predicate) =>
            !predicate ||
            predicate.field !== discriminator ||
            !predicateUsesFiniteRootEnum(predicate, properties),
        )
      ) {
        unsupported.add(`${path || '$'}.${keyword}:finite-shared-discriminator-required`);
      } else {
        const finitePredicates = predicates.filter(
          (predicate): predicate is RequirementPredicate => predicate !== undefined,
        );
        if (branches.some((branch) => !rootGuaranteesField(root, branch, discriminator))) {
          unsupported.add(`${path || '$'}.${keyword}.${discriminator}:optional-discriminator`);
        }
        for (let left = 0; left < finitePredicates.length; left += 1) {
          for (let right = left + 1; right < finitePredicates.length; right += 1) {
            const leftPredicate = finitePredicates[left];
            const rightPredicate = finitePredicates[right];
            if (
              leftPredicate &&
              rightPredicate &&
              predicatesOverlap(leftPredicate, rightPredicate)
            ) {
              unsupported.add(`${path || '$'}.${keyword}.${discriminator}:overlapping-predicates`);
            }
          }
        }
      }
    }
    branches.forEach((branch, index) => {
      auditConditionalPredicates(
        branch,
        root,
        properties,
        `${path || '$'}.${keyword}[${String(index)}]`,
        unsupported,
      );
    });
  }
  schema.allOf?.forEach((branch, index) => {
    auditConditionalPredicates(
      branch,
      root,
      properties,
      `${path || '$'}.allOf[${String(index)}]`,
      unsupported,
    );
  });
  for (const keyword of ['then', 'else'] as const) {
    const branch = schema[keyword];
    if (branch) {
      auditConditionalPredicates(
        branch,
        root,
        properties,
        `${path || '$'}.${keyword}`,
        unsupported,
      );
    }
  }
}

function complementPredicate(
  predicate: RequirementPredicate | undefined,
  properties: Readonly<Record<string, StudioJsonSchema>>,
): RequirementPredicate | undefined {
  if (!predicate) return undefined;
  const domain = properties[predicate.field]?.enum;
  if (!domain) return undefined;
  const excluded = new Set(predicate.values.map(valueKey));
  return {
    field: predicate.field,
    values: domain.filter((value) => !excluded.has(valueKey(value))),
  };
}

function requirementPredicates(
  schema: StudioJsonSchema,
  target: string,
  properties: Readonly<Record<string, StudioJsonSchema>>,
  activePredicate?: RequirementPredicate,
): readonly (RequirementPredicate | undefined)[] {
  const predicates: (RequirementPredicate | undefined)[] = [];
  if (schema.required?.includes(target)) predicates.push(activePredicate);
  for (const child of schema.allOf ?? []) {
    predicates.push(...requirementPredicates(child, target, properties, activePredicate));
  }
  for (const keyword of ['anyOf', 'oneOf'] as const) {
    for (const child of schema[keyword] ?? []) {
      predicates.push(
        ...requirementPredicates(
          child,
          target,
          properties,
          predicateFromIf(child) ?? activePredicate,
        ),
      );
    }
  }
  if (schema.if) {
    const ifPredicate = predicateFromIf(schema.if);
    if (schema.then) {
      predicates.push(...requirementPredicates(schema.then, target, properties, ifPredicate));
    }
    if (schema.else) {
      predicates.push(
        ...requirementPredicates(
          schema.else,
          target,
          properties,
          complementPredicate(ifPredicate, properties),
        ),
      );
    }
  }
  return predicates;
}

function predicateMatches(
  predicate: RequirementPredicate | undefined,
  values: Readonly<Record<string, unknown>>,
): boolean {
  if (!predicate) return true;
  const current = values[predicate.field] as JsonSchemaValue | undefined;
  return predicate.values.some((value) => valueKey(value) === valueKey(current ?? null));
}

function schemaRequiresField(
  schema: StudioJsonSchema,
  field: string,
  values: Readonly<Record<string, unknown>>,
  properties: Readonly<Record<string, StudioJsonSchema>>,
): boolean {
  if (schema.required?.includes(field)) return true;
  if (
    Object.entries(schema.dependentRequired ?? {}).some(
      ([trigger, targets]) => values[trigger] !== undefined && targets.includes(field),
    )
  ) {
    return true;
  }
  if (schema.allOf?.some((branch) => schemaRequiresField(branch, field, values, properties))) {
    return true;
  }
  for (const keyword of ['anyOf', 'oneOf'] as const) {
    if (
      schema[keyword]?.some(
        (branch) =>
          predicateMatches(predicateFromIf(branch), values) &&
          schemaRequiresField(branch, field, values, properties),
      )
    ) {
      return true;
    }
  }
  if (schema.if) {
    const activeBranch = validateForm(schema.if, values).valid ? schema.then : schema.else;
    if (activeBranch && schemaRequiresField(activeBranch, field, values, properties)) return true;
  }
  return false;
}

export function isFieldRequired(
  document: StudioCapabilityDocument,
  field: string,
  values: Readonly<Record<string, unknown>>,
): boolean {
  return schemaRequiresField(
    document.jsonSchema,
    field,
    values,
    document.jsonSchema.properties ?? {},
  );
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
  for (const [field, schema] of Object.entries(properties)) {
    if (!schema.type || !SUPPORTED_FIELD_TYPES.has(schema.type)) {
      unsupported.add(`properties.${field}.type:explicit-supported-type-required`);
    }
  }
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
  auditConditionalPredicates(document.jsonSchema, document.jsonSchema, properties, '', unsupported);
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
    const requiredPredicates = requirementPredicates(
      document.jsonSchema,
      condition.field,
      properties,
    );
    if (
      requiredPredicates.some(
        (predicate) => !predicate || !visibilityCoversPredicate(condition, predicate),
      )
    ) {
      unsupported.add(`uiSchema.conditions.${condition.field}:hidden-when-required`);
    }
  }

  for (const [trigger, targets] of Object.entries(document.jsonSchema.dependentRequired ?? {})) {
    if (!(trigger in properties) || !orderCounts.has(trigger)) {
      unsupported.add(`$.dependentRequired.${trigger}:unknown-or-unrendered-trigger`);
    }
    for (const target of targets) {
      if (!(target in properties) || !orderCounts.has(target)) {
        unsupported.add(`$.dependentRequired.${trigger}.${target}:unknown-or-unrendered-target`);
        continue;
      }
      const visibility = document.uiSchema.conditions?.find(
        (condition) => condition.field === target,
      );
      if (visibility) {
        const domain = properties[trigger]?.enum;
        const predicate = domain ? { field: trigger, values: domain } : undefined;
        if (!predicate || !visibilityCoversPredicate(visibility, predicate)) {
          unsupported.add(`$.dependentRequired.${trigger}.${target}:hidden-when-required`);
        }
      }
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
  if (
    (error.keyword === 'required' || error.keyword === 'dependentRequired') &&
    'missingProperty' in error.params
  ) {
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
  return normalizeCapabilityValues(document, defaults);
}

export function normalizeCapabilityValues(
  document: StudioCapabilityDocument,
  values: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const normalized: Record<string, unknown> = { ...values };
  const properties = document.jsonSchema.properties ?? {};
  for (let pass = 0; pass <= document.uiSchema.order.length; pass += 1) {
    let changed = false;
    for (const field of document.uiSchema.order) {
      if (
        normalized[field] === undefined &&
        properties[field]?.type === 'boolean' &&
        isFieldVisible(document, field, normalized) &&
        isFieldRequired(document, field, normalized)
      ) {
        normalized[field] = false;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return normalized;
}

export function removeCapabilityValue(
  document: StudioCapabilityDocument,
  values: Readonly<Record<string, unknown>>,
  field: string,
): Readonly<Record<string, unknown>> {
  let next = Object.fromEntries(Object.entries(values).filter(([key]) => key !== field));
  const properties = document.jsonSchema.properties ?? {};
  const dependencies = document.jsonSchema.dependentRequired ?? {};
  const pending = [field];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const trigger = pending.shift();
    if (!trigger || visited.has(trigger)) continue;
    visited.add(trigger);
    for (const target of dependencies[trigger] ?? []) {
      if (
        next[target] === false &&
        properties[target]?.type === 'boolean' &&
        !isFieldRequired(document, target, next)
      ) {
        next = Object.fromEntries(Object.entries(next).filter(([key]) => key !== target));
        pending.push(target);
      }
    }
  }
  return normalizeCapabilityValues(document, next);
}

export function prepareCapabilityParameters(
  document: StudioCapabilityDocument,
  values: Readonly<Record<string, unknown>>,
): PreparedCapabilityParameters {
  const normalizedValues = normalizeCapabilityValues(document, values);
  const hiddenOptional = new Set<string>();
  for (const field of document.uiSchema.order) {
    if (
      !isFieldRequired(document, field, normalizedValues) &&
      !isFieldVisible(document, field, normalizedValues)
    ) {
      hiddenOptional.add(field);
    }
  }
  const order = new Set(document.uiSchema.order);
  const parameters = Object.fromEntries(
    Object.entries(normalizedValues).filter(
      ([field]) => order.has(field) && !hiddenOptional.has(field),
    ),
  );
  const unknownValues = Object.fromEntries(
    Object.entries(normalizedValues).filter(([field]) => !order.has(field)),
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
