import type {
  JsonSchemaValue,
  StudioCapabilityDocument,
  StudioCreateTaskRequest,
  StudioGateway,
  StudioGenerationMode,
  StudioModelOption,
  StudioParameterSummaryItem,
  StudioProviderOption,
  StudioQuote,
  StudioQuoteRequest,
  StudioTaskAccepted,
} from './types';
import { validateForm } from './capability';
import { stableDeepEqual } from './runtime';

const providers: readonly StudioProviderOption[] = [
  { id: 'mock-provider-east', name: '演示平台 East' },
  { id: 'mock-provider-west', name: '演示平台 West' },
];

const models: readonly StudioModelOption[] = [
  {
    id: 'mock-cinema-v2',
    providerId: 'mock-provider-east',
    name: 'Cinema V2',
    status: 'ACTIVE',
    capabilityVersion: 'cap-image-v7',
  },
  {
    id: 'mock-motion-v1',
    providerId: 'mock-provider-east',
    name: 'Motion V1',
    status: 'MAINTENANCE',
    capabilityVersion: 'cap-image-v6',
  },
  {
    id: 'mock-story-v3',
    providerId: 'mock-provider-west',
    name: 'Story V3',
    status: 'ACTIVE',
    capabilityVersion: 'cap-text-v4',
  },
];

const imageCapability: StudioCapabilityDocument = {
  schemaVersion: 202012,
  capabilityVersion: 'cap-image-v7',
  mode: 'IMAGE_TO_VIDEO',
  jsonSchema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    properties: {
      image: { type: 'string', format: 'asset-id', minLength: 1 },
      duration: { type: 'integer', default: 5, minimum: 3, maximum: 10 },
      motion: { type: 'string', enum: ['natural', 'custom'], default: 'natural' },
      customMotion: { type: 'string', minLength: 4, maxLength: 120 },
      enhancePrompt: { type: 'boolean', default: true },
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
    order: ['image', 'duration', 'motion', 'customMotion', 'enhancePrompt'],
    groups: [
      { key: 'source', title: '输入素材', fields: ['image'] },
      {
        key: 'generation',
        title: '生成参数',
        fields: ['duration', 'motion', 'customMotion', 'enhancePrompt'],
      },
    ],
    fields: {
      image: { label: '起始图片', widget: 'asset-id', help: '填写已上传素材的 Asset ID。' },
      duration: { label: '时长', unit: '秒', help: '当前能力支持 3 到 10 秒。' },
      motion: {
        label: '运动模式',
        options: [
          { value: 'natural', label: '自然运动' },
          { value: 'custom', label: '自定义运动' },
        ],
      },
      customMotion: {
        label: '自定义运动描述',
        widget: 'textarea',
        placeholder: '描述镜头和主体如何运动',
      },
      enhancePrompt: { label: '自动优化提示词' },
    },
    conditions: [{ field: 'customMotion', when: { field: 'motion', equals: 'custom' } }],
  },
  costDimensions: ['duration'],
};

const textCapability: StudioCapabilityDocument = {
  schemaVersion: 202012,
  capabilityVersion: 'cap-text-v4',
  mode: 'TEXT_TO_VIDEO',
  jsonSchema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    properties: {
      prompt: { type: 'string', minLength: 4, maxLength: 800 },
      duration: { type: 'integer', default: 5, minimum: 3, maximum: 10 },
      aspectRatio: { type: 'string', enum: ['16:9', '9:16', '1:1'], default: '16:9' },
      seed: { type: 'integer', minimum: 0, maximum: 2147483647 },
    },
    required: ['prompt', 'duration', 'aspectRatio'],
  },
  uiSchema: {
    order: ['prompt', 'duration', 'aspectRatio', 'seed'],
    groups: [
      { key: 'idea', title: '创作内容', fields: ['prompt'] },
      { key: 'output', title: '输出参数', fields: ['duration', 'aspectRatio', 'seed'] },
    ],
    fields: {
      prompt: {
        label: '画面描述',
        widget: 'textarea',
        help: '描述主体、环境、镜头和节奏。',
      },
      duration: { label: '时长', unit: '秒' },
      aspectRatio: {
        label: '画面比例',
        options: [
          { value: '16:9', label: '横屏 16:9' },
          { value: '9:16', label: '竖屏 9:16' },
          { value: '1:1', label: '方形 1:1' },
        ],
      },
      seed: { label: '随机种子', help: '可选；相同种子有助于复现实验。' },
    },
  },
  costDimensions: ['duration'],
};

function genericAssetCapability(mode: StudioGenerationMode): StudioCapabilityDocument {
  return {
    ...imageCapability,
    capabilityVersion: `cap-${mode.toLowerCase()}-v1`,
    mode,
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sourceAsset: { type: 'string', format: 'asset-id', minLength: 1 },
        prompt: { type: 'string', minLength: 4, maxLength: 800 },
        duration: { type: 'integer', default: 5, minimum: 3, maximum: 10 },
      },
      required: ['sourceAsset', 'prompt', 'duration'],
    },
    uiSchema: {
      order: ['sourceAsset', 'prompt', 'duration'],
      groups: [
        { key: 'source', title: '输入素材', fields: ['sourceAsset'] },
        { key: 'generation', title: '生成参数', fields: ['prompt', 'duration'] },
      ],
      fields: {
        sourceAsset: { label: '参考素材', widget: 'asset-id' },
        prompt: { label: '画面描述', widget: 'textarea' },
        duration: { label: '时长', unit: '秒' },
      },
    },
  };
}

