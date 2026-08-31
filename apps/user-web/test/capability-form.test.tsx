import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CapabilityForm,
  prepareCapabilityParameters,
  validateForm,
} from '../components/studio/capability-form';
import { ProMode } from '../components/studio/pro-mode';
import { QuoteConfirmation } from '../components/studio/quote-confirmation';
import { SmartMode } from '../components/studio/smart-mode';
import { StudioWorkspace } from '../components/studio/studio-workspace';
import { auditCapabilityDocument, defaultCapabilityValues } from '../lib/studio/capability';
import { studioGateway } from '../lib/studio/gateway';
import { parseCapability } from '../lib/studio/runtime';
import type {
  StudioCapabilityDocument,
  StudioCreateTaskRequest,
  StudioGateway,
  StudioQuote,
} from '../lib/studio/types';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const imageToVideoCapability = {
  schemaVersion: 1,
  capabilityVersion: 'capability-image-v7',
  mode: 'IMAGE_TO_VIDEO',
  jsonSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      image: { type: 'string', minLength: 1 },
      duration: { type: 'integer', default: 5, minimum: 3, maximum: 10 },
      motion: { type: 'string', enum: ['natural', 'custom'], default: 'natural' },
      customMotion: { type: 'string', minLength: 4, maxLength: 120 },
    },
    required: ['image', 'duration', 'motion'],
    allOf: [
      {
        if: { properties: { motion: { const: 'custom' } }, required: ['motion'] },
        then: { required: ['customMotion'] },
      },
    ],
  },
  uiSchema: {
    order: ['image', 'duration', 'motion', 'customMotion'],
    groups: [
      { key: 'source', title: '输入素材', fields: ['image'] },
      {
        key: 'generation',
        title: '生成参数',
        fields: ['duration', 'motion', 'customMotion'],
      },
    ],
    fields: {
      image: { label: '起始图片', widget: 'asset-id', help: '从素材库选择一张图片。' },
      duration: { label: '时长', unit: '秒', help: '支持 3 到 10 秒。' },
      motion: {
        label: '运动模式',
        options: [
          { value: 'natural', label: '自然运动' },
          { value: 'custom', label: '自定义' },
        ],
      },
      customMotion: { label: '自定义运动描述', widget: 'textarea' },
    },
    conditions: [{ field: 'customMotion', when: { field: 'motion', equals: 'custom' } }],
  },
  costDimensions: ['duration'],
} satisfies StudioCapabilityDocument;

