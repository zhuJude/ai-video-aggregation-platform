'use client';

import {
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  Text,
  Textarea,
  Title2,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { useEffect, useMemo, useRef, useState } from 'react';

import { hasPermission } from '../../lib/permissions';
import {
  diffCapabilityFields,
  parseCapabilityDefinition,
  validateCapabilityDefinition,
  type CapabilityClientView,
  type CapabilityDefinition,
  type CapabilityDiff,
} from '../../lib/model-capabilities';
import { createUuidV7, isSameUuidV7 } from '../../lib/uuid-v7';

type ValidationReceipt = Readonly<{
  diff: CapabilityDiff;
  errors: readonly string[];
  expectedVersion: number;
  preflightToken: string;
  pricingImpact: string;
  valid: boolean;
}>;
type PublishReceipt = Readonly<{
  auditRecordId: string;
  requestId: string;
  status: 'PUBLISHED';
  version: number;
  versionId: string;
}>;
type RollbackReceipt = Readonly<{
  auditRecordId: string;
  requestId: string;
  status: 'PUBLISHED';
  version: number;
  versionId: string;
}>;
type Props = Readonly<{
  initial: CapabilityClientView;
  onCreateDraft?: (form: FormData) => Promise<unknown>;
  onPublish?: (form: FormData) => Promise<PublishReceipt>;
  onRollback?: (form: FormData) => Promise<RollbackReceipt>;
  onSave?: (form: FormData) => Promise<unknown>;
  onValidate?: (form: FormData) => Promise<ValidationReceipt>;
  permissions: readonly string[];
}>;

const useStyles = makeStyles({
  root: { display: 'grid', gap: '16px' },
  grid: {
    display: 'grid',
    gap: '14px',
    gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
  },
  panel: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: '14px',
  },
  fields: { display: 'grid', gap: '10px' },
  fieldCard: {
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    display: 'grid',
    gap: '8px',
    paddingBottom: '12px',
  },
  actions: { display: 'flex', flexWrap: 'wrap', gap: '8px' },
  code: { fontFamily: 'Consolas, monospace', minHeight: '220px' },
  preview: { display: 'grid', gap: '10px' },
  history: { margin: 0, paddingLeft: '20px' },
});

function identityForm(
  modelId: string,
  version: number,
  sourceVersionId: string,
  intentId: string,
): FormData {
  const form = new FormData();
  form.set('modelId', modelId);
  form.set('expectedVersion', String(version));
  form.set('intentId', intentId);
  form.set('sourceVersionId', sourceVersionId);
  return form;
}

function definitionForm(
  modelId: string,
  version: number,
  sourceVersionId: string,
  definition: CapabilityDefinition,
  intentId: string,
): FormData {
  const form = identityForm(modelId, version, sourceVersionId, intentId);
  form.set('definition', JSON.stringify(definition));
  return form;
}

