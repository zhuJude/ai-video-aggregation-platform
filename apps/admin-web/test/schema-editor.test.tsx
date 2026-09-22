import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SchemaEditor } from '../components/capabilities/schema-editor';
import {
  diffCapabilityFields,
  validateCapabilityDefinition,
  type CapabilityView,
} from '../lib/model-capabilities';

const modelId = '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f';
const secondModelId = '0198f7a4-c6de-7b39-8a4e-73af0c1d2e3f';
const providerId = '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f';
const versionId = '0198f7a4-c6d3-7b39-8a4e-73af0c1d2e3f';
const publishedVersionId = '0198f7a4-c6d4-7b39-8a4e-73af0c1d2e3f';
const auditRecordId = '0198f7a4-c6d5-7b39-8a4e-73af0c1d2e3f';
const requestId = '0198f7a4-c6d6-7b39-8a4e-73af0c1d2e3f';

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
      { group: '基础', help: '描述画面', label: '提示词', name: 'prompt', order: 1 },
      { group: '基础', label: '时长', name: 'duration', order: 2, unit: '秒' },
    ],
  },
} as const;

const view: CapabilityView = {
  assignedAdminIds: [],
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
  ownerAdminId: modelId,
  publishedDefinition: {
    ...definition,
    schema: { ...definition.schema, properties: { prompt: definition.schema.properties.prompt } },
    uiSchema: { fields: [definition.uiSchema.fields[0]] },
    costDimensions: [],
    providerMapping: { prompt: 'prompt' },
  },
  sourceUpdatedAt: '2026-08-28T00:00:00.000Z',
  status: 'DRAFT',
  version: 7,
  versionId,
};