describe('CapabilityForm', () => {
  it('renders required enum and conditional fields in UI Schema order', async () => {
    const user = userEvent.setup();
    render(<CapabilityForm document={imageToVideoCapability} onValid={vi.fn()} />);

    expect(screen.getAllByLabelText(/.+/).map((node) => node.getAttribute('name'))).toEqual([
      'image',
      'duration',
      'motion',
    ]);

    await user.selectOptions(screen.getByLabelText('运动模式'), 'custom');
    expect(screen.getByLabelText('自定义运动描述')).toBeVisible();
    expect(screen.getByLabelText('自定义运动描述')).toHaveAttribute('aria-required', 'true');
    expect(screen.getAllByLabelText(/.+/).map((node) => node.getAttribute('name'))).toEqual([
      'image',
      'duration',
      'motion',
      'customMotion',
    ]);
  });

  it('rejects unknown fields before quote request', () => {
    expect(
      validateForm(imageToVideoCapability.jsonSchema, {
        image: 'asset-1',
        duration: 5,
        motion: 'natural',
        injected: true,
      }),
    ).toMatchObject({ valid: false });
  });

  it('reuses a validator for one schema object without colliding on repeated $id values', async () => {
    const user = userEvent.setup();
    const identifiedSchema = {
      ...imageToVideoCapability.jsonSchema,
      $id: 'urn:studio:test:identified-capability',
    };
    const identifiedDocument: StudioCapabilityDocument = {
      ...imageToVideoCapability,
      jsonSchema: identifiedSchema,
    };

    expect(
      validateForm(identifiedSchema, { image: 'asset-1', duration: 5, motion: 'natural' }),
    ).toMatchObject({ valid: true });
    expect(
      validateForm(identifiedSchema, { image: 'asset-2', duration: 5, motion: 'natural' }),
    ).toMatchObject({ valid: true });

    const sameIdDifferentSchema = {
      ...identifiedSchema,
      properties: {
        ...identifiedSchema.properties,
        duration: { type: 'integer' as const, maximum: 4 },
      },
    };
    const differentResult = validateForm(sameIdDifferentSchema, {
      image: 'asset-1',
      duration: 5,
      motion: 'natural',
    });
    expect(differentResult.valid).toBe(false);
    expect(differentResult.errors.some((error) => error.keyword === 'maximum')).toBe(true);
    expect(differentResult.errors.some((error) => error.keyword === 'compile')).toBe(false);

    const onValid = vi.fn();
    render(<CapabilityForm document={identifiedDocument} onValid={onValid} />);
    await user.type(screen.getByLabelText('起始图片'), 'asset-3');
    await waitFor(() => {
      expect(onValid).toHaveBeenCalledWith(
        expect.objectContaining({ image: 'asset-3', duration: 5, motion: 'natural' }),
      );
    });
  });

  it('blocks the whole capability when a keyword is unsupported and reports versions', () => {
    const unsupportedDocument: StudioCapabilityDocument = {
      ...imageToVideoCapability,
      schemaVersion: 202012,
      capabilityVersion: 'capability-image-v8',
      jsonSchema: {
        ...imageToVideoCapability.jsonSchema,
        unevaluatedProperties: false,
      },
    };

    render(<CapabilityForm document={unsupportedDocument} onValid={vi.fn()} />);

    expect(screen.getByRole('alert')).toHaveTextContent('模型配置暂不可用');
    expect(screen.getByRole('alert')).toHaveTextContent('202012');
    expect(screen.getByRole('alert')).toHaveTextContent('capability-image-v8');
    expect(screen.queryByLabelText('起始图片')).not.toBeInTheDocument();
  });

  it('fails closed when Schema and UI metadata cannot render every field exactly once', () => {
    const baseProperties = imageToVideoCapability.jsonSchema.properties;
    const baseFields = imageToVideoCapability.uiSchema.fields;
    const invalidDocuments: readonly (readonly [string, StudioCapabilityDocument])[] = [
      [
        'property missing from order',
        {
          ...imageToVideoCapability,
          jsonSchema: {
            ...imageToVideoCapability.jsonSchema,
            properties: { ...baseProperties, orphan: { type: 'string', default: 'leak' } },
          },
        },
      ],
      [
        'duplicate order field',
        {
          ...imageToVideoCapability,
          uiSchema: {
            ...imageToVideoCapability.uiSchema,
            order: ['image', 'duration', 'duration', 'motion', 'customMotion'],
          },
        },
      ],
      [
        'unknown order field',
        {
          ...imageToVideoCapability,
          uiSchema: {
            ...imageToVideoCapability.uiSchema,
            order: [...imageToVideoCapability.uiSchema.order, 'ghost'],
          },
        },
      ],
      [
        'unknown group field',
        {
          ...imageToVideoCapability,
          uiSchema: {
            ...imageToVideoCapability.uiSchema,
            groups: [
              ...imageToVideoCapability.uiSchema.groups,
              { key: 'ghost', title: 'Ghost', fields: ['ghost'] },
            ],
          },
        },
      ],
      [
        'duplicate grouped field',
        {
          ...imageToVideoCapability,
          uiSchema: {
            ...imageToVideoCapability.uiSchema,
            groups: [
              ...imageToVideoCapability.uiSchema.groups,
              { key: 'duplicate', title: 'Duplicate', fields: ['image'] },
            ],
          },
        },
      ],
      [
        'ungrouped order field',
        {
          ...imageToVideoCapability,
          uiSchema: {
            ...imageToVideoCapability.uiSchema,
            groups: imageToVideoCapability.uiSchema.groups.map((group) => ({
              ...group,
              fields: group.fields.filter((field) => field !== 'motion'),
            })),
          },
        },
      ],
      [
        'unknown ui field metadata',
        {
          ...imageToVideoCapability,
          uiSchema: {
            ...imageToVideoCapability.uiSchema,
            fields: { ...baseFields, ghost: { label: 'Ghost' } },
          },
        },
      ],
      [
        'unknown required field',
        {
          ...imageToVideoCapability,
          jsonSchema: { ...imageToVideoCapability.jsonSchema, required: ['image', 'ghost'] },
        },
      ],
      [
        'unconditionally required hidden field',
        {
          ...imageToVideoCapability,
          jsonSchema: {
            ...imageToVideoCapability.jsonSchema,
            required: [...imageToVideoCapability.jsonSchema.required, 'customMotion'],
          },
        },
      ],
      [
        'incomplete condition',
        {
          ...imageToVideoCapability,
          uiSchema: {
            ...imageToVideoCapability.uiSchema,
            conditions: [{ field: 'customMotion', when: { field: 'motion' } }],
          },
        },
      ],
      [
        'conditional required field hidden when required',
        {
          ...imageToVideoCapability,
          uiSchema: {
            ...imageToVideoCapability.uiSchema,
            conditions: [{ field: 'customMotion', when: { field: 'motion', equals: 'natural' } }],
          },
        },
      ],
      [
        'duplicate condition',
        {
          ...imageToVideoCapability,
          uiSchema: {
            ...imageToVideoCapability.uiSchema,
            conditions: [
              ...imageToVideoCapability.uiSchema.conditions,
              { field: 'customMotion', when: { field: 'motion', equals: 'natural' } },
            ],
          },
        },
      ],
      [
        'unknown condition target',
        {
          ...imageToVideoCapability,
          uiSchema: {
            ...imageToVideoCapability.uiSchema,
            conditions: [{ field: 'ghost', when: { field: 'motion', equals: 'custom' } }],
          },
        },
      ],
      [
        'unknown condition dependency',
        {
          ...imageToVideoCapability,
          uiSchema: {
            ...imageToVideoCapability.uiSchema,
            conditions: [{ field: 'customMotion', when: { field: 'ghost', equals: true } }],
          },
        },
      ],
      [
        'unsupported widget',
        {
          ...imageToVideoCapability,
          uiSchema: {
            ...imageToVideoCapability.uiSchema,
            fields: { ...baseFields, image: { ...baseFields.image, widget: 'slider' as never } },
          },
        },
      ],
      [
        'unsupported field type',
        {
          ...imageToVideoCapability,
          jsonSchema: {
            ...imageToVideoCapability.jsonSchema,
            properties: { ...baseProperties, duration: { type: 'number' } },
          },
        },
      ],
      [
        'missing field type',
        {
          ...imageToVideoCapability,
          jsonSchema: {
            ...imageToVideoCapability.jsonSchema,
            properties: { ...baseProperties, duration: {} },
          },
        },
      ],
      [
        'widget and type mismatch',
        {
          ...imageToVideoCapability,
          uiSchema: {
            ...imageToVideoCapability.uiSchema,
            fields: { ...baseFields, image: { ...baseFields.image, widget: 'boolean' } },
          },
        },
      ],
      [
        'options and enum mismatch',
        {
          ...imageToVideoCapability,
          uiSchema: {
            ...imageToVideoCapability.uiSchema,
            fields: {
              ...baseFields,
              motion: {
                ...baseFields.motion,
                options: [{ value: 'natural', label: '自然运动' }],
              },
            },
          },
        },
      ],
      [
        'dependentRequired is not renderable',
        {
          ...imageToVideoCapability,
          jsonSchema: {
            ...imageToVideoCapability.jsonSchema,
            dependentRequired: { motion: ['ghost'] },
          },
        },
      ],
      [
        'nested dependentRequired cannot be safely rendered',
        {
          ...imageToVideoCapability,
          jsonSchema: {
            ...imageToVideoCapability.jsonSchema,
            allOf: [
              ...imageToVideoCapability.jsonSchema.allOf,
              { dependentRequired: { motion: ['customMotion'] } },
            ],
          },
        },
      ],
    ];

    for (const [name, document] of invalidDocuments) {
      expect.soft(auditCapabilityDocument(document), name).not.toEqual([]);
    }
  });

  it('rejects unknown capability and UI instruction keys at every runtime layer', () => {
    const cases: readonly unknown[] = [
      { ...imageToVideoCapability, vendorInstruction: true },
      {
        ...imageToVideoCapability,
        uiSchema: { ...imageToVideoCapability.uiSchema, hidden: ['image'] },
      },
      {
        ...imageToVideoCapability,
        uiSchema: {
          ...imageToVideoCapability.uiSchema,
          groups: imageToVideoCapability.uiSchema.groups.map((group, index) =>
            index === 0 ? { ...group, collapsible: true } : group,
          ),
        },
      },
      {
        ...imageToVideoCapability,
        uiSchema: {
          ...imageToVideoCapability.uiSchema,
          fields: {
            ...imageToVideoCapability.uiSchema.fields,
            image: { ...imageToVideoCapability.uiSchema.fields.image, readOnly: true },
          },
        },
      },
      {
        ...imageToVideoCapability,
        uiSchema: {
          ...imageToVideoCapability.uiSchema,
          fields: {
            ...imageToVideoCapability.uiSchema.fields,
            motion: {
              ...imageToVideoCapability.uiSchema.fields.motion,
              options: imageToVideoCapability.uiSchema.fields.motion.options.map((option, index) =>
                index === 0 ? { ...option, icon: 'spark' } : option,
              ),
            },
          },
        },
      },
      {
        ...imageToVideoCapability,
        uiSchema: {
          ...imageToVideoCapability.uiSchema,
          conditions: imageToVideoCapability.uiSchema.conditions.map((condition) => ({
            ...condition,
            priority: 1,
          })),
        },
      },
      {
        ...imageToVideoCapability,
        uiSchema: {
          ...imageToVideoCapability.uiSchema,
          conditions: imageToVideoCapability.uiSchema.conditions.map((condition) => ({
            ...condition,
            when: { ...condition.when, hidden: true },
          })),
        },
      },
    ];

    for (const value of cases) expect.soft(() => parseCapability(value)).toThrow();
  });

  it('only initializes and emits renderable ordered fields while rejecting injected values', () => {
    const document: StudioCapabilityDocument = {
      ...imageToVideoCapability,
      jsonSchema: {
        ...imageToVideoCapability.jsonSchema,
        properties: {
          ...imageToVideoCapability.jsonSchema.properties,
          orphan: { type: 'string', default: 'must-not-leak' },
        },
      },
    };

    expect(defaultCapabilityValues(document)).not.toHaveProperty('orphan');
    const prepared = prepareCapabilityParameters(imageToVideoCapability, {
      image: 'asset-1',
      duration: 5,
      motion: 'natural',
      injected: 'must-not-emit',
    });
    expect(prepared.valid).toBe(false);
    expect(prepared.parameters).not.toHaveProperty('injected');
  });

  it('initializes a required boolean without a default as explicit false', async () => {
    const booleanDocument: StudioCapabilityDocument = {
      ...imageToVideoCapability,
      capabilityVersion: 'required-boolean-v1',
      jsonSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { consent: { type: 'boolean' } },
        required: ['consent'],
      },
      uiSchema: {
        order: ['consent'],
        groups: [{ key: 'rules', title: '规则', fields: ['consent'] }],
        fields: { consent: { label: '接受规则', widget: 'boolean' } },
      },
    };
    const onValid = vi.fn();

    render(<CapabilityForm document={booleanDocument} onValid={onValid} />);

    expect(screen.getByLabelText('接受规则')).not.toBeChecked();
    await waitFor(() => {
      expect(onValid).toHaveBeenCalledWith({ consent: false });
    });
  });

  it('supports finite if/then/else required fields with matching visibility predicates', async () => {
    const user = userEvent.setup();
    const document: StudioCapabilityDocument = {
      schemaVersion: 202012,
      capabilityVersion: 'finite-if-else-v1',
      mode: 'TEXT_TO_VIDEO',
      jsonSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', enum: ['custom', 'normal'], default: 'custom' },
          customPrompt: { type: 'string', minLength: 2 },
          normalPrompt: { type: 'string', minLength: 2 },
        },
        required: ['mode'],
        if: { properties: { mode: { const: 'custom' } }, required: ['mode'] },
        then: { required: ['customPrompt'] },
        else: { required: ['normalPrompt'] },
      },
      uiSchema: {
        order: ['mode', 'customPrompt', 'normalPrompt'],
        groups: [
          { key: 'mode', title: '模式', fields: ['mode'] },
          { key: 'prompt', title: '描述', fields: ['customPrompt', 'normalPrompt'] },
        ],
        fields: {
          mode: {
            label: '提示模式',
            options: [
              { value: 'custom', label: '自定义' },
              { value: 'normal', label: '普通' },
            ],
          },
          customPrompt: { label: '自定义提示' },
          normalPrompt: { label: '普通提示' },
        },
        conditions: [
          { field: 'customPrompt', when: { field: 'mode', equals: 'custom' } },
          { field: 'normalPrompt', when: { field: 'mode', notEquals: 'custom' } },
        ],
      },
      costDimensions: [],
    };

    expect(auditCapabilityDocument(document)).toEqual([]);
    render(<CapabilityForm document={document} onValid={vi.fn()} />);
    expect(screen.getByLabelText('自定义提示')).toHaveAttribute('aria-required', 'true');
    expect(screen.queryByLabelText('普通提示')).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('提示模式'), 'normal');
    expect(screen.queryByLabelText('自定义提示')).not.toBeInTheDocument();
    expect(screen.getByLabelText('普通提示')).toHaveAttribute('aria-required', 'true');
  });

  it('requires a conditional discriminator to be present before deriving hidden required fields', () => {
    const conditionalDocument = (
      presence: 'none' | 'if-required' | 'root-required' | 'default',
    ): StudioCapabilityDocument => ({
      schemaVersion: 202012,
      capabilityVersion: `conditional-${presence}`,
      mode: 'TEXT_TO_VIDEO',
      jsonSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: {
            type: 'string',
            enum: ['custom', 'normal'],
            ...(presence === 'default' ? { default: 'custom' } : {}),
          },
          customPrompt: { type: 'string' },
          normalPrompt: { type: 'string' },
        },
        ...(presence === 'root-required' ? { required: ['mode'] } : {}),
        if: {
          properties: { mode: { const: 'custom' } },
          ...(presence === 'if-required' ? { required: ['mode'] } : {}),
        },
        then: { required: ['customPrompt'] },
        else: { required: ['normalPrompt'] },
      },
      uiSchema: {
        order: ['mode', 'customPrompt', 'normalPrompt'],
        groups: [
          { key: 'mode', title: '模式', fields: ['mode'] },
          { key: 'prompts', title: '提示词', fields: ['customPrompt', 'normalPrompt'] },
        ],
        fields: {},
        conditions: [
          { field: 'customPrompt', when: { field: 'mode', equals: 'custom' } },
          { field: 'normalPrompt', when: { field: 'mode', notEquals: 'custom' } },
        ],
      },
      costDimensions: [],
    });

    expect(auditCapabilityDocument(conditionalDocument('none'))).not.toEqual([]);
    expect(auditCapabilityDocument(conditionalDocument('if-required'))).toEqual([]);
    expect(auditCapabilityDocument(conditionalDocument('root-required'))).toEqual([]);
    expect(auditCapabilityDocument(conditionalDocument('default'))).toEqual([]);
  });

  it('supports a finite discriminated oneOf branch with target schemas beside the discriminator', async () => {
    const user = userEvent.setup();
    const document: StudioCapabilityDocument = {
      schemaVersion: 202012,
      capabilityVersion: 'finite-one-of-v1',
      mode: 'TEXT_TO_VIDEO',
      jsonSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['image', 'text'], default: 'image' },
          imagePrompt: { type: 'string', minLength: 2 },
          textPrompt: { type: 'string', minLength: 2 },
        },
        required: ['kind'],
        oneOf: [
          {
            properties: { kind: { const: 'image' }, imagePrompt: { minLength: 2 } },
            required: ['imagePrompt'],
          },
          {
            properties: { kind: { const: 'text' }, textPrompt: { minLength: 2 } },
            required: ['textPrompt'],
          },
        ],
      },
      uiSchema: {
        order: ['kind', 'imagePrompt', 'textPrompt'],
        groups: [
          { key: 'kind', title: '类型', fields: ['kind'] },
          { key: 'prompt', title: '描述', fields: ['imagePrompt', 'textPrompt'] },
        ],
        fields: {
          kind: {
            label: '素材类型',
            options: [
              { value: 'image', label: '图片' },
              { value: 'text', label: '文字' },
            ],
          },
          imagePrompt: { label: '图片提示' },
          textPrompt: { label: '文字提示' },
        },
        conditions: [
          { field: 'imagePrompt', when: { field: 'kind', equals: 'image' } },
          { field: 'textPrompt', when: { field: 'kind', equals: 'text' } },
        ],
      },
      costDimensions: [],
    };

    expect(auditCapabilityDocument(document)).toEqual([]);
    render(<CapabilityForm document={document} onValid={vi.fn()} />);
    expect(screen.getByLabelText('图片提示')).toHaveAttribute('aria-required', 'true');
    await user.selectOptions(screen.getByLabelText('素材类型'), 'text');
    expect(screen.getByLabelText('文字提示')).toHaveAttribute('aria-required', 'true');
  });

  it('rejects overlapping anyOf predicates used for dynamic required fields', () => {
    const document: StudioCapabilityDocument = {
      schemaVersion: 202012,
      capabilityVersion: 'overlapping-any-of-v1',
      mode: 'TEXT_TO_VIDEO',
      jsonSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['image', 'text'], default: 'image' },
          broadPrompt: { type: 'string' },
          imagePrompt: { type: 'string' },
        },
        required: ['kind'],
        anyOf: [
          {
            properties: { kind: { enum: ['image', 'text'] }, broadPrompt: { minLength: 1 } },
            required: ['broadPrompt'],
          },
          {
            properties: { kind: { const: 'image' }, imagePrompt: { minLength: 1 } },
            required: ['imagePrompt'],
          },
        ],
      },
      uiSchema: {
        order: ['kind', 'broadPrompt', 'imagePrompt'],
        groups: [
          { key: 'kind', title: '类型', fields: ['kind'] },
          { key: 'prompts', title: '提示词', fields: ['broadPrompt', 'imagePrompt'] },
        ],
        fields: {},
        conditions: [
          { field: 'broadPrompt', when: { field: 'kind', in: ['image', 'text'] } },
          { field: 'imagePrompt', when: { field: 'kind', equals: 'image' } },
        ],
      },
      costDimensions: [],
    };

    expect(auditCapabilityDocument(document)).not.toEqual([]);
  });

  it('supports visible dependentRequired targets and initializes required booleans to false', async () => {
    const user = userEvent.setup();
    const document: StudioCapabilityDocument = {
      schemaVersion: 202012,
      capabilityVersion: 'dependent-required-v1',
      mode: 'TEXT_TO_VIDEO',
      jsonSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          trigger: { type: 'string', minLength: 1 },
          dependentFlag: { type: 'boolean' },
        },
        dependentRequired: { trigger: ['dependentFlag'] },
      },
      uiSchema: {
        order: ['trigger', 'dependentFlag'],
        groups: [{ key: 'dependency', title: '依赖', fields: ['trigger', 'dependentFlag'] }],
        fields: {
          trigger: { label: '触发值' },
          dependentFlag: { label: '依赖开关', widget: 'boolean' },
        },
      },
      costDimensions: [],
    };
    const onValid = vi.fn();

    expect(auditCapabilityDocument(document)).toEqual([]);
    expect(validateForm(document.jsonSchema, { trigger: 'on' }).errors).toEqual([
      expect.objectContaining({ field: 'dependentFlag', keyword: 'dependentRequired' }),
    ]);
    render(<CapabilityForm document={document} onValid={onValid} />);
    expect(screen.getByLabelText('依赖开关')).not.toHaveAttribute('aria-required');

    await user.type(screen.getByLabelText('触发值'), 'on');
    expect(screen.getByLabelText('依赖开关')).toHaveAttribute('aria-required', 'true');
    expect(screen.getByLabelText('依赖开关')).not.toBeChecked();
    await waitFor(() => {
      expect(onValid).toHaveBeenCalledWith({ trigger: 'on', dependentFlag: false });
    });
  });

  it('normalizes chained and cyclic dependent booleans to a fixed point independent of UI order', async () => {
    const user = userEvent.setup();
    const chainDocument: StudioCapabilityDocument = {
      schemaVersion: 202012,
      capabilityVersion: 'dependent-chain-v1',
      mode: 'TEXT_TO_VIDEO',
      jsonSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          a: { type: 'string', minLength: 1 },
          b: { type: 'boolean' },
          c: { type: 'boolean' },
        },
        dependentRequired: { a: ['b'], b: ['c'] },
      },
      uiSchema: {
        order: ['a', 'c', 'b'],
        groups: [{ key: 'chain', title: '链式依赖', fields: ['a', 'c', 'b'] }],
        fields: {
          a: { label: '触发字段' },
          b: { label: '第二开关', widget: 'boolean' },
          c: { label: '第三开关', widget: 'boolean' },
        },
      },
      costDimensions: [],
    };
    const onValid = vi.fn();

    render(<CapabilityForm document={chainDocument} onValid={onValid} />);
    await user.type(screen.getByLabelText('触发字段'), 'on');
    expect(screen.getByLabelText('第二开关')).toHaveAttribute('aria-required', 'true');
    expect(screen.getByLabelText('第三开关')).toHaveAttribute('aria-required', 'true');
    await waitFor(() => {
      expect(onValid).toHaveBeenCalledWith({ a: 'on', c: false, b: false });
    });

    await user.clear(screen.getByLabelText('触发字段'));
    expect(screen.getByLabelText('第二开关')).not.toHaveAttribute('aria-required');
    expect(screen.getByLabelText('第三开关')).not.toHaveAttribute('aria-required');
    await waitFor(() => {
      expect(onValid).toHaveBeenLastCalledWith({});
    });

    expect(prepareCapabilityParameters(chainDocument, {}).parameters).toEqual({});

    const cycleDocument: StudioCapabilityDocument = {
      ...chainDocument,
      capabilityVersion: 'dependent-cycle-v1',
      jsonSchema: {
        ...chainDocument.jsonSchema,
        properties: { a: { type: 'boolean' }, b: { type: 'boolean' } },
        required: ['a'],
        dependentRequired: { a: ['b'], b: ['a'] },
      },
      uiSchema: {
        order: ['b', 'a'],
        groups: [{ key: 'cycle', title: '循环依赖', fields: ['b', 'a'] }],
        fields: {},
      },
    };
    expect(defaultCapabilityValues(cycleDocument)).toEqual({ b: false, a: false });
  });

  it('rejects a dependentRequired target that can be hidden while its trigger is present', () => {
    const document: StudioCapabilityDocument = {
      ...imageToVideoCapability,
      jsonSchema: {
        ...imageToVideoCapability.jsonSchema,
        dependentRequired: { motion: ['customMotion'] },
      },
    };
    expect(auditCapabilityDocument(document)).not.toEqual([]);
  });

  it('omits hidden optional fields but keeps visible invalid values as blocking errors', () => {
    const hidden = prepareCapabilityParameters(imageToVideoCapability, {
      image: 'asset-1',
      duration: 5,
      motion: 'natural',
      customMotion: 'pan left',
    });
    expect(hidden).toMatchObject({ valid: true, parameters: { motion: 'natural' } });
    expect(hidden.parameters).not.toHaveProperty('customMotion');

    const visibleInvalid = prepareCapabilityParameters(imageToVideoCapability, {
      image: 'asset-1',
      duration: 99,
      motion: 'custom',
      customMotion: 'x',
    });
    expect(visibleInvalid.valid).toBe(false);
    expect(visibleInvalid.parameters).toMatchObject({ duration: 99, customMotion: 'x' });
    expect(visibleInvalid.errors).not.toEqual([]);
  });
});

