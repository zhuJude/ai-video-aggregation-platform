'use client';

import { useEffect, useMemo, useState, type ChangeEvent, type ReactNode } from 'react';

import {
  auditCapabilityDocument,
  defaultCapabilityValues,
  errorsForField,
  isFieldRequired,
  isFieldVisible,
  normalizeCapabilityValues,
  prepareCapabilityParameters,
  removeCapabilityValue,
  validateForm,
  type PreparedCapabilityParameters,
} from '../../lib/studio/capability';
import type {
  JsonSchemaValue,
  StudioCapabilityDocument,
  StudioJsonSchema,
  StudioUiField,
} from '../../lib/studio/types';

export { prepareCapabilityParameters, validateForm };

interface CapabilityFormProps {
  readonly document: StudioCapabilityDocument;
  readonly onValid: (parameters: Readonly<Record<string, unknown>>) => void;
  readonly onChange?: (
    values: Readonly<Record<string, unknown>>,
    result: PreparedCapabilityParameters,
  ) => void;
}

interface FieldSegment {
  readonly key: string;
  readonly title: string;
  readonly fields: readonly string[];
}

function optionLabel(meta: StudioUiField, value: JsonSchemaValue): string {
  return meta.options?.find((option) => option.value === value)?.label ?? String(value);
}

function displayError(message: string): string {
  const normalized = message.replace(/^must /, '需要');
  return `参数${normalized}`;
}

function fieldSegments(document: StudioCapabilityDocument): readonly FieldSegment[] {
  const groupByField = new Map<string, { key: string; title: string }>();
  for (const group of document.uiSchema.groups) {
    for (const field of group.fields) groupByField.set(field, group);
  }

  const segments: { key: string; title: string; fields: string[] }[] = [];
  for (const field of document.uiSchema.order) {
    const group = groupByField.get(field) ?? { key: 'other', title: '其他参数' };
    const previous = segments.at(-1);
    if (previous?.key === group.key) previous.fields.push(field);
    else segments.push({ key: group.key, title: group.title, fields: [field] });
  }
  return segments;
}

function FieldFrame({
  children,
  error,
  field,
  help,
  label,
  required,
  unit,
}: {
  readonly children: ReactNode;
  readonly error: string | undefined;
  readonly field: string;
  readonly help: string | undefined;
  readonly label: string;
  readonly required: boolean;
  readonly unit: string | undefined;
}) {
  const helpId = help ? `${field}-help` : undefined;
  const errorId = error ? `${field}-error` : undefined;
  const describedBy = [helpId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div className="capability-field" data-invalid={error ? 'true' : undefined}>
      <label htmlFor={field}>
        <span>
          {label}
          {required ? (
            <span className="required-marker" aria-hidden="true">
              {' '}
              *
            </span>
          ) : null}
        </span>
        {unit ? <small>{unit}</small> : null}
      </label>
      <div data-field-control data-describedby={describedBy}>
        {children}
      </div>
      {help ? (
        <p id={helpId} className="field-help">
          {help}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="field-error" role="alert">
          {displayError(error)}
        </p>
      ) : null}
    </div>
  );
}