describe('capability validation', () => {
  it('blocks publication when UI fields are absent from JSON Schema', () => {
    const invalid = {
      ...definition,
      uiSchema: {
        fields: [...definition.uiSchema.fields, { label: '运动', name: 'motion', order: 3 }],
      },
    };
    expect(validateCapabilityDefinition(invalid)).toContain('UI 字段 motion 不存在');
  });

  it('validates Draft 2020-12 schema, defaults, ranges, cost dimensions and provider mapping', () => {
    expect(validateCapabilityDefinition(definition)).toEqual([]);
    expect(validateCapabilityDefinition({ ...definition, costDimensions: ['missing'] })).toContain(
      '成本维度 missing 不存在',
    );
    expect(
      validateCapabilityDefinition({ ...definition, providerMapping: { prompt: 'prompt' } }),
    ).toContain('字段 duration 缺少供应商映射');
    const invalidRange = {
      ...definition,
      schema: {
        ...definition.schema,
        properties: {
          ...definition.schema.properties,
          duration: { default: 20, enum: [5, 10], maximum: 10, minimum: 5, type: 'integer' },
        },
      },
    };
    expect(validateCapabilityDefinition(invalidRange).join('；')).toMatch(/默认值|范围/);
    expect(
      validateCapabilityDefinition({
        ...definition,
        schema: {
          ...definition.schema,
          properties: { ...definition.schema.properties, prompt: { pattern: '[', type: 'string' } },
        },
      }),
    ).toContain('JSON Schema 无法安全编译');
    expect(
      validateCapabilityDefinition({ ...definition, costDimensions: ['prompt'] }).join('；'),
    ).toMatch(/可计价语义|缺少单位/);
    expect(
      validateCapabilityDefinition({
        ...definition,
        uiSchema: { fields: definition.uiSchema.fields.map((field) => ({ ...field, order: 1 })) },
      }),
    ).toContain('UI 字段顺序必须唯一且不超过 10000');
  });

  it('validates defaults against the complete property schema', () => {
    const invalid = {
      ...definition,
      schema: {
        ...definition.schema,
        properties: {
          ...definition.schema.properties,
          prompt: { default: '', maxLength: 100, minLength: 1, pattern: '^x$', type: 'string' },
        },
      },
    };
    expect(validateCapabilityDefinition(invalid)).toContain('字段 prompt 默认值不符合完整 Schema');
  });

  it('resolves local refs and composition rules from the root schema', () => {
    const referenced = {
      ...definition,
      schema: {
        ...definition.schema,
        $defs: { nonEmpty: { maxLength: 100, minLength: 2, pattern: '^x', type: 'string' } },
        properties: {
          ...definition.schema.properties,
          prompt: { $ref: '#/$defs/nonEmpty', default: 'xx' },
        },
      },
    };
    expect(validateCapabilityDefinition(referenced)).toEqual([]);

    const conditional = {
      costDimensions: [],
      providerMapping: { mode: 'mode', prompt: 'prompt' },
      schema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        $defs: { advanced: { allOf: [{ minimum: 1 }, { maximum: 3 }], type: 'integer' } },
        additionalProperties: false,
        properties: {
          mode: { $ref: '#/$defs/advanced' },
          prompt: { type: 'string' },
        },
        required: [],
        type: 'object',
      },
      uiSchema: {
        fields: [
          { label: '模式', name: 'mode', order: 1 },
          { condition: { equals: 2, field: 'mode' }, label: '提示词', name: 'prompt', order: 2 },
        ],
      },
    } as const;
    expect(validateCapabilityDefinition(conditional)).toEqual([]);
  });

  it('rejects unsafe regex and unsupported executable schema features before AJV runs', () => {
    const startedAt = Date.now();
    for (const pattern of ['^(a+)+$', '^(a|aa)+$', '^(a{1,3}){1,3}$', '^a?a?a?a?a?$']) {
      const unsafe = {
        ...definition,
        schema: {
          ...definition.schema,
          properties: {
            ...definition.schema.properties,
            prompt: {
              default: `${'a'.repeat(4_000)}!`,
              maxLength: 4_096,
              pattern,
              type: 'string',
            },
          },
        },
      };
      expect(validateCapabilityDefinition(unsafe)).toContain('字段 prompt pattern 不安全');
    }
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(
      validateCapabilityDefinition({
        ...definition,
        schema: {
          ...definition.schema,
          properties: {
            ...definition.schema.properties,
            prompt: { maxLength: 32, pattern: '^[a-z]{1,32}$', type: 'string' },
          },
        },
      }),
    ).toEqual([]);
    expect(
      validateCapabilityDefinition({
        ...definition,
        schema: { ...definition.schema, $async: true },
      }),
    ).toContain('JSON Schema 关键字 $async 不受支持');
    expect(
      validateCapabilityDefinition({
        ...definition,
        schema: {
          ...definition.schema,
          properties: {
            ...definition.schema.properties,
            prompt: { $ref: 'https://attacker.invalid/schema.json' },
          },
        },
      }),
    ).toContain('字段 prompt 只能使用本地 $ref');
  });

  it('computes deterministic added, changed and removed field diffs', () => {
    expect(diffCapabilityFields(view.publishedDefinition, view.definition)).toEqual({
      added: ['duration'],
      changed: [],
      removed: [],
    });
    expect(
      diffCapabilityFields(definition, {
        ...definition,
        providerMapping: { ...definition.providerMapping, prompt: 'request.prompt' },
      }),
    ).toEqual({ added: [], changed: ['prompt'], removed: [] });
    const referenced = {
      ...definition,
      schema: {
        ...definition.schema,
        $defs: { nonEmpty: { minLength: 1, type: 'string' } },
        properties: {
          ...definition.schema.properties,
          prompt: { $ref: '#/$defs/nonEmpty' },
        },
      },
    } as const;
    expect(
      diffCapabilityFields(referenced, {
        ...referenced,
        schema: {
          ...referenced.schema,
          $defs: { nonEmpty: { minLength: 2, type: 'string' } },
        },
      }),
    ).toEqual({ added: [], changed: ['duration', 'prompt'], removed: [] });
  });
});