it('revalidates unknown fields at the Gateway quote boundary', async () => {
  await expect(
    studioGateway.quote({
      routing: {
        kind: 'SMART',
        preferences: {
          generationMode: 'IMAGE_TO_VIDEO',
          quality: 'BALANCED',
          speed: 'BALANCED',
          budgetPoints: 300,
          goal: '产品演示',
        },
      },
      capabilityVersion: 'cap-image-v7',
      parameters: {
        image: 'asset-1',
        duration: 5,
        motion: 'natural',
        injected: true,
      },
    }),
  ).rejects.toThrow('INVALID_PARAMETERS');
});

it('compares fixture task snapshots independently of object key order', async () => {
  const parameters = { image: 'asset-key-order', duration: 5, motion: 'natural' };
  const acceptedQuote = await studioGateway.quote({
    routing: {
      kind: 'SMART',
      preferences: {
        generationMode: 'IMAGE_TO_VIDEO',
        quality: 'BALANCED',
        speed: 'BALANCED',
        budgetPoints: 300,
        goal: '测试快照',
      },
    },
    capabilityVersion: 'cap-image-v7',
    parameters,
  });

  await expect(
    studioGateway.createTask(
      {
        quoteId: acceptedQuote.id,
        capabilityVersion: acceptedQuote.capabilityVersion,
        parameters: { motion: 'natural', duration: 5, image: 'asset-key-order' },
        quotedPoints: acceptedQuote.quotedPoints,
      },
      { idempotencyKey: '00000000-0000-4000-8000-000000000099' },
    ),
  ).resolves.toMatchObject({ status: 'QUEUED' });
});