export function CapabilityForm({ document, onChange, onValid }: CapabilityFormProps) {
  const unsupported = useMemo(() => auditCapabilityDocument(document), [document]);
  const [formState, setFormState] = useState(() => {
    const automaticFields = new Set<string>();
    return {
      automaticFields,
      values: defaultCapabilityValues(document, automaticFields),
    };
  });
  const { values } = formState;

  useEffect(() => {
    const automaticFields = new Set<string>();
    setFormState({
      automaticFields,
      values: defaultCapabilityValues(document, automaticFields),
    });
  }, [document]);

  const prepared = useMemo(() => prepareCapabilityParameters(document, values), [document, values]);

  useEffect(() => {
    if (unsupported.length > 0) return;
    onChange?.(values, prepared);
    if (prepared.valid) onValid(prepared.parameters);
  }, [onChange, onValid, prepared, unsupported.length, values]);

  if (unsupported.length > 0) {
    return (
      <section className="capability-blocked" role="alert">
        <h2>模型配置暂不可用</h2>
        <p>
          Schema {document.schemaVersion} · 能力版本 {document.capabilityVersion}
        </p>
        <p>当前配置包含工作台尚未支持的约束，请稍后重试或选择其他模型。</p>
      </section>
    );
  }

  const properties = document.jsonSchema.properties ?? {};
  const globalErrors = prepared.errors.filter(
    (error) =>
      !error.field ||
      !document.uiSchema.order.includes(error.field) ||
      !isFieldVisible(document, error.field, values),
  );
  const updateField = (field: string, value: unknown) => {
    setFormState((current) => {
      const automaticFields = new Set(current.automaticFields);
      automaticFields.delete(field);
      if (value === undefined || value === '') {
        return {
          automaticFields,
          values: removeCapabilityValue(document, current.values, field, automaticFields),
        };
      }
      return {
        automaticFields,
        values: normalizeCapabilityValues(
          document,
          { ...current.values, [field]: value },
          automaticFields,
        ),
      };
    });
  };

  const inputValue = (value: unknown): string => {
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    return '';
  };

  const renderField = (field: string, schema: StudioJsonSchema): ReactNode => {
    if (!isFieldVisible(document, field, values)) return null;

    const meta = document.uiSchema.fields?.[field] ?? {};
    const label = meta.label ?? schema.title ?? field;
    const required = isFieldRequired(document, field, values);
    const fieldErrors = errorsForField(prepared.errors, field);
    const error = fieldErrors[0]?.message;
    const describedBy = [meta.help ? `${field}-help` : null, error ? `${field}-error` : null]
      .filter(Boolean)
      .join(' ');
    const common = {
      'aria-describedby': describedBy || undefined,
      'aria-invalid': error ? ('true' as const) : undefined,
      'aria-label': label,
      'aria-required': required ? ('true' as const) : undefined,
      id: field,
      name: field,
      required,
    };

    let control: ReactNode;
    if (schema.enum) {
      control = (
        <select
          {...common}
          value={inputValue(values[field])}
          onChange={(event) => {
            const selected = schema.enum?.find(
              (candidate) => String(candidate) === event.target.value,
            );
            updateField(field, selected);
          }}
        >
          <option value="" disabled>
            请选择
          </option>
          {schema.enum.map((option) => (
            <option key={String(option)} value={String(option)}>
              {optionLabel(meta, option)}
            </option>
          ))}
        </select>
      );
    } else if (schema.type === 'boolean') {
      control = (
        <input
          {...common}
          checked={values[field] === true}
          type="checkbox"
          onChange={(event) => {
            updateField(field, event.target.checked);
          }}
        />
      );
    } else if (schema.type === 'integer') {
      control = (
        <input
          {...common}
          max={schema.maximum}
          min={schema.minimum}
          step={schema.multipleOf ?? 1}
          type="number"
          value={inputValue(values[field])}
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            updateField(field, event.target.value === '' ? undefined : event.target.valueAsNumber);
          }}
        />
      );
    } else if (meta.widget === 'textarea') {
      control = (
        <textarea
          {...common}
          maxLength={schema.maxLength}
          minLength={schema.minLength}
          placeholder={meta.placeholder}
          rows={4}
          value={inputValue(values[field])}
          onChange={(event) => {
            updateField(field, event.target.value);
          }}
        />
      );
    } else {
      control = (
        <input
          {...common}
          maxLength={schema.maxLength}
          minLength={schema.minLength}
          pattern={schema.pattern}
          placeholder={meta.placeholder}
          type="text"
          value={inputValue(values[field])}
          onChange={(event) => {
            updateField(field, event.target.value);
          }}
        />
      );
    }

    return (
      <FieldFrame
        error={error}
        field={field}
        help={meta.help ?? schema.description}
        key={field}
        label={label}
        required={required}
        unit={meta.unit}
      >
        {control}
      </FieldFrame>
    );
  };

  return (
    <form
      className="capability-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
      }}
    >
      {fieldSegments(document).map((segment, index) => {
        const visibleFields = segment.fields.filter((field) =>
          isFieldVisible(document, field, values),
        );
        if (visibleFields.length === 0) return null;
        return (
          <fieldset key={`${segment.key}-${String(index)}`}>
            <legend>{segment.title}</legend>
            <div className="capability-fields">
              {visibleFields.map((field) => {
                const schema = properties[field];
                return schema ? renderField(field, schema) : null;
              })}
            </div>
          </fieldset>
        );
      })}
      {globalErrors.length > 0 ? (
        <div className="capability-form-errors" role="alert">
          <strong>请检查参数组合</strong>
          {globalErrors.map((error, index) => (
            <p key={`${error.keyword}-${String(index)}`}>{displayError(error.message)}</p>
          ))}
        </div>
      ) : null}
    </form>
  );
}
