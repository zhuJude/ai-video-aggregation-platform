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
import { studioGateway } from '../lib/studio/gateway';
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
    quote: vi.fn().mockResolvedValue(quote),
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
  resolveQuote?.(quote);
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