it('states Smart routing inputs and does not pretend a final model is already selected', () => {
  render(<SmartMode value={undefined} onChange={vi.fn()} />);

  for (const label of ['生成方式', '质量偏好', '速度偏好', '预算上限', '创作目标']) {
    expect(screen.getByLabelText(label)).toBeVisible();
  }
  expect(screen.getByText(/报价时由智能路由选择满足条件的模型/)).toBeVisible();
  expect(screen.queryByText(/已选择模型/)).not.toBeInTheDocument();
});

it('keeps Pro selection exact, disables maintenance models and requires explicit fallback opt-in', () => {
  render(
    <ProMode
      providers={[{ id: 'provider-a', name: '平台 A' }]}
      models={[
        {
          id: 'model-active',
          providerId: 'provider-a',
          name: '精确模型',
          status: 'ACTIVE',
          capabilityVersion: 'cap-v1',
        },
        {
          id: 'model-maintenance',
          providerId: 'provider-a',
          name: '维护模型',
          status: 'MAINTENANCE',
          capabilityVersion: 'cap-v2',
        },
      ]}
      value={{ providerId: 'provider-a', modelId: 'model-active', allowEquivalentFallback: false }}
      onChange={vi.fn()}
    />,
  );

  expect(screen.getByRole('option', { name: /维护模型.*维护中/ })).toBeDisabled();
  expect(screen.getByText(/严格使用所选平台和模型/)).toBeVisible();
  expect(screen.getByLabelText('允许同等能力故障切换')).not.toBeChecked();
});