function Preview({ definition }: Readonly<{ definition: CapabilityDefinition }>) {
  const properties = definition.schema.properties as
    Record<string, Record<string, unknown>> | undefined;
  const fields = [...definition.uiSchema.fields].sort((a, b) => a.order - b.order);
  const requiredFields = Array.isArray(definition.schema.required)
    ? definition.schema.required as readonly unknown[]
    : [];
  const defaults = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(properties ?? {}).map(([name, property]) => [
          name,
          property.default ?? (Array.isArray(property.enum) ? property.enum[0] : ''),
        ]),
      ),
    [properties],
  );
  const [values, setValues] = useState<Record<string, unknown>>(defaults);
  const [previewErrors, setPreviewErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    setValues(defaults);
    setPreviewErrors({});
  }, [defaults]);
  const setValue = (name: string, value: unknown) => {
    setValues((current) => ({ ...current, [name]: value }));
  };
  const hasValue = (value: unknown) =>
    value !== undefined && value !== null && value !== '' && value !== false;
  return (
    <section aria-label="用户表单实时预览">
      <Title2 as="h3">用户表单实时预览</Title2>
      <div>
        {fields.map((field) => {
          const property = properties?.[field.name];
          if (
            field.condition &&
            JSON.stringify(values[field.condition.field]) !== JSON.stringify(field.condition.equals)
          )
            return null;
          const enumValues = Array.isArray(property?.enum)
            ? property.enum.filter(
                (item): item is boolean | number | string =>
                  typeof item === 'boolean' || typeof item === 'number' || typeof item === 'string',
              )
            : undefined;
          const required = requiredFields.includes(field.name);
          const disabled = (field.mutuallyExclusiveWith ?? []).some((name) =>
            hasValue(values[name]),
          );
          const value = values[field.name];
          const scalarValue =
            typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
              ? String(value)
              : '';
          const control = enumValues ? (
            <select
              aria-label={field.label}
              disabled={disabled}
              onChange={(event) => {
                const selected = enumValues.find(
                  (item) => String(item) === event.currentTarget.value,
                );
                setValue(field.name, selected ?? event.currentTarget.value);
              }}
              required={required}
              value={scalarValue}
            >
              {enumValues.map((item) => (
                <option key={String(item)} value={String(item)}>{String(item)}</option>
              ))}
            </select>
          ) : property?.format === 'asset-reference' ? (
            <input
              accept={
                typeof property.contentMediaType === 'string'
                  ? property.contentMediaType
                  : undefined
              }
              aria-label={field.label}
              data-max-size-bytes={
                typeof property.maxSizeBytes === 'number' ? property.maxSizeBytes : undefined
              }
              disabled={disabled}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                const maximum =
                  typeof property.maxSizeBytes === 'number' ? property.maxSizeBytes : undefined;
                if (file && maximum !== undefined && file.size > maximum) {
                  setValue(field.name, '');
                  setPreviewErrors((current) => ({
                    ...current,
                    [field.name]: `${field.label}文件超过 ${String(maximum)} 字节限制`,
                  }));
                  return;
                }
                setValue(field.name, file?.name ?? '');
                setPreviewErrors((current) => {
                  const next = { ...current };
                  Reflect.deleteProperty(next, field.name);
                  return next;
                });
              }}
              required={required}
              type="file"
            />
          ) : property?.type === 'boolean' ? (
            <Checkbox
              aria-label={field.label}
              checked={value === true}
              disabled={disabled}
              onChange={(_event, data) => {
                setValue(field.name, Boolean(data.checked));
              }}
              required={required}
            />
          ) : property?.type === 'object' || property?.type === 'array' ? (
            <Textarea
              aria-label={field.label}
              disabled={disabled}
              onChange={(_event, data) => {
                setValue(field.name, data.value);
              }}
              placeholder={property.type === 'object' ? '输入 JSON 对象' : '输入 JSON 数组'}
              required={required}
              value={typeof value === 'string' ? value : ''}
            />
          ) : (
            <Input
              aria-label={field.label}
              disabled={disabled}
              max={typeof property?.maximum === 'number' ? property.maximum : undefined}
              maxLength={typeof property?.maxLength === 'number' ? property.maxLength : undefined}
              min={typeof property?.minimum === 'number' ? property.minimum : undefined}
              minLength={typeof property?.minLength === 'number' ? property.minLength : undefined}
              onChange={(_event, data) => {
                if (property?.type === 'number' || property?.type === 'integer') {
                  const parsed = Number(data.value);
                  setValue(field.name, data.value === '' || !Number.isFinite(parsed) ? '' : parsed);
                } else {
                  setValue(field.name, data.value);
                }
              }}
              pattern={typeof property?.pattern === 'string' ? property.pattern : undefined}
              required={required}
              type={property?.type === 'number' || property?.type === 'integer' ? 'number' : 'text'}
              value={
                typeof value === 'string' || typeof value === 'number' ? String(value) : ''
              }
            />
          );
          return (
            <Field
              {...(field.help ? { hint: field.help } : {})}
              key={field.name}
              label={`${field.label}${field.unit ? `（${field.unit}）` : ''}`}
            >
              {control}
            </Field>
          );
        })}
      </div>
      {Object.values(previewErrors).map((error) => (
        <Text key={error} role="alert">
          {error}
        </Text>
      ))}
    </section>
  );
}