function capabilityForMode(mode: StudioGenerationMode): StudioCapabilityDocument {
  if (mode === 'TEXT_TO_VIDEO') return textCapability;
  if (mode === 'IMAGE_TO_VIDEO') return imageCapability;
  return genericAssetCapability(mode);
}

function definitiveFailure(code: string): Error & { readonly outcome: 'DEFINITIVE_FAILURE' } {
  return Object.assign(new Error(code), { outcome: 'DEFINITIVE_FAILURE' as const });
}

function formatSummaryValue(
  document: StudioCapabilityDocument,
  field: string,
  rawValue: unknown,
): string {
  const option = document.uiSchema.fields?.[field]?.options?.find(
    (candidate) => candidate.value === (rawValue as JsonSchemaValue),
  );
  if (option) return option.label;
  if (typeof rawValue === 'boolean') return rawValue ? '开启' : '关闭';
  return String(rawValue);
}

function summarize(
  document: StudioCapabilityDocument,
  parameters: Readonly<Record<string, unknown>>,
): readonly StudioParameterSummaryItem[] {
  return document.uiSchema.order.flatMap((field) => {
    const value = parameters[field];
    if (value === undefined) return [];
    const meta = document.uiSchema.fields?.[field];
    const item = {
      key: field,
      label: meta?.label ?? document.jsonSchema.properties?.[field]?.title ?? field,
      value: formatSummaryValue(document, field, value),
    };
    return [meta?.unit ? { ...item, unit: meta.unit } : item];
  });
}

class FixtureStudioGateway implements StudioGateway {
  private readonly quotes = new Map<string, StudioQuote>();
  private readonly tasksByIdempotencyKey = new Map<string, StudioTaskAccepted>();

  async listProviders(): Promise<readonly StudioProviderOption[]> {
    return Promise.resolve(providers);
  }

  async listModels(): Promise<readonly StudioModelOption[]> {
    return Promise.resolve(models);
  }

  async getCapability(modelId: string): Promise<StudioCapabilityDocument> {
    const model = models.find((candidate) => candidate.id === modelId);
    if (!model || model.status !== 'ACTIVE') throw new Error('MODEL_UNAVAILABLE');
    return Promise.resolve(
      model.capabilityVersion === textCapability.capabilityVersion
        ? textCapability
        : imageCapability,
    );
  }

  async getSmartCapability(mode: StudioGenerationMode): Promise<StudioCapabilityDocument> {
    return Promise.resolve(capabilityForMode(mode));
  }

  async quote(request: StudioQuoteRequest): Promise<StudioQuote> {
    const document =
      request.routing.kind === 'EXACT_MODEL'
        ? await this.getCapability(request.routing.modelId)
        : await this.getSmartCapability(request.routing.preferences.generationMode);
    if (document.capabilityVersion !== request.capabilityVersion) {
      throw new Error('CAPABILITY_VERSION_MISMATCH');
    }
    if (!validateForm(document.jsonSchema, request.parameters).valid) {
      throw new Error('INVALID_PARAMETERS');
    }

    const exactModelId =
      request.routing.kind === 'EXACT_MODEL' ? request.routing.modelId : undefined;
    const exactModel = exactModelId ? models.find((model) => model.id === exactModelId) : undefined;
    const quote: StudioQuote = {
      id: crypto.randomUUID(),
      routing: exactModel
        ? { kind: 'EXACT_MODEL', modelId: exactModel.id, modelName: exactModel.name }
        : {
            kind: 'SMART_ROUTING',
            promise: '智能路由将在已报价点数内选择满足偏好的可用模型',
          },
      capabilityVersion: document.capabilityVersion,
      parameters: { ...request.parameters },
      parameterSummary: summarize(document, request.parameters),
      quotedPoints: String(180 + Number(request.parameters.duration ?? 5) * 12),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      failureRefundRule: '供应商生成失败，冻结点数全额退回。',
      cancellationRule: '供应商受理前可全额退回；受理后仅在供应商支持时可取消。',
    };
    this.quotes.set(quote.id, quote);
    return quote;
  }

  async createTask(
    request: StudioCreateTaskRequest,
    options: { readonly idempotencyKey: string },
  ): Promise<StudioTaskAccepted> {
    await Promise.resolve();
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(options.idempotencyKey)) {
      throw definitiveFailure('INVALID_IDEMPOTENCY_KEY');
    }
    const existing = this.tasksByIdempotencyKey.get(options.idempotencyKey);
    if (existing) return existing;

    const quote = this.quotes.get(request.quoteId);
    if (!quote || Date.parse(quote.expiresAt) <= Date.now()) {
      throw definitiveFailure('QUOTE_EXPIRED');
    }
    if (
      quote.capabilityVersion !== request.capabilityVersion ||
      quote.quotedPoints !== request.quotedPoints ||
      !stableDeepEqual(quote.parameters, request.parameters)
    ) {
      throw definitiveFailure('QUOTE_SNAPSHOT_MISMATCH');
    }

    const accepted: StudioTaskAccepted = { taskId: crypto.randomUUID(), status: 'QUEUED' };
    this.tasksByIdempotencyKey.set(options.idempotencyKey, accepted);
    return accepted;
  }
}

// Replace this fixture with an apiClient-backed Gateway adapter when WS09 endpoints are integrated.
// Components only depend on StudioGateway and never call catalog, routing, wallet, or generation services.
export const studioGateway: StudioGateway = new FixtureStudioGateway();