const quote: StudioQuote = {
  id: 'quote-1',
  routing: { kind: 'EXACT_MODEL', modelId: 'model-active', modelName: '精确模型' },
  capabilityVersion: 'cap-v1',
  parameters: { duration: 5, motion: 'natural' },
  parameterSummary: [
    { key: 'duration', label: '时长', value: '5', unit: '秒' },
    { key: 'motion', label: '运动模式', value: '自然运动' },
  ],
  quotedPoints: '12345678901234567890',
  expiresAt: '2026-08-31T10:01:30.000Z',
  failureRefundRule: '供应商生成失败，冻结点数全额退回。',
  cancellationRule: '供应商受理后仅在其支持取消时可取消，并按确认规则退款。',
};

const workspaceQuote: StudioQuote = {
  ...quote,
  id: 'workspace-quote-1',
  routing: { kind: 'SMART_ROUTING', promise: '按本次偏好选择可用模型' },
  capabilityVersion: imageToVideoCapability.capabilityVersion,
  parameters: { image: 'asset-1', duration: 5, motion: 'natural' },
  expiresAt: '2099-08-31T10:01:30.000Z',
};

function testGateway(overrides: Partial<StudioGateway> = {}): StudioGateway {
  return {
    listProviders: vi.fn().mockResolvedValue([{ id: 'provider-a', name: '平台 A' }]),
    listModels: vi.fn().mockResolvedValue([
      {
        id: 'model-active',
        providerId: 'provider-a',
        name: '精确模型',
        status: 'ACTIVE',
        capabilityVersion: imageToVideoCapability.capabilityVersion,
      },
    ]),
    getCapability: vi.fn().mockResolvedValue(imageToVideoCapability),
    getSmartCapability: vi.fn().mockResolvedValue(imageToVideoCapability),
    quote: vi.fn().mockResolvedValue(workspaceQuote),
    createTask: vi.fn().mockResolvedValue({ taskId: 'task-1', status: 'QUEUED' }),
    ...overrides,
  };
}

it('invalidates an existing quote when any quote input changes', async () => {
  const user = userEvent.setup();
  const gateway: StudioGateway = {
    listProviders: vi.fn().mockResolvedValue([{ id: 'provider-a', name: '平台 A' }]),
    listModels: vi.fn().mockResolvedValue([
      {
        id: 'model-active',
        providerId: 'provider-a',
        name: '精确模型',
        status: 'ACTIVE',
        capabilityVersion: imageToVideoCapability.capabilityVersion,
      },
    ]),
    getCapability: vi.fn().mockResolvedValue(imageToVideoCapability),
    getSmartCapability: vi.fn().mockResolvedValue(imageToVideoCapability),
    quote: vi.fn().mockResolvedValue(workspaceQuote),
    createTask: vi.fn(),
  };

  render(<StudioWorkspace gateway={gateway} />);
  await user.type(await screen.findByLabelText('起始图片'), 'asset-1');
  const quoteButton = screen.getByRole('button', { name: '获取准确报价' });
  await waitFor(() => {
    expect(quoteButton).toBeEnabled();
  });
  await user.click(quoteButton);
  expect(await screen.findByRole('heading', { name: '本次报价与任务规则' })).toBeVisible();

  await user.selectOptions(screen.getByLabelText('质量偏好'), 'QUALITY_FIRST');
  expect(screen.queryByRole('heading', { name: '本次报价与任务规则' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '获取准确报价' })).toBeVisible();
});