export function SchemaEditor({
  initial,
  onCreateDraft,
  onPublish,
  onRollback,
  onSave,
  onValidate,
  permissions,
}: Props) {
  const styles = useStyles();
  const readOnly = initial.status === 'PUBLISHED';
  const canWrite = hasPermission({ permissions }, 'models:write') && !readOnly;
  const canCreateDraft = hasPermission({ permissions }, 'models:write') && readOnly;
  const canPublish = hasPermission({ permissions }, 'models:publish') && !readOnly;
  const canValidate = (canWrite || canPublish) && !readOnly;
  const eligibleRollbackVersions = useMemo(
    () =>
      initial.history.filter(
        (item) => item.status === 'PUBLISHED' && !isSameUuidV7(item.id, initial.versionId),
      ),
    [initial.history, initial.versionId],
  );
  const canRollback =
    hasPermission({ permissions }, 'models:rollback') &&
    eligibleRollbackVersions.length > 0;
  const [definition, setDefinition] = useState(initial.definition);
  const [rawSchema, setRawSchema] = useState(() =>
    JSON.stringify(initial.definition.schema, null, 2),
  );
  const [rawUiSchema, setRawUiSchema] = useState(() =>
    JSON.stringify(initial.definition.uiSchema, null, 2),
  );
  const [errors, setErrors] = useState<readonly string[]>([]);
  const [preflight, setPreflight] = useState<ValidationReceipt>();
  const [dialog, setDialog] = useState<'PUBLISH' | 'ROLLBACK'>();
  const [typedCode, setTypedCode] = useState('');
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [message, setMessage] = useState<string>();
  const [accepted, setAccepted] = useState(false);
  const [rollbackTarget, setRollbackTarget] = useState(
    () => eligibleRollbackVersions[0]?.id ?? '',
  );
  const [intentId, setIntentId] = useState(() => createUuidV7());
  const validationEpoch = useRef(0);
  const operationEpoch = useRef(0);
  const authoritativeIdentity = `${initial.model.id}:${initial.versionId}:${String(initial.version)}`;
  const priorIdentity = useRef(authoritativeIdentity);
  useEffect(() => {
    if (priorIdentity.current !== authoritativeIdentity) {
      priorIdentity.current = authoritativeIdentity;
      validationEpoch.current += 1;
      operationEpoch.current += 1;
      pendingRef.current = false;
      setDefinition(initial.definition);
      setRawSchema(JSON.stringify(initial.definition.schema, null, 2));
      setRawUiSchema(JSON.stringify(initial.definition.uiSchema, null, 2));
      setErrors([]);
      setPreflight(undefined);
      setDialog(undefined);
      setTypedCode('');
      setReason('');
      setConfirmed(false);
      setPending(false);
      setMessage(undefined);
      setAccepted(false);
      setRollbackTarget(eligibleRollbackVersions[0]?.id ?? '');
      setIntentId(createUuidV7());
    }
  }, [authoritativeIdentity, eligibleRollbackVersions, initial.definition]);
  const diff = useMemo(
    () => diffCapabilityFields(initial.publishedDefinition, definition),
    [definition, initial.publishedDefinition],
  );

  function changed(next: CapabilityDefinition, nextSchema?: string, nextUi?: string) {
    validationEpoch.current += 1;
    setDefinition(next);
    setRawSchema(nextSchema ?? JSON.stringify(next.schema, null, 2));
    setRawUiSchema(nextUi ?? JSON.stringify(next.uiSchema, null, 2));
    setErrors([]);
    setPreflight(undefined);
    setAccepted(false);
    setIntentId(createUuidV7());
    setMessage(undefined);
  }
  function parseRaw(schemaText: string, uiText: string) {
    if (schemaText.length + uiText.length > 200_000) {
      setErrors(['JSON 内容超过 200 KB 限制']);
      setPreflight(undefined);
      return;
    }
    try {
      const next = parseCapabilityDefinition({
        ...definition,
        schema: JSON.parse(schemaText) as unknown,
        uiSchema: JSON.parse(uiText) as unknown,
      });
      changed(next, schemaText, uiText);
    } catch {
      setErrors(['JSON 或能力定义格式无效']);
      setPreflight(undefined);
    }
  }
  async function validate() {
    const localErrors = validateCapabilityDefinition(definition);
    if (localErrors.length) {
      setErrors(localErrors);
      setPreflight(undefined);
      return;
    }
    if (!onValidate) {
      setErrors(['未配置权威校验服务']);
      setPreflight(undefined);
      return;
    }
    const epoch = ++validationEpoch.current;
    const expectedIntent = intentId;
    const form = definitionForm(
      initial.model.id,
      initial.version,
      initial.versionId,
      definition,
      expectedIntent,
    );
    try {
      const receipt = await onValidate(form);
      if (validationEpoch.current !== epoch || expectedIntent !== intentId) return;
      setErrors(receipt.errors);
      setPreflight(
        receipt.valid && receipt.errors.length === 0 && receipt.expectedVersion === initial.version
          ? receipt
          : undefined,
      );
    } catch {
      if (validationEpoch.current === epoch) {
        setErrors(['权威校验服务不可用']);
        setPreflight(undefined);
      }
    }
  }
  async function save() {
    if (!onSave || pendingRef.current) return;
    const epoch = operationEpoch.current;
    pendingRef.current = true;
    setPending(true);
    try {
      await onSave(
        definitionForm(
          initial.model.id,
          initial.version,
          initial.versionId,
          definition,
          intentId,
        ),
      );
      if (operationEpoch.current === epoch) setMessage('草稿已保存，等待权威版本刷新');
    } catch {
      if (operationEpoch.current === epoch) setMessage('草稿保存被拒绝或暂时不可用');
    } finally {
      if (operationEpoch.current === epoch) {
        pendingRef.current = false;
        setPending(false);
      }
    }
  }
  async function createDraft() {
    if (!onCreateDraft || pendingRef.current) return;
    const epoch = operationEpoch.current;
    pendingRef.current = true;
    setPending(true);
    try {
      await onCreateDraft(
        identityForm(initial.model.id, initial.version, initial.versionId, intentId),
      );
      if (operationEpoch.current === epoch)
        setMessage('新草稿已创建，等待权威版本刷新');
    } catch {
      if (operationEpoch.current === epoch) setMessage('新草稿创建被拒绝或暂时不可用');
    } finally {
      if (operationEpoch.current === epoch) {
        pendingRef.current = false;
        setPending(false);
      }
    }
  }
  function resetDialog() {
    setDialog(undefined);
    setTypedCode('');
    setReason('');
    setConfirmed(false);
    setMessage(undefined);
  }
  async function submitHighRisk() {
    if (
      !dialog ||
      accepted ||
      pendingRef.current ||
      typedCode !== initial.model.code ||
      !reason.trim() ||
      !confirmed
    ) {
      setMessage('请键入模型代码、填写原因并确认高风险操作');
      return;
    }
    const activeDialog = dialog;
    const epoch = operationEpoch.current;
    const form = definitionForm(
      initial.model.id,
      initial.version,
      initial.versionId,
      definition,
      intentId,
    );
    form.set('modelCode', typedCode);
    form.set('reason', reason.trim());
    form.set('confirmed', 'true');
    pendingRef.current = true;
    setPending(true);
    try {
      if (activeDialog === 'PUBLISH') {
        if (!preflight || !onPublish) throw new Error('missing preflight');
        form.set('preflightToken', preflight.preflightToken);
        const receipt = await onPublish(form);
        if (operationEpoch.current === epoch)
          setMessage(
            `发布已受理：请求 ${receipt.requestId}；审计 ${receipt.auditRecordId}；等待权威版本刷新`,
          );
      } else {
        if (!onRollback || !rollbackTarget) throw new Error('missing rollback');
        form.set('targetVersionId', rollbackTarget);
        const receipt = await onRollback(form);
        if (operationEpoch.current === epoch)
          setMessage(
            `回滚已受理：请求 ${receipt.requestId}；审计 ${receipt.auditRecordId}；等待权威版本刷新`,
          );
      }
      if (operationEpoch.current === epoch) {
        setAccepted(true);
        setPreflight(undefined);
        setDialog(undefined);
      }
    } catch {
      if (operationEpoch.current === epoch)
        setMessage(`${activeDialog === 'PUBLISH' ? '发布' : '回滚'}被拒绝或暂时不可用`);
    } finally {
      if (operationEpoch.current === epoch) {
        pendingRef.current = false;
        setPending(false);
      }
    }
  }

  return (
    <section aria-labelledby="schema-editor-heading" className={styles.root}>
      <div>
        <Title2 as="h2" id="schema-editor-heading">
          {initial.model.displayName} · 能力版本 {initial.version}
        </Title2>
        <Text>
          模型代码 {initial.model.code} · 来源时间 {initial.sourceUpdatedAt}
        </Text>
        {readOnly ? (
          <Text role="status">
            已发布版本不可修改；历史任务继续永久引用提交时的版本与参数快照。
          </Text>
        ) : null}
      </div>
      <div className={styles.grid}>
        <section aria-label="结构化字段构建器" className={styles.panel}>
          <Title2 as="h3">结构化字段构建器</Title2>
          <div className={styles.fields}>
            {definition.uiSchema.fields.map((field) => {
              const properties = definition.schema.properties as Record<
                string,
                Record<string, unknown>
              >;
              const property = properties[field.name] ?? { type: 'string' };
              const required = Array.isArray(definition.schema.required)
                ? definition.schema.required.includes(field.name)
                : false;
              const costDimension = definition.costDimensions.includes(field.name);
              const typeValue =
                property.format === 'asset-reference' ? 'file' : String(property.type);
              const update = (
                next: Partial<{
                  costDimension: boolean;
                  label: string;
                  mapping: string;
                  required: boolean;
                  type: string;
                  unit: string;
                }>,
              ) => {
                const nextProperties = { ...properties };
                if (next.type) {
                  const rest = Object.fromEntries(
                    Object.entries(property).filter(([key]) => key !== 'format'),
                  );
                  nextProperties[field.name] =
                    next.type === 'file'
                      ? { ...rest, format: 'asset-reference', type: 'string' }
                      : { ...rest, type: next.type };
                }
                const requiredSet = new Set(
                  Array.isArray(definition.schema.required)
                    ? (definition.schema.required as readonly string[])
                    : [],
                );
                if (next.required === true) requiredSet.add(field.name);
                if (next.required === false) requiredSet.delete(field.name);
                const costSet = new Set(definition.costDimensions);
                if (next.costDimension === true) costSet.add(field.name);
                if (next.costDimension === false) costSet.delete(field.name);
                const mapping = { ...definition.providerMapping };
                if (next.mapping !== undefined) {
                  if (next.mapping) mapping[field.name] = next.mapping;
                  else {
                    Object.assign(
                      mapping,
                      Object.fromEntries(
                        Object.entries(mapping).filter(([name]) => name !== field.name),
                      ),
                    );
                    Reflect.deleteProperty(mapping, field.name);
                  }
                }
                const fields = definition.uiSchema.fields.map((item) => {
                  if (item.name !== field.name) return item;
                  const updated = {
                    ...item,
                    ...(next.label !== undefined ? { label: next.label } : {}),
                  };
                  if (next.unit !== undefined) {
                    if (next.unit) updated.unit = next.unit;
                    else delete updated.unit;
                  }
                  return updated;
                });
                changed(
                  parseCapabilityDefinition({
                    ...definition,
                    costDimensions: [...costSet],
                    providerMapping: mapping,
                    schema: {
                      ...definition.schema,
                      properties: nextProperties,
                      required: [...requiredSet],
                    },
                    uiSchema: { fields },
                  }),
                );
              };
              return (
                <div className={styles.fieldCard} key={field.name}>
                  <Field label={`${field.name} · UI 标签`}>
                    <Input
                      disabled={!canWrite}
                      value={field.label}
                      onChange={(_event, data) => {
                        update({ label: data.value });
                      }}
                    />
                  </Field>
                  <Field label={`${field.name} · 字段类型`}>
                    <select
                      aria-label={`${field.name} · 字段类型`}
                      disabled={!canWrite}
                      onChange={(event) => {
                        update({ type: event.currentTarget.value });
                      }}
                      value={typeValue}
                    >
                      <option value="string">文本</option>
                      <option value="number">数字</option>
                      <option value="integer">整数</option>
                      <option value="boolean">布尔</option>
                      <option value="object">对象</option>
                      <option value="array">数组</option>
                      <option value="file">文件引用</option>
                    </select>
                  </Field>
                  <Field label={`${field.name} · 供应商映射`}>
                    <Input
                      disabled={!canWrite}
                      value={definition.providerMapping[field.name] ?? ''}
                      onChange={(_event, data) => {
                        update({ mapping: data.value });
                      }}
                    />
                  </Field>
                  <Field label={`${field.name} · 单位`}>
                    <Input
                      disabled={!canWrite}
                      value={field.unit ?? ''}
                      onChange={(_event, data) => {
                        update({ unit: data.value });
                      }}
                    />
                  </Field>
                  <Checkbox
                    checked={required}
                    disabled={!canWrite}
                    label={`${field.name} · 必填`}
                    onChange={(_event, data) => {
                      update({ required: Boolean(data.checked) });
                    }}
                  />
                  <Checkbox
                    checked={costDimension}
                    disabled={!canWrite}
                    label={`${field.name} · 成本维度`}
                    onChange={(_event, data) => {
                      update({ costDimension: Boolean(data.checked) });
                    }}
                  />
                  {canWrite ? (
                    <Button
                      aria-label={`删除 ${field.name}`}
                      onClick={() => {
                        const nextProperties = Object.fromEntries(
                          Object.entries(properties).filter(([name]) => name !== field.name),
                        );
                        const nextMapping = Object.fromEntries(
                          Object.entries(definition.providerMapping).filter(
                            ([name]) => name !== field.name,
                          ),
                        );
                        changed(
                          parseCapabilityDefinition({
                            ...definition,
                            costDimensions: definition.costDimensions.filter(
                              (name) => name !== field.name,
                            ),
                            providerMapping: nextMapping,
                            schema: {
                              ...definition.schema,
                              properties: nextProperties,
                              required: Array.isArray(definition.schema.required)
                                ? definition.schema.required.filter((name) => name !== field.name)
                                : [],
                            },
                            uiSchema: {
                              fields: definition.uiSchema.fields.filter(
                                (item) => item.name !== field.name,
                              ),
                            },
                          }),
                        );
                      }}
                    >
                      删除字段
                    </Button>
                  ) : null}
                </div>
              );
            })}
          </div>
          {canWrite ? (
            <Button
              onClick={() => {
                const name = `field${String(definition.uiSchema.fields.length + 1)}`;
                const properties = {
                  ...(definition.schema.properties as object),
                  [name]: { type: 'string' },
                };
                changed(
                  parseCapabilityDefinition({
                    ...definition,
                    providerMapping: { ...definition.providerMapping, [name]: name },
                    schema: { ...definition.schema, properties },
                    uiSchema: {
                      fields: [
                        ...definition.uiSchema.fields,
                        { label: '新字段', name, order: definition.uiSchema.fields.length + 1 },
                      ],
                    },
                  }),
                );
              }}
            >
              添加字段
            </Button>
          ) : null}
        </section>
        <section aria-label="高级 JSON 模式" className={styles.panel}>
          <Title2 as="h3">原始 JSON 高级模式</Title2>
          <Field label="原始 JSON Schema">
            <Textarea
              aria-label="原始 JSON Schema"
              className={styles.code}
              disabled={!canWrite}
              maxLength={150_000}
              value={rawSchema}
              onChange={(_event, data) => {
                setRawSchema(data.value);
                validationEpoch.current += 1;
                setPreflight(undefined);
                setAccepted(false);
                setIntentId(createUuidV7());
              }}
            />
          </Field>
          <Field label="独立 UI Schema">
            <Textarea
              aria-label="独立 UI Schema"
              className={styles.code}
              disabled={!canWrite}
              maxLength={50_000}
              value={rawUiSchema}
              onChange={(_event, data) => {
                setRawUiSchema(data.value);
                validationEpoch.current += 1;
                setPreflight(undefined);
                setAccepted(false);
                setIntentId(createUuidV7());
              }}
            />
          </Field>
          {canWrite ? (
            <Button
              onClick={() => {
                parseRaw(rawSchema, rawUiSchema);
              }}
            >
              应用 JSON
            </Button>
          ) : null}
        </section>
        <section className={styles.panel}>
          <Preview definition={definition} />
        </section>
        <section className={styles.panel} aria-label="版本历史">
          <Title2 as="h3">版本历史</Title2>
          <ul className={styles.history}>
            {initial.history.map((entry) => (
              <li key={entry.id}>
                v{entry.version} · {entry.status} · {entry.createdAt}
              </li>
            ))}
          </ul>
        </section>
      </div>
      {errors.length ? <div role="alert">{errors.join('；')}</div> : null}
      {message && !dialog ? (
        <Text role={message.includes('拒绝') ? 'alert' : 'status'}>{message}</Text>
      ) : null}
      <div className={styles.actions}>
        {canWrite ? (
          <Button
            disabled={pending}
            onClick={() => {
              void save();
            }}
          >
            保存草稿
          </Button>
        ) : null}
        {canValidate ? (
          <Button
            disabled={pending}
            onClick={() => {
              void validate();
            }}
          >
            校验
          </Button>
        ) : null}
        {canCreateDraft ? (
          <Button
            appearance="primary"
            disabled={pending}
            onClick={() => {
              void createDraft();
            }}
          >
            创建新草稿
          </Button>
        ) : null}
        {canPublish ? (
          <Button
            appearance="primary"
            disabled={!preflight || pending || accepted}
            onClick={() => {
              setDialog('PUBLISH');
            }}
          >
            发布
          </Button>
        ) : null}
        {canRollback ? (
          <Button
            disabled={pending}
            onClick={() => {
              setDialog('ROLLBACK');
            }}
          >
            回滚
          </Button>
        ) : null}
      </div>
      {dialog ? (
        <Dialog
          modalType="modal"
          open
          onOpenChange={(_event, data) => {
            if (!data.open && !pending) resetDialog();
          }}
        >
          <DialogSurface>
            <DialogBody>
              <DialogTitle>{dialog === 'PUBLISH' ? '发布能力版本' : '回滚能力版本'}</DialogTitle>
              <DialogContent className={styles.fields}>
                <Text>
                  模型：{initial.model.displayName}（{initial.model.code}）
                </Text>
                <Text>新增字段：{(preflight?.diff ?? diff).added.join('、') || '无'}</Text>
                <Text>变更字段：{(preflight?.diff ?? diff).changed.join('、') || '无'}</Text>
                <Text>删除字段：{(preflight?.diff ?? diff).removed.join('、') || '无'}</Text>
                <Text>定价影响：{preflight?.pricingImpact ?? '回滚后需重新校验定价'}</Text>
                {dialog === 'ROLLBACK' ? (
                  <Field label="目标已发布版本">
                    <select
                      aria-label="目标已发布版本"
                      disabled={pending}
                      onChange={(event) => {
                        setRollbackTarget(event.currentTarget.value);
                        setIntentId(createUuidV7());
                      }}
                      value={rollbackTarget}
                    >
                      {eligibleRollbackVersions.map((entry) => (
                          <option key={entry.id} value={entry.id}>
                            v{entry.version}
                          </option>
                        ))}
                    </select>
                  </Field>
                ) : null}
                <Field label="键入模型代码">
                  <Input
                    aria-label="键入模型代码"
                    disabled={pending}
                    value={typedCode}
                    onChange={(_event, data) => {
                      setTypedCode(data.value);
                      setIntentId(createUuidV7());
                    }}
                  />
                </Field>
                <Field label={dialog === 'PUBLISH' ? '发布原因' : '回滚原因'}>
                  <Input
                    aria-label={dialog === 'PUBLISH' ? '发布原因' : '回滚原因'}
                    disabled={pending}
                    maxLength={200}
                    value={reason}
                    onChange={(_event, data) => {
                      setReason(data.value);
                      setIntentId(createUuidV7());
                    }}
                  />
                </Field>
                <Checkbox
                  checked={confirmed}
                  disabled={pending}
                  label={dialog === 'PUBLISH' ? '我确认发布新版本' : '我确认回滚版本'}
                  onChange={(_event, data) => {
                    setConfirmed(Boolean(data.checked));
                    setIntentId(createUuidV7());
                  }}
                />
                {message ? (
                  <Text
                    role={message.includes('拒绝') || message.includes('请') ? 'alert' : 'status'}
                  >
                    {message}
                  </Text>
                ) : null}
              </DialogContent>
              <DialogActions>
                <Button disabled={pending} onClick={resetDialog}>
                  取消
                </Button>
                <Button
                  appearance="primary"
                  disabled={pending}
                  onClick={() => {
                    void submitHighRisk();
                  }}
                >
                  {dialog === 'PUBLISH' ? '确认发布' : '确认回滚'}
                </Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      ) : null}
    </section>
  );
}