describe('SchemaEditor', () => {
  it('shows structured builder, raw JSON advanced mode and a live preview', () => {
    render(<SchemaEditor initial={view} permissions={['models:write']} />);
    expect(screen.getByRole('region', { name: '结构化字段构建器' })).toBeVisible();
    expect(screen.getByLabelText('原始 JSON Schema')).toBeVisible();
    expect(screen.getByRole('region', { name: '用户表单实时预览' })).toHaveTextContent('提示词');
  });

  it('edits type, required, cost metadata, provider mapping and unit structurally', () => {
    render(<SchemaEditor initial={view} permissions={['models:write']} />);
    expect(screen.getByLabelText('duration · 字段类型')).toHaveValue('integer');
    expect(screen.getByLabelText('duration · 必填')).toBeChecked();
    expect(screen.getByLabelText('duration · 成本维度')).toBeChecked();
    expect(screen.getByLabelText('duration · 供应商映射')).toHaveValue('duration_seconds');
    expect(screen.getByLabelText('duration · 单位')).toHaveValue('秒');
    expect(screen.getByRole('button', { name: '删除 duration' })).toBeVisible();
  });

  it('previews boolean, object, array and file-reference fields with native controls', () => {
    const previewDefinition = {
      costDimensions: [],
      providerMapping: { asset: 'asset', config: 'config', enabled: 'enabled', tags: 'tags' },
      schema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        additionalProperties: false,
        properties: {
          asset: { format: 'asset-reference', type: 'string' },
          config: { additionalProperties: false, properties: {}, type: 'object' },
          enabled: { default: true, type: 'boolean' },
          tags: { items: { type: 'string' }, type: 'array' },
        },
        required: ['asset'],
        type: 'object',
      },
      uiSchema: {
        fields: [
          { label: '启用', name: 'enabled', order: 1 },
          { label: '配置', name: 'config', order: 2 },
          { label: '标签', name: 'tags', order: 3 },
          { label: '素材', name: 'asset', order: 4 },
        ],
      },
    } as const;
    render(<SchemaEditor initial={{ ...view, definition: previewDefinition }} permissions={[]} />);
    expect(screen.getByLabelText('启用')).toHaveAttribute('type', 'checkbox');
    expect(screen.getByLabelText('配置')).toHaveAttribute('placeholder', '输入 JSON 对象');
    expect(screen.getByLabelText('标签')).toHaveAttribute('placeholder', '输入 JSON 数组');
    expect(screen.getByLabelText('素材')).toHaveAttribute('type', 'file');
  });

  it('applies conditional visibility, mutual exclusion and schema input constraints in preview', () => {
    const previewDefinition = {
      costDimensions: [],
      providerMapping: {
        asset: 'asset',
        mode: 'mode',
        negativePrompt: 'negative_prompt',
        prompt: 'prompt',
      },
      schema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        additionalProperties: false,
        properties: {
          asset: {
            contentMediaType: 'video/mp4',
            format: 'asset-reference',
            maxSizeBytes: 10_485_760,
            type: 'string',
          },
          mode: { default: 'basic', enum: ['basic', 'advanced'], type: 'string' },
          negativePrompt: { type: 'string' },
          prompt: { maxLength: 20, minLength: 2, pattern: '^x', type: 'string' },
        },
        required: ['prompt'],
        type: 'object',
      },
      uiSchema: {
        fields: [
          { label: '模式', name: 'mode', order: 1 },
          {
            condition: { equals: 'advanced', field: 'mode' },
            label: '提示词',
            mutuallyExclusiveWith: ['negativePrompt'],
            name: 'prompt',
            order: 2,
          },
          {
            label: '反向提示词',
            mutuallyExclusiveWith: ['prompt'],
            name: 'negativePrompt',
            order: 3,
          },
          { label: '素材', name: 'asset', order: 4 },
        ],
      },
    } as const;
    render(<SchemaEditor initial={{ ...view, definition: previewDefinition }} permissions={[]} />);
    expect(screen.queryByLabelText('提示词')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('模式'), { target: { value: 'advanced' } });
    expect(screen.getByLabelText('提示词')).toHaveAttribute('minlength', '2');
    expect(screen.getByLabelText('提示词')).toHaveAttribute('maxlength', '20');
    expect(screen.getByLabelText('提示词')).toHaveAttribute('pattern', '^x');
    fireEvent.change(screen.getByLabelText('提示词'), { target: { value: 'x prompt' } });
    expect(screen.getByLabelText('反向提示词')).toBeDisabled();
    expect(screen.getByLabelText('素材')).toHaveAttribute('accept', 'video/mp4');
    expect(screen.getByLabelText('素材')).toHaveAttribute('data-max-size-bytes', '10485760');
  });

  it('preserves numeric condition types and rejects oversized preview files', () => {
    const previewDefinition = {
      costDimensions: [],
      providerMapping: { asset: 'asset', mode: 'mode', prompt: 'prompt' },
      schema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        additionalProperties: false,
        properties: {
          asset: {
            contentMediaType: 'video/mp4',
            format: 'asset-reference',
            maxSizeBytes: 4,
            type: 'string',
          },
          mode: { default: 1, type: 'integer' },
          prompt: { type: 'string' },
        },
        required: [],
        type: 'object',
      },
      uiSchema: {
        fields: [
          { label: '模式', name: 'mode', order: 1 },
          { condition: { equals: 2, field: 'mode' }, label: '提示词', name: 'prompt', order: 2 },
          { label: '素材', name: 'asset', order: 3 },
        ],
      },
    } as const;
    render(<SchemaEditor initial={{ ...view, definition: previewDefinition }} permissions={[]} />);
    expect(screen.queryByLabelText('提示词')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('模式'), { target: { value: '2' } });
    expect(screen.getByLabelText('提示词')).toBeVisible();
    fireEvent.change(screen.getByLabelText('素材'), {
      target: { files: [new File(['12345'], 'oversized.mp4', { type: 'video/mp4' })] },
    });
    expect(screen.getByRole('alert')).toHaveTextContent('素材文件超过 4 字节限制');
  });

  it('keeps published versions read-only', () => {
    render(
      <SchemaEditor
        initial={{ ...view, status: 'PUBLISHED' }}
        permissions={['models:write', 'models:publish']}
      />,
    );
    expect(screen.getByLabelText('原始 JSON Schema')).toBeDisabled();
    expect(screen.queryByRole('button', { name: '保存草稿' })).not.toBeInTheDocument();
    expect(screen.getByText(/已发布版本不可修改/)).toBeVisible();
  });

  it('lets a writer derive a new draft from an immutable published version', async () => {
    const onCreateDraft = vi.fn<(form: FormData) => Promise<unknown>>();
    onCreateDraft.mockResolvedValue({});
    render(
      <SchemaEditor
        initial={{ ...view, status: 'PUBLISHED' }}
        onCreateDraft={onCreateDraft}
        permissions={['models:write']}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '创建新草稿' }));
    await waitFor(() => {
      expect(onCreateDraft).toHaveBeenCalledTimes(1);
    });
    const form = onCreateDraft.mock.calls[0]?.[0];
    expect(form?.get('sourceVersionId')).toBe(versionId);
    expect(form?.get('expectedVersion')).toBe('7');
  });

  it('lets a publish-only approver run read-only preflight and publish', async () => {
    const onValidate = vi.fn(() =>
      Promise.resolve({
        diff: { added: [], changed: [], removed: [] },
        errors: [],
        expectedVersion: 7,
        preflightToken: 'pf_abcdefghijklmnopqrstuvwxyz123456',
        pricingImpact: '无',
        valid: true,
      }),
    );
    render(
      <SchemaEditor initial={view} onValidate={onValidate} permissions={['models:publish']} />,
    );
    fireEvent.click(screen.getByRole('button', { name: '校验' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '发布' })).toBeEnabled();
    });
    expect(screen.queryByRole('button', { name: '保存草稿' })).not.toBeInTheDocument();
  });

  it('requires validation and typed model code before publish, then prevents duplicate submit', async () => {
    let resolvePublish:
      | ((value: {
          auditRecordId: string;
          requestId: string;
          status: 'PUBLISHED';
          version: number;
          versionId: string;
        }) => void)
      | undefined;
    const onValidate = vi.fn(() =>
      Promise.resolve({
        diff: { added: ['duration'], changed: [], removed: [] },
        errors: [],
        expectedVersion: 7,
        preflightToken: 'pf_abcdefghijklmnopqrstuvwxyz123456',
        pricingImpact: '新增时长计费维度',
        valid: true as const,
      }),
    );
    const onPublish = vi.fn(
      () =>
        new Promise<{
          auditRecordId: string;
          requestId: string;
          status: 'PUBLISHED';
          version: number;
          versionId: string;
        }>((resolve) => {
          resolvePublish = resolve;
        }),
    );
    render(
      <SchemaEditor
        initial={view}
        onPublish={onPublish}
        onValidate={onValidate}
        permissions={['models:write', 'models:publish']}
      />,
    );
    expect(screen.getByRole('button', { name: '发布' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '校验' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '发布' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '发布' }));
    expect(screen.getByText('新增字段：duration')).toBeVisible();
    expect(screen.getByText('定价影响：新增时长计费维度')).toBeVisible();
    fireEvent.change(screen.getByLabelText('键入模型代码'), { target: { value: view.model.code } });
    fireEvent.change(screen.getByLabelText('发布原因'), { target: { value: '完成能力校验' } });
    fireEvent.click(screen.getByLabelText('我确认发布新版本'));
    fireEvent.click(screen.getByRole('button', { name: '确认发布' }));
    fireEvent.click(screen.getByRole('button', { name: '确认发布' }));
    expect(onPublish).toHaveBeenCalledTimes(1);
    resolvePublish?.({
      auditRecordId,
      requestId,
      status: 'PUBLISHED',
      version: 8,
      versionId: '0198f7a4-c6d7-7b39-8a4e-73af0c1d2e3f',
    });
    await waitFor(() => expect(screen.getByText(/等待权威版本刷新/)).toBeVisible());
  });

  it('shows rollback only with its fine-grained permission', () => {
    const { rerender } = render(<SchemaEditor initial={view} permissions={['models:publish']} />);
    expect(screen.queryByRole('button', { name: '回滚' })).not.toBeInTheDocument();
    rerender(<SchemaEditor initial={view} permissions={['models:rollback']} />);
    expect(screen.getByRole('button', { name: '回滚' })).toBeVisible();
  });

  it('hides rollback when history contains only the current published version', () => {
    render(
      <SchemaEditor
        initial={{
          ...view,
          history: [
            { createdAt: view.sourceUpdatedAt, id: versionId, status: 'PUBLISHED', version: 7 },
          ],
        }}
        permissions={['models:rollback']}
      />,
    );
    expect(screen.queryByRole('button', { name: '回滚' })).not.toBeInTheDocument();
  });

  it('treats an uppercase UUID variant as the current rollback version', () => {
    render(
      <SchemaEditor
        initial={{
          ...view,
          history: [
            {
              createdAt: view.sourceUpdatedAt,
              id: versionId.toUpperCase(),
              status: 'PUBLISHED',
              version: 7,
            },
          ],
        }}
        permissions={['models:rollback']}
      />,
    );
    expect(screen.queryByRole('button', { name: '回滚' })).not.toBeInTheDocument();
  });

  it('never enables publish without the authoritative validation action', async () => {
    render(<SchemaEditor initial={view} permissions={['models:write', 'models:publish']} />);
    fireEvent.click(screen.getByRole('button', { name: '校验' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('未配置权威校验服务');
    expect(screen.getByRole('button', { name: '发布' })).toBeDisabled();
  });

  it('discards a stale validation response after the draft changes', async () => {
    let resolveValidation:
      | ((value: {
          diff: { added: string[]; changed: string[]; removed: string[] };
          errors: string[];
          expectedVersion: number;
          preflightToken: string;
          pricingImpact: string;
          valid: boolean;
        }) => void)
      | undefined;
    const onValidate = vi.fn(
      () =>
        new Promise<{
          diff: { added: string[]; changed: string[]; removed: string[] };
          errors: string[];
          expectedVersion: number;
          preflightToken: string;
          pricingImpact: string;
          valid: boolean;
        }>((resolve) => {
          resolveValidation = resolve;
        }),
    );
    render(
      <SchemaEditor
        initial={view}
        onValidate={onValidate}
        permissions={['models:write', 'models:publish']}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '校验' }));
    fireEvent.change(screen.getByLabelText('prompt · UI 标签'), { target: { value: '新提示词' } });
    resolveValidation?.({
      diff: { added: [], changed: [], removed: [] },
      errors: [],
      expectedVersion: 7,
      preflightToken: 'pf_abcdefghijklmnopqrstuvwxyz123456',
      pricingImpact: '无',
      valid: true,
    });
    await waitFor(() => {
      expect(onValidate).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByRole('button', { name: '发布' })).toBeDisabled();
  });

  it('replaces local editor state when the authoritative version changes', () => {
    const { rerender } = render(<SchemaEditor initial={view} permissions={['models:write']} />);
    fireEvent.change(screen.getByLabelText('prompt · UI 标签'), {
      target: { value: '本地旧标签' },
    });
    const nextDefinition = {
      ...definition,
      uiSchema: {
        fields: definition.uiSchema.fields.map((field) =>
          field.name === 'prompt' ? { ...field, label: '权威新标签' } : field,
        ),
      },
    };
    rerender(
      <SchemaEditor
        initial={{ ...view, definition: nextDefinition, version: 8 }}
        permissions={['models:write']}
      />,
    );
    expect(screen.getByLabelText('prompt · UI 标签')).toHaveValue('权威新标签');
    expect(screen.getByLabelText('原始 JSON Schema')).toHaveValue(
      JSON.stringify(nextDefinition.schema, null, 2),
    );
  });

  it('replaces local state when navigating to another model at the same version', async () => {
    const onSave = vi.fn<(form: FormData) => Promise<void>>();
    onSave.mockResolvedValue(undefined);
    const { rerender } = render(
      <SchemaEditor initial={view} onSave={onSave} permissions={['models:write']} />,
    );
    fireEvent.change(screen.getByLabelText('prompt · UI 标签'), {
      target: { value: '模型 A 本地标签' },
    });
    const nextDefinition = {
      ...definition,
      uiSchema: {
        fields: definition.uiSchema.fields.map((field) =>
          field.name === 'prompt' ? { ...field, label: '模型 B 权威标签' } : field,
        ),
      },
    };
    rerender(
      <SchemaEditor
        initial={{
          ...view,
          definition: nextDefinition,
          model: { ...view.model, id: secondModelId },
          versionId: publishedVersionId,
        }}
        onSave={onSave}
        permissions={['models:write']}
      />,
    );
    await waitFor(() =>
      expect(screen.getByLabelText('prompt · UI 标签')).toHaveValue('模型 B 权威标签'),
    );
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(1);
    });
    const form = onSave.mock.calls[0]?.[0] as FormData;
    expect(form.get('modelId')).toBe(secondModelId);
    const savedDefinition = form.get('definition');
    expect(typeof savedDefinition).toBe('string');
    if (typeof savedDefinition === 'string')
      expect(JSON.parse(savedDefinition)).toEqual(nextDefinition);
  });
});