it('ignores an in-flight quote response after quote inputs change', async () => {
  const user = userEvent.setup();
  let resolveQuote: ((value: StudioQuote) => void) | undefined;
  const pendingQuote = new Promise<StudioQuote>((resolve) => {
    resolveQuote = resolve;
  });
  const gateway: StudioGateway = {
    listProviders: vi.fn().mockResolvedValue([{ id: 'provider-a', name: '平台 A' }]),
    listModels: vi.fn().mockResolvedValue([
      {
        id: 'model-active',
        providerId: 'provider-a',
        name: '精确模型',
        status: 'ACTIVE',
        capabilityVersion: imageToVideoCapability.capabilityVersion,
      },
    ]),
    getCapability: vi.fn().mockResolvedValue(imageToVideoCapability),
    getSmartCapability: vi.fn().mockResolvedValue(imageToVideoCapability),
    quote: vi.fn().mockReturnValue(pendingQuote),
    createTask: vi.fn(),
  };

  render(<StudioWorkspace gateway={gateway} />);
  await user.type(await screen.findByLabelText('起始图片'), 'asset-1');
  const quoteButton = screen.getByRole('button', { name: '获取准确报价' });
  await waitFor(() => {
    expect(quoteButton).toBeEnabled();
  });
  await user.click(quoteButton);
  expect(screen.getByRole('button', { name: '正在获取报价' })).toBeDisabled();

  await user.selectOptions(screen.getByLabelText('质量偏好'), 'QUALITY_FIRST');
  resolveQuote?.(workspaceQuote);
  await Promise.resolve();
  await waitFor(() => {
    expect(screen.getByRole('button', { name: '获取准确报价' })).toBeVisible();
  });
  expect(screen.queryByRole('heading', { name: '本次报价与任务规则' })).not.toBeInTheDocument();
});

function taskRequest(): StudioCreateTaskRequest {
  return {
    quoteId: quote.id,
    capabilityVersion: quote.capabilityVersion,
    parameters: quote.parameters,
    quotedPoints: quote.quotedPoints,
  };
}

it('shows quote summary, BigInt-safe points, rules and blocks an expired quote', () => {
  const gateway = { createTask: vi.fn() } satisfies Pick<StudioGateway, 'createTask'>;
  const { rerender } = render(
    <QuoteConfirmation
      quote={quote}
      gateway={gateway}
      request={taskRequest()}
      now={() => Date.parse('2026-08-31T10:00:00.000Z')}
    />,
  );

  expect(screen.getByText('精确模型')).toBeVisible();
  expect(screen.getByText('12,345,678,901,234,567,890')).toBeVisible();
  expect(screen.getByText(/时长.*5/)).toBeVisible();
  expect(screen.getByText('01:30')).toBeVisible();
  expect(screen.getByText(quote.failureRefundRule)).toBeVisible();
  expect(screen.getByText(quote.cancellationRule)).toBeVisible();

  rerender(
    <QuoteConfirmation
      quote={quote}
      gateway={gateway}
      request={taskRequest()}
      now={() => Date.parse('2026-08-31T10:01:31.000Z')}
    />,
  );
  expect(screen.getByRole('button', { name: '报价已过期' })).toBeDisabled();
  expect(screen.getByText(/请重新报价/)).toBeVisible();
});

it('uses a fresh UUID for each definitive submission attempt and ignores repeated clicks', async () => {
  let rejectFirst: ((reason: Error) => void) | undefined;
  const firstAttempt = new Promise<never>((_resolve, reject) => {
    rejectFirst = reject;
  });
  const createTask = vi
    .fn<StudioGateway['createTask']>()
    .mockReturnValueOnce(firstAttempt)
    .mockResolvedValueOnce({ taskId: 'task-2', status: 'QUEUED' });
  const keys = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'];
  const uuidFactory = vi.fn(() => keys.shift() ?? 'unexpected');

  render(
    <QuoteConfirmation
      quote={quote}
      gateway={{ createTask }}
      request={taskRequest()}
      now={() => Date.parse('2026-08-31T10:00:00.000Z')}
      uuidFactory={uuidFactory}
    />,
  );

  const submit = screen.getByRole('button', { name: '确认并创建任务' });
  fireEvent.click(submit);
  fireEvent.click(submit);
  expect(createTask).toHaveBeenCalledTimes(1);
  expect(createTask.mock.calls[0]?.[1]).toEqual({
    idempotencyKey: '00000000-0000-4000-8000-000000000001',
  });
  expect(submit).toBeDisabled();

  if (rejectFirst) {
    rejectFirst(Object.assign(new Error('rejected'), { outcome: 'DEFINITIVE_FAILURE' as const }));
  }
  await screen.findByRole('alert');
  await waitFor(() => {
    expect(submit).toBeEnabled();
  });
  fireEvent.click(submit);

  await waitFor(() => {
    expect(createTask).toHaveBeenCalledTimes(2);
  });
  expect(createTask.mock.calls[1]?.[1]).toEqual({
    idempotencyKey: '00000000-0000-4000-8000-000000000002',
  });
  expect(uuidFactory).toHaveBeenCalledTimes(2);
});

it('reuses the idempotency key when a submission response is uncertain', async () => {
  const createTask = vi
    .fn<StudioGateway['createTask']>()
    .mockRejectedValueOnce(new Error('response lost'))
    .mockResolvedValueOnce({ taskId: 'task-existing', status: 'QUEUED' });
  const uuidFactory = vi.fn(() => '00000000-0000-4000-8000-000000000009');

  render(
    <QuoteConfirmation
      quote={quote}
      gateway={{ createTask }}
      request={taskRequest()}
      now={() => Date.parse('2026-08-31T10:00:00.000Z')}
      uuidFactory={uuidFactory}
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: '确认并创建任务' }));
  await screen.findByText(/结果尚未确认/);
  fireEvent.click(screen.getByRole('button', { name: '安全查询原提交' }));

  await waitFor(() => {
    expect(createTask).toHaveBeenCalledTimes(2);
  });
  expect(createTask.mock.calls[0]?.[1]).toEqual(createTask.mock.calls[1]?.[1]);
  expect(uuidFactory).toHaveBeenCalledTimes(1);
});

it('does not let a stale Smart capability response overwrite the selected Pro model', async () => {
  let resolveLateSmart: ((document: StudioCapabilityDocument) => void) | undefined;
  const lateSmart = new Promise<StudioCapabilityDocument>((resolve) => {
    resolveLateSmart = resolve;
  });
  const initialDocument: StudioCapabilityDocument = {
    ...imageToVideoCapability,
    capabilityVersion: 'smart-initial-v1',
  };
  const proDocument: StudioCapabilityDocument = {
    ...imageToVideoCapability,
    capabilityVersion: 'pro-exact-v2',
  };
  const getSmartCapability = vi
    .fn<StudioGateway['getSmartCapability']>()
    .mockResolvedValueOnce(initialDocument)
    .mockReturnValueOnce(lateSmart);
  const gateway: StudioGateway = {
    listProviders: vi.fn().mockResolvedValue([{ id: 'provider-a', name: '平台 A' }]),
    listModels: vi.fn().mockResolvedValue([
      {
        id: 'model-active',
        providerId: 'provider-a',
        name: '精确模型',
        status: 'ACTIVE',
        capabilityVersion: 'pro-exact-v2',
      },
    ]),
    getCapability: vi.fn().mockResolvedValue(proDocument),
    getSmartCapability,
    quote: vi.fn(),
    createTask: vi.fn(),
  };

  render(<StudioWorkspace gateway={gateway} />);
  expect(await screen.findByText('能力版本 smart-initial-v1')).toBeVisible();

  await userEvent.selectOptions(screen.getByLabelText('生成方式'), 'TEXT_TO_VIDEO');
  fireEvent.click(screen.getByRole('button', { name: '专业模式' }));
  expect(await screen.findByText('能力版本 pro-exact-v2')).toBeVisible();

  resolveLateSmart?.({ ...imageToVideoCapability, capabilityVersion: 'stale-smart-v9' });
  await waitFor(() => {
    expect(screen.getByText('能力版本 pro-exact-v2')).toBeVisible();
  });
  expect(screen.queryByText('能力版本 stale-smart-v9')).not.toBeInTheDocument();
});

it('loads the exact capability when the catalog arrives after switching to Pro', async () => {
  let resolveProviders:
    ((providers: Awaited<ReturnType<StudioGateway['listProviders']>>) => void) | undefined;
  let resolveModels:
    ((models: Awaited<ReturnType<StudioGateway['listModels']>>) => void) | undefined;
  let resolveLateSmart: ((document: StudioCapabilityDocument) => void) | undefined;
  const providers = new Promise<Awaited<ReturnType<StudioGateway['listProviders']>>>((resolve) => {
    resolveProviders = resolve;
  });
  const models = new Promise<Awaited<ReturnType<StudioGateway['listModels']>>>((resolve) => {
    resolveModels = resolve;
  });
  const lateSmart = new Promise<StudioCapabilityDocument>((resolve) => {
    resolveLateSmart = resolve;
  });
  const initialSmartDocument: StudioCapabilityDocument = {
    ...imageToVideoCapability,
    capabilityVersion: 'smart-before-catalog-v1',
  };
  const proDocument: StudioCapabilityDocument = {
    ...imageToVideoCapability,
    capabilityVersion: 'pro-after-catalog-v2',
  };
  const getSmartCapability = vi
    .fn<StudioGateway['getSmartCapability']>()
    .mockResolvedValueOnce(initialSmartDocument)
    .mockReturnValueOnce(lateSmart);
  const getCapability = vi.fn<StudioGateway['getCapability']>().mockResolvedValue(proDocument);
  const gateway: StudioGateway = {
    listProviders: vi.fn().mockReturnValue(providers),
    listModels: vi.fn().mockReturnValue(models),
    getCapability,
    getSmartCapability,
    quote: vi.fn(),
    createTask: vi.fn(),
  };

  render(<StudioWorkspace gateway={gateway} />);
  expect(await screen.findByText('能力版本 smart-before-catalog-v1')).toBeVisible();

  fireEvent.click(screen.getByRole('button', { name: '专业模式' }));
  expect(screen.queryByText('能力版本 smart-before-catalog-v1')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '获取准确报价' })).toBeDisabled();

  fireEvent.click(screen.getByRole('button', { name: '智能模式' }));
  fireEvent.click(screen.getByRole('button', { name: '专业模式' }));
  resolveProviders?.([{ id: 'provider-a', name: '平台 A' }]);
  resolveModels?.([
    {
      id: 'model-active',
      providerId: 'provider-a',
      name: '精确模型',
      status: 'ACTIVE',
      capabilityVersion: proDocument.capabilityVersion,
    },
  ]);

  await waitFor(() => {
    expect(getCapability).toHaveBeenCalledTimes(1);
    expect(getCapability).toHaveBeenCalledWith('model-active');
  });
  expect(await screen.findByText('能力版本 pro-after-catalog-v2')).toBeVisible();

  resolveLateSmart?.({ ...imageToVideoCapability, capabilityVersion: 'late-smart-v9' });
  await waitFor(() => {
    expect(screen.getByText('能力版本 pro-after-catalog-v2')).toBeVisible();
  });
  expect(screen.queryByText('能力版本 late-smart-v9')).not.toBeInTheDocument();
});

it('fails closed on malformed catalog and capability payloads', async () => {
  const malformedCatalog = testGateway({
    listProviders: vi.fn().mockResolvedValue([{ id: 7, name: null }] as never),
  });
  const { unmount } = render(<StudioWorkspace gateway={malformedCatalog} />);
  expect(await screen.findByText(/工作台配置加载失败/)).toBeVisible();
  unmount();

  const malformedCapability = testGateway({
    getSmartCapability: vi.fn().mockResolvedValue({ mode: 'IMAGE_TO_VIDEO' } as never),
  });
  render(<StudioWorkspace gateway={malformedCapability} />);
  expect(await screen.findByText(/暂时无法加载这类生成能力/)).toBeVisible();
  expect(screen.getByRole('button', { name: '获取准确报价' })).toBeDisabled();
});

it('rejects Smart mode and Pro capability-version mismatches', async () => {
  const smartMismatch = testGateway({
    getSmartCapability: vi
      .fn()
      .mockResolvedValue({ ...imageToVideoCapability, mode: 'TEXT_TO_VIDEO' }),
  });
  const { unmount } = render(<StudioWorkspace gateway={smartMismatch} />);
  expect(await screen.findByText(/暂时无法加载这类生成能力/)).toBeVisible();
  unmount();

  const proMismatch = testGateway({
    getCapability: vi.fn().mockResolvedValue({
      ...imageToVideoCapability,
      capabilityVersion: 'unexpected-capability-v9',
    }),
  });
  render(<StudioWorkspace gateway={proMismatch} />);
  await screen.findByText(`能力版本 ${imageToVideoCapability.capabilityVersion}`);
  fireEvent.click(screen.getByRole('button', { name: '专业模式' }));
  expect(await screen.findByText(/所选模型当前不可用/)).toBeVisible();
  expect(screen.queryByText('能力版本 unexpected-capability-v9')).not.toBeInTheDocument();
});

it.each([
  [
    'parameter snapshot',
    { ...workspaceQuote, parameters: { image: 'asset-1', duration: 6, motion: 'natural' } },
  ],
  [
    'routing',
    {
      ...workspaceQuote,
      routing: { kind: 'EXACT_MODEL' as const, modelId: 'model-active', modelName: '精确模型' },
    },
  ],
])('rejects a quote with a mismatched %s', async (_name, mismatchedQuote) => {
  const user = userEvent.setup();
  render(
    <StudioWorkspace
      gateway={testGateway({ quote: vi.fn().mockResolvedValue(mismatchedQuote) })}
    />,
  );
  await user.type(await screen.findByLabelText('起始图片'), 'asset-1');
  const quoteButton = screen.getByRole('button', { name: '获取准确报价' });
  await waitFor(() => {
    expect(quoteButton).toBeEnabled();
  });
  await user.click(quoteButton);

  expect(await screen.findByRole('alert')).toHaveTextContent('报价未完成');
  expect(screen.queryByRole('heading', { name: '本次报价与任务规则' })).not.toBeInTheDocument();
});

it('rejects malformed task acceptance and resets submission state for a replacement quote', async () => {
  const malformedCreate = vi.fn().mockResolvedValue({ status: 'QUEUED' });
  const { unmount } = render(
    <QuoteConfirmation
      gateway={{ createTask: malformedCreate as StudioGateway['createTask'] }}
      now={() => Date.parse('2026-08-31T10:00:00.000Z')}
      quote={quote}
      request={taskRequest()}
      uuidFactory={() => '00000000-0000-4000-8000-000000000010'}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: '确认并创建任务' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('结果尚未确认');
  expect(screen.queryByText(/任务已创建/)).not.toBeInTheDocument();
  unmount();

  const createTask = vi.fn().mockResolvedValue({ taskId: 'task-accepted', status: 'QUEUED' });
  const nextQuote = { ...quote, id: 'quote-2' };
  const nextRequest = { ...taskRequest(), quoteId: nextQuote.id };
  const view = render(
    <QuoteConfirmation
      gateway={{ createTask }}
      now={() => Date.parse('2026-08-31T10:00:00.000Z')}
      quote={quote}
      request={taskRequest()}
      uuidFactory={() => '00000000-0000-4000-8000-000000000011'}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: '确认并创建任务' }));
  expect(await screen.findByText(/任务已创建，编号 task-accepted/)).toBeVisible();
  view.rerender(
    <QuoteConfirmation
      gateway={{ createTask }}
      now={() => Date.parse('2026-08-31T10:00:00.000Z')}
      quote={nextQuote}
      request={nextRequest}
      uuidFactory={() => '00000000-0000-4000-8000-000000000012'}
    />,
  );
  await waitFor(() => {
    expect(screen.getByRole('button', { name: '确认并创建任务' })).toBeEnabled();
  });
});

it.each([
  ['empty', []],
  [
    'maintenance-only',
    [
      {
        id: 'model-maintenance',
        providerId: 'provider-a',
        name: '维护模型',
        status: 'MAINTENANCE' as const,
        capabilityVersion: 'cap-maintenance-v1',
      },
    ],
  ],
])('shows an actionable Pro empty state for an %s catalog', async (_name, catalogModels) => {
  render(
    <StudioWorkspace
      gateway={testGateway({ listModels: vi.fn().mockResolvedValue(catalogModels) })}
    />,
  );
  await screen.findByText(`能力版本 ${imageToVideoCapability.capabilityVersion}`);
  fireEvent.click(screen.getByRole('button', { name: '专业模式' }));

  expect(await screen.findByText(/没有可用模型/)).toBeVisible();
  expect(screen.queryByText('正在加载模型能力')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '获取准确报价' })).toBeDisabled();
});

it('reports catalog rejection without crashing', async () => {
  render(
    <StudioWorkspace
      gateway={testGateway({ listModels: vi.fn().mockRejectedValue(new Error('offline')) })}
    />,
  );
  expect(await screen.findByText(/工作台配置加载失败/)).toBeVisible();
});

it('clears an exact capability when switching to a provider without active models', async () => {
  const models = [
    {
      id: 'model-active',
      providerId: 'provider-a',
      name: '精确模型',
      status: 'ACTIVE' as const,
      capabilityVersion: imageToVideoCapability.capabilityVersion,
    },
    {
      id: 'model-maintenance',
      providerId: 'provider-b',
      name: '维护模型',
      status: 'MAINTENANCE' as const,
      capabilityVersion: 'cap-maintenance-v1',
    },
  ];
  render(
    <StudioWorkspace
      gateway={testGateway({
        listProviders: vi.fn().mockResolvedValue([
          { id: 'provider-a', name: '平台 A' },
          { id: 'provider-b', name: '平台 B' },
        ]),
        listModels: vi.fn().mockResolvedValue(models),
      })}
    />,
  );
  await screen.findByText(`能力版本 ${imageToVideoCapability.capabilityVersion}`);
  fireEvent.click(screen.getByRole('button', { name: '专业模式' }));
  await waitFor(() => {
    expect(screen.getByLabelText('模型')).toHaveValue('model-active');
  });
  fireEvent.change(screen.getByLabelText('平台'), { target: { value: 'provider-b' } });

  expect(await screen.findByText(/没有可用模型/)).toBeVisible();
  expect(
    screen.queryByText(`能力版本 ${imageToVideoCapability.capabilityVersion}`),
  ).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '获取准确报价' })).toBeDisabled();
});

it('derives exact-model quote presentation from the catalog and capability snapshot', async () => {
  const user = userEvent.setup();
  const quoteResponse = vi.fn<StudioGateway['quote']>().mockImplementation((request) =>
    Promise.resolve({
      ...quote,
      id: 'exact-bound-quote',
      routing: {
        kind: 'EXACT_MODEL',
        modelId: 'model-active',
        modelName: '伪造模型名称',
      },
      capabilityVersion: request.capabilityVersion,
      parameters: request.parameters,
      parameterSummary: [{ key: 'wrong', label: '错误摘要', value: '错误值' }],
      expiresAt: '2099-08-31T10:01:30.000Z',
    }),
  );
  render(<StudioWorkspace gateway={testGateway({ quote: quoteResponse })} />);
  await screen.findByText(`能力版本 ${imageToVideoCapability.capabilityVersion}`);
  fireEvent.click(screen.getByRole('button', { name: '专业模式' }));
  const image = await screen.findByLabelText('起始图片');
  await user.type(image, 'asset-bound');
  const quoteButton = screen.getByRole('button', { name: '获取准确报价' });
  await waitFor(() => {
    expect(quoteButton).toBeEnabled();
  });
  await user.click(quoteButton);

  expect(await screen.findByText('精确模型')).toBeVisible();
  expect(screen.queryByText('伪造模型名称')).not.toBeInTheDocument();
  expect(screen.queryByText(/错误摘要/)).not.toBeInTheDocument();
  expect(screen.getByText(/起始图片 asset-bound/)).toBeVisible();
  expect(screen.getByText(/时长 5 秒/)).toBeVisible();
  expect(screen.getByText(/运动模式 自然运动/)).toBeVisible();
});

it('uses the platform Smart promise and derives a complete unique summary', async () => {
  const user = userEvent.setup();
  const quoteResponse = vi.fn<StudioGateway['quote']>().mockImplementation((request) =>
    Promise.resolve({
      ...workspaceQuote,
      id: 'smart-bound-quote',
      routing: { kind: 'SMART_ROUTING', promise: '不可信路由文案' },
      capabilityVersion: request.capabilityVersion,
      parameters: request.parameters,
      parameterSummary: [],
    }),
  );
  render(<StudioWorkspace gateway={testGateway({ quote: quoteResponse })} />);
  await user.type(await screen.findByLabelText('起始图片'), 'asset-smart');
  const quoteButton = screen.getByRole('button', { name: '获取准确报价' });
  await waitFor(() => {
    expect(quoteButton).toBeEnabled();
  });
  await user.click(quoteButton);

  expect(await screen.findByText(/智能路由将在已报价点数内选择满足偏好的可用模型/)).toBeVisible();
  expect(screen.queryByText('不可信路由文案')).not.toBeInTheDocument();
  const summary = screen.getByRole('heading', { name: '参数摘要' }).parentElement;
  expect(summary).toHaveTextContent('起始图片 asset-smart');
  expect(summary).toHaveTextContent('时长 5 秒');
  expect(summary).toHaveTextContent('运动模式 自然运动');
  expect(summary?.querySelectorAll('.parameter-summary p')).toHaveLength(3);
});
