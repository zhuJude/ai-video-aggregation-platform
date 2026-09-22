import 'server-only';

export type GenerationMode =
  'TEXT_TO_VIDEO' | 'IMAGE_TO_VIDEO' | 'FIRST_LAST_FRAME' | 'REFERENCE_VIDEO' | 'EXTEND_VIDEO';

export type ModelState = 'ACTIVE' | 'MAINTENANCE';
export type SpeedLabel = '较快' | '均衡' | '深度';

export interface ProviderSummary {
  id: string;
  displayName: string;
}

export interface PointRange {
  min: string;
  max: string;
  unit: '点数';
}

export interface BillingRule {
  title: string;
  description: string;
}

export interface PublicModel {
  id: string;
  displayName: string;
  provider: ProviderSummary;
  modes: readonly GenerationMode[];
  capabilities: readonly string[];
  pointRange: PointRange | null;
  speed: SpeedLabel | null;
  qualityLabel: string | null;
  state: ModelState;
  stateMessage: string | null;
  publishedDescription: string | null;
  billingRules: readonly BillingRule[];
}

export interface CreatorCase {
  id: string;
  title: string;
  category: string | null;
  summary: string;
  modelId: string | null;
}

export interface HomeResponse {
  popularModels: readonly PublicModel[];
  creatorCases: readonly CreatorCase[];
}

export interface ModelFilters {
  modelId?: string;
  mode?: GenerationMode;
  providerId?: string;
  capability?: string;
  price?: 'UNDER_150' | '150_TO_300' | 'OVER_300';
  speed?: SpeedLabel;
  state?: ModelState;
}

export interface ModelOption {
  id: string;
  displayName: string;
}

export interface ModelsResponse {
  items: readonly PublicModel[];
  total: number;
  filters: ModelFilters;
  modelOptions: readonly ModelOption[];
  providers: readonly ProviderSummary[];
  capabilities: readonly string[];
}

export interface PointConversion {
  currency: 'CNY';
  amountMinor: string;
  points: string;
}

export interface RechargePackage {
  id: string;
  title: string;
  amountMinor: string;
  points: string;
}

export interface PricingResponse {
  conversion: PointConversion | null;
  modelBillingRules: readonly BillingRule[];
  failureRefundRule: string | null;
  acceptedCancellationRule: string | null;
  rechargePackages: readonly RechargePackage[] | null;
}

export interface HelpNavigationItem {
  slug: readonly string[];
  title: string;
}

export interface PublishedHelpArticle {
  slug: readonly string[];
  title: string;
  summary: string;
  kind: 'GUIDE' | 'FAQ' | 'ANNOUNCEMENT' | 'LEGAL' | 'HELP';
  publishedAt: string;
  publishedHtml: string;
}

export interface HelpResponse {
  article: PublishedHelpArticle | null;
  navigation: readonly HelpNavigationItem[];
}

export interface GatewayError {
  code: string;
  message: string;
  retryable: boolean;
}

export type GatewayTransport = 'fixture' | 'http';

export interface GatewaySuccessMeta {
  transport: GatewayTransport;
  version: string;
}

export type GatewayResult<T> =
  { ok: true; data: T; meta: GatewaySuccessMeta } | { ok: false; error: GatewayError };

export interface PublicSiteGateway {
  getHome(): Promise<GatewayResult<HomeResponse>>;
  getHelp(slug: readonly string[]): Promise<GatewayResult<HelpResponse>>;
  getModel(id: string): Promise<GatewayResult<PublicModel | null>>;
  getModels(filters: ModelFilters): Promise<GatewayResult<ModelsResponse>>;
  getPricing(): Promise<GatewayResult<PricingResponse>>;
}

const providers = {
  kling: { id: 'kling', displayName: '可灵 AI' },
  seedance: { id: 'seedance', displayName: '字节 Seedance' },
  veo: { id: 'veo', displayName: 'Google Veo' },
} as const satisfies Record<string, ProviderSummary>;

const models: readonly PublicModel[] = [
  {
    id: 'kling-2-1-pro',
    displayName: 'Kling 2.1 Pro',
    provider: providers.kling,
    modes: ['TEXT_TO_VIDEO'],
    capabilities: ['中文提示词', '镜头控制', '1080p 输出'],
    pointRange: { min: '80', max: '140', unit: '点数' },
    speed: '较快',
    qualityLabel: '运动自然',
    state: 'ACTIVE',
    stateMessage: '当前可提交生成任务。',
    publishedDescription:
      '适合中文提示词与连续运动镜头，为商业短片和产品展示提供稳定的视觉连贯性。',
    billingRules: [
      {
        title: '按输出规格计费',
        description: '点数随时长与分辨率变化，提交前会显示本次报价。',
      },
      {
        title: '任务开始前预留',
        description: '接受报价后预留对应点数，任务结束后再结算。',
      },
    ],
  },
  {
    id: 'seedance-1-5-pro',
    displayName: 'Seedance 1.5 Pro',
    provider: providers.seedance,
    modes: ['IMAGE_TO_VIDEO'],
    capabilities: ['图像参考', '镜头控制', '风格保持'],
    pointRange: { min: '120', max: '240', unit: '点数' },
    speed: '均衡',
    qualityLabel: '细节优先',
    state: 'MAINTENANCE',
    stateMessage: '提供商正在维护，暂时无法提交新任务。',
    publishedDescription:
      '从单帧画面生成连贯运动，优先保留主体外观与画面风格，适合电商视觉和人物短片。',
    billingRules: [
      {
        title: '按输出规格计费',
        description: '不同时长、清晰度和运动幅度对应不同点数，以提交前报价为准。',
      },
      {
        title: '维护期不接受新任务',
        description: '模型恢复后才会开放提交，已预留点数的失败任务按平台规则退回。',
      },
    ],
  },
  {
    id: 'veo-3-1',
    displayName: 'Veo 3.1',
    provider: providers.veo,
    modes: ['FIRST_LAST_FRAME', 'REFERENCE_VIDEO'],
    capabilities: ['首尾帧', '参考视频', '长镜头构图'],
    pointRange: { min: '280', max: '420', unit: '点数' },
    speed: '深度',
    qualityLabel: '画面完成度高',
    state: 'ACTIVE',
    stateMessage: '当前可提交生成任务。',
    publishedDescription:
      '适合需要首尾画面约束或参考视频的高完成度片段，侧重构图、运动和镜头连贯性。',
    billingRules: [
      {
        title: '按输出规格计费',
        description: '参考素材、时长与输出规格会影响报价，提交前可确认点数。',
      },
    ],
  },
] as const;

const creatorCases: readonly CreatorCase[] = [
  {
    id: 'case-product-film',
    title: '让单张产品图开始运动',
    category: '电商短片',
    summary: '保留包装细节，用运镜和环境变化完成一段产品展示。',
    modelId: 'seedance-1-5-pro',
  },
  {
    id: 'case-storyboard',
    title: '从分镜文字到可评审样片',
    category: '品牌提案',
    summary: '先用文生视频验证节奏，再把方向带入正式制作。',
    modelId: 'kling-2-1-pro',
  },
] as const;

const helpArticles: readonly PublishedHelpArticle[] = [
  {
    slug: [],
    title: '帮助中心',
    summary: '了解模型选择、点数计费、任务状态与平台规则。',
    kind: 'GUIDE',
    publishedAt: '2026-08-20',
    publishedHtml:
      '<h2>常用入口</h2><p>在模型广场比较能力和点数，在开始创作前确认本次报价。</p><h2>需要帮助</h2><p>请先查看任务状态和错误提示，保留任务编号以便查询。</p>',
  },
  {
    slug: ['billing', 'refund'],
    title: '失败退款与取消规则',
    summary: '了解失败任务的点数退回和受理后取消规则。',
    kind: 'LEGAL',
    publishedAt: '2026-08-28',
    publishedHtml:
      '<h2>生成失败</h2><p onclick="steal()">任务确认失败后，系统会退回未结算的预留点数。</p><h2>受理后取消</h2><p>提供商已受理的任务，可能按已发生成本扣除点数，其余部分释放回钱包。</p><script>steal()</script>',
  },
  {
    slug: ['faq', 'model-state'],
    title: '模型为什么显示维护中',
    summary: '了解模型健康状态和恢复后的使用方式。',
    kind: 'FAQ',
    publishedAt: '2026-08-24',
    publishedHtml:
      '<h2>维护中的含义</h2><p>平台会在提供商维护或质量异常时暂停新任务，避免无效预留点数。</p>',
  },
  {
    slug: ['legal', 'terms'],
    title: '服务条款',
    summary: '了解使用光帧 AI 视频创作服务时的基本权利、责任与使用边界。',
    kind: 'LEGAL',
    publishedAt: '2026-08-28',
    publishedHtml:
      '<h2>服务内容</h2><p>平台提供模型选择、任务管理和点数结算工具。</p><h2>用户责任</h2><p>用户需确保上传素材和生成用途符合适用法律及平台规则。</p>',
  },
] as const;

const pricing: PricingResponse = {
  conversion: { currency: 'CNY', amountMinor: '100', points: '100' },
  modelBillingRules: [
    {
      title: '先报价，再提交',
      description: '时长、清晰度与模型会影响点数，创建任务前可确认本次报价。',
    },
    {
      title: '预留与结算分开',
      description: '任务提交时预留点数，完成后按已确认的计费规则结算。',
    },
  ],
  failureRefundRule: '生成失败并确认未产生可结算结果时，未结算的预留点数会退回钱包。',
  acceptedCancellationRule: '提供商受理后取消，可能按已发生成本扣除点数，其余预留点数会释放。',
  rechargePackages: [
    { id: 'points-3000', title: '轻量包', amountMinor: '3000', points: '3000' },
    { id: 'points-10000', title: '标准包', amountMinor: '10000', points: '10000' },
    { id: 'points-30000', title: '制作包', amountMinor: '30000', points: '30000' },
  ],
};

const fixtureMeta: GatewaySuccessMeta = { transport: 'fixture', version: 'ws15-v1' };

function success<T>(data: T, meta: GatewaySuccessMeta): GatewayResult<T> {
  return { ok: true, data, meta };
}

function fixtureSuccess<T>(data: T): GatewayResult<T> {
  return success(data, fixtureMeta);
}

function priceMatches(model: PublicModel, price: ModelFilters['price']): boolean {
  if (!price) return true;
  if (!model.pointRange) return false;
  const minimum = BigInt(model.pointRange.min);
  if (price === 'UNDER_150') return minimum < 150n;
  if (price === '150_TO_300') {
    return minimum >= 150n && minimum <= 300n;
  }
  return minimum > 300n;
}

class FixturePublicSiteGateway implements PublicSiteGateway {
  getHome(): Promise<GatewayResult<HomeResponse>> {
    return Promise.resolve(fixtureSuccess({ popularModels: models, creatorCases }));
  }

  getHelp(slug: readonly string[]): Promise<GatewayResult<HelpResponse>> {
    const key = slug.join('/');
    const article = helpArticles.find((item) => item.slug.join('/') === key) ?? null;
    return Promise.resolve(
      fixtureSuccess({
        article,
        navigation: helpArticles.map((item) => ({ slug: item.slug, title: item.title })),
      }),
    );
  }

  getModel(id: string): Promise<GatewayResult<PublicModel | null>> {
    return Promise.resolve(fixtureSuccess(models.find((model) => model.id === id) ?? null));
  }

  getModels(filters: ModelFilters): Promise<GatewayResult<ModelsResponse>> {
    const items = models.filter(
      (model) =>
        (!filters.modelId || model.id === filters.modelId) &&
        (!filters.mode || model.modes.includes(filters.mode)) &&
        (!filters.providerId || model.provider.id === filters.providerId) &&
        (!filters.capability || model.capabilities.includes(filters.capability)) &&
        priceMatches(model, filters.price) &&
        (!filters.speed || model.speed === filters.speed) &&
        (!filters.state || model.state === filters.state),
    );

    return Promise.resolve(
      fixtureSuccess({
        items,
        total: items.length,
        filters,
        modelOptions: models.map((model) => ({
          id: model.id,
          displayName: model.displayName,
        })),
        providers: Object.values(providers),
        capabilities: [...new Set(models.flatMap((model) => model.capabilities))],
      }),
    );
  }

  getPricing(): Promise<GatewayResult<PricingResponse>> {
    return Promise.resolve(fixtureSuccess(pricing));
  }
}

function invalidResponse(): never {
  throw new Error('INVALID_PUBLIC_GATEWAY_RESPONSE');
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalidResponse();
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) invalidResponse();
}

function text(value: unknown, maximum = 2_000): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) invalidResponse();
  return value;
}

function identifier(value: unknown): string {
  const parsed = text(value, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(parsed)) invalidResponse();
  return parsed;
}

function decimal(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,77})$/.test(value)) invalidResponse();
  return value;
}

function member<T extends string>(value: unknown, values: ReadonlySet<T>): T {
  if (typeof value !== 'string' || !values.has(value as T)) invalidResponse();
  return value as T;
}

const generationModes = new Set<GenerationMode>([
  'TEXT_TO_VIDEO',
  'IMAGE_TO_VIDEO',
  'FIRST_LAST_FRAME',
  'REFERENCE_VIDEO',
  'EXTEND_VIDEO',
]);
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalidResponse();
  return value;
}

function nullableIdentifier(value: unknown): string | null {
  return value === null ? null : identifier(value);
}

function nullableTimestamp(value: unknown): string | null {
  if (value === null) return null;
  const parsed = text(value, 64);
  if (Number.isNaN(Date.parse(parsed))) invalidResponse();
  return parsed;
}

function timestamp(value: unknown): string {
  const parsed = nullableTimestamp(value);
  if (!parsed) invalidResponse();
  return parsed;
}

function positiveDecimal(value: unknown): string {
  const parsed = decimal(value);
  if (parsed === '0') invalidResponse();
  return parsed;
}

function catalogModel(value: unknown): PublicModel {
  const source = object(value);
  exact(source, [
    'id',
    'providerId',
    'providerCode',
    'providerDisplayName',
    'code',
    'displayName',
    'modes',
    'status',
    'sortOrder',
    'capabilityVersionId',
  ]);
  if (!Array.isArray(source.modes) || source.modes.length < 1 || source.modes.length > 10)
    invalidResponse();
  if (source.status !== 'ACTIVE') invalidResponse();
  identifier(source.providerCode);
  identifier(source.code);
  integer(source.sortOrder);
  identifier(source.capabilityVersionId);
  return {
    id: identifier(source.id),
    displayName: text(source.displayName, 120),
    provider: {
      id: identifier(source.providerId),
      displayName: text(source.providerDisplayName, 80),
    },
    modes: source.modes.map((mode) => member(mode, generationModes)),
    capabilities: [],
    pointRange: null,
    speed: null,
    qualityLabel: null,
    state: 'ACTIVE',
    stateMessage: null,
    publishedDescription: null,
    billingRules: [],
  };
}

function catalogModels(value: unknown): readonly PublicModel[] {
  const source = object(value);
  exact(source, ['items']);
  if (!Array.isArray(source.items) || source.items.length > 1_000) invalidResponse();
  return source.items.map(catalogModel);
}

function modelsResponse(value: unknown, filters: ModelFilters): ModelsResponse {
  const allModels = catalogModels(value);
  const items = allModels.filter(
    (model) =>
      (!filters.modelId || model.id === filters.modelId) &&
      (!filters.mode || model.modes.includes(filters.mode)) &&
      (!filters.providerId || model.provider.id === filters.providerId) &&
      (!filters.capability || model.capabilities.includes(filters.capability)) &&
      priceMatches(model, filters.price) &&
      (!filters.speed || model.speed === filters.speed) &&
      (!filters.state || model.state === filters.state),
  );
  const uniqueProviders = new Map(allModels.map((model) => [model.provider.id, model.provider]));
  return {
    items,
    total: items.length,
    filters,
    modelOptions: allModels.map(({ id, displayName }) => ({ id, displayName })),
    providers: [...uniqueProviders.values()],
    capabilities: [],
  };
}

const contentKeys = [
  'id',
  'entryId',
  'version',
  'revision',
  'status',
  'basePublishedVersionId',
  'title',
  'summary',
  'bodyHtml',
  'sortOrder',
  'activeFrom',
  'activeUntil',
  'helpCategoryId',
  'createdBy',
  'createdAt',
  'publishedAt',
  'retiredAt',
] as const;

function contentVersion(value: unknown) {
  const source = object(value);
  exact(source, contentKeys);
  if (source.status !== 'PUBLISHED') invalidResponse();
  const publishedAt = timestamp(source.publishedAt);
  identifier(source.entryId);
  integer(source.version);
  integer(source.revision);
  nullableIdentifier(source.basePublishedVersionId);
  integer(source.sortOrder);
  nullableTimestamp(source.activeFrom);
  nullableTimestamp(source.activeUntil);
  nullableIdentifier(source.helpCategoryId);
  identifier(source.createdBy);
  timestamp(source.createdAt);
  nullableTimestamp(source.retiredAt);
  return {
    id: identifier(source.id),
    title: text(source.title, 160),
    summary: text(source.summary, 1_000),
    bodyHtml: text(source.bodyHtml, 100_000),
    publishedAt,
  };
}

function helpResponse(value: unknown, slug: readonly string[]): HelpResponse {
  if (!Array.isArray(value) || value.length > 1_000) invalidResponse();
  const content = value.map(contentVersion);
  const selected = slug.length === 0 ? content[0] : content.find(({ id }) => id === slug[0]);
  if (slug.length > 1) return { article: null, navigation: [] };
  return {
    article: selected
      ? {
          slug: [selected.id],
          title: selected.title,
          summary: selected.summary,
          kind: 'HELP',
          publishedAt: selected.publishedAt,
          publishedHtml: selected.bodyHtml,
        }
      : null,
    navigation: content.map(({ id, title }) => ({ slug: [id], title })),
  };
}

function bannerCases(value: unknown): readonly CreatorCase[] {
  if (!Array.isArray(value) || value.length > 100) invalidResponse();
  return value.map((item) => {
    const source = object(item);
    exact(source, ['placement', 'content']);
    const content = contentVersion(source.content);
    const placement = object(source.placement);
    exact(placement, [
      'id',
      'contentVersionId',
      'slot',
      'sortOrder',
      'activeFrom',
      'activeUntil',
      'createdBy',
      'createdAt',
    ]);
    identifier(placement.id);
    if (identifier(placement.contentVersionId) !== content.id || placement.slot !== 'HOME_HERO')
      invalidResponse();
    integer(placement.sortOrder);
    nullableTimestamp(placement.activeFrom);
    nullableTimestamp(placement.activeUntil);
    identifier(placement.createdBy);
    nullableTimestamp(placement.createdAt);
    return {
      id: content.id,
      title: content.title,
      summary: content.summary,
      category: null,
      modelId: null,
    };
  });
}

function rechargePackages(value: unknown): readonly RechargePackage[] {
  if (!Array.isArray(value) || value.length > 100) invalidResponse();
  return value.map((raw) => {
    const source = object(raw);
    exact(source, [
      'id',
      'packageId',
      'version',
      'revision',
      'status',
      'basePublishedVersionId',
      'name',
      'amountMinor',
      'currency',
      'points',
      'bonusPoints',
      'purchaseLimit',
      'validityDays',
      'sortOrder',
      'activeFrom',
      'activeUntil',
      'createdBy',
      'createdAt',
      'publishedAt',
      'retiredAt',
      'active',
    ]);
    if (source.status !== 'PUBLISHED' || source.currency !== 'CNY' || source.active !== true)
      invalidResponse();
    identifier(source.packageId);
    integer(source.version);
    integer(source.revision);
    nullableIdentifier(source.basePublishedVersionId);
    const points = positiveDecimal(source.points);
    const bonusPoints = decimal(source.bonusPoints);
    if (
      !(source.purchaseLimit === null || Number.isSafeInteger(source.purchaseLimit)) ||
      !(source.validityDays === null || Number.isSafeInteger(source.validityDays))
    )
      invalidResponse();
    integer(source.sortOrder);
    nullableTimestamp(source.activeFrom);
    nullableTimestamp(source.activeUntil);
    identifier(source.createdBy);
    timestamp(source.createdAt);
    timestamp(source.publishedAt);
    nullableTimestamp(source.retiredAt);
    return {
      id: identifier(source.id),
      title: text(source.name, 120),
      amountMinor: positiveDecimal(source.amountMinor),
      points: (BigInt(points) + BigInt(bonusPoints)).toString(),
    };
  });
}

function gatewayBaseUrl(): URL {
  const configured = process.env.GATEWAY_URL?.trim();
  if (!configured) throw new Error('PUBLIC_GATEWAY_UNAVAILABLE');
  const parsed = new URL(configured);
  if (
    parsed.protocol !== 'https:' &&
    parsed.hostname !== 'localhost' &&
    parsed.hostname !== '127.0.0.1'
  )
    throw new Error('PUBLIC_GATEWAY_UNAVAILABLE');
  return parsed;
}

class HttpPublicSiteGateway implements PublicSiteGateway {
  private async get<T>(path: string, parse: (value: unknown) => T): Promise<GatewayResult<T>> {
    try {
      const response = await fetch(new URL(path, gatewayBaseUrl()), {
        cache: 'no-store',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return {
          ok: false,
          error: {
            code: 'PUBLIC_GATEWAY_UNAVAILABLE',
            message: '公开内容服务暂时不可用。',
            retryable: response.status >= 500,
          },
        };
      }
      if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json'))
        invalidResponse();
      return success(parse((await response.json()) as unknown), {
        transport: 'http',
        version: 'v1',
      });
    } catch (error) {
      const invalid = error instanceof Error && error.message === 'INVALID_PUBLIC_GATEWAY_RESPONSE';
      return {
        ok: false,
        error: {
          code: invalid ? 'INVALID_PUBLIC_GATEWAY_RESPONSE' : 'PUBLIC_GATEWAY_UNAVAILABLE',
          message: invalid ? '公开内容响应未通过校验。' : '公开内容服务暂时不可用。',
          retryable: !invalid,
        },
      };
    }
  }

  async getHome(): Promise<GatewayResult<HomeResponse>> {
    const [catalog, banners] = await Promise.all([
      this.get('/v1/models', catalogModels),
      this.get('/v1/banners/HOME_HERO', bannerCases),
    ]);
    if (!catalog.ok) return catalog;
    if (!banners.ok) return banners;
    return success(
      { popularModels: catalog.data, creatorCases: banners.data },
      { transport: 'http', version: 'v1' },
    );
  }

  getHelp(slug: readonly string[]): Promise<GatewayResult<HelpResponse>> {
    return this.get('/v1/help', (value) => helpResponse(value, slug));
  }

  getModel(id: string): Promise<GatewayResult<PublicModel | null>> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id))
      return Promise.resolve({
        ok: false,
        error: { code: 'INVALID_PUBLIC_REQUEST', message: '模型编号无效。', retryable: false },
      });
    return this.get(
      '/v1/models',
      (value) => catalogModels(value).find((model) => model.id === id) ?? null,
    );
  }

  getModels(filters: ModelFilters): Promise<GatewayResult<ModelsResponse>> {
    return this.get('/v1/models', (value) => modelsResponse(value, filters));
  }

  getPricing(): Promise<GatewayResult<PricingResponse>> {
    return this.get('/v1/recharge-packages', (value) => ({
      conversion: null,
      modelBillingRules: [],
      failureRefundRule: null,
      acceptedCancellationRule: null,
      rechargePackages: rechargePackages(value),
    }));
  }
}

const fixtureGateway = new FixturePublicSiteGateway();
const httpGateway = new HttpPublicSiteGateway();

function selectedPublicGateway(): PublicSiteGateway {
  return process.env.USER_WEB_PUBLIC_MODE === 'mock' ? fixtureGateway : httpGateway;
}

export const publicSiteGateway: PublicSiteGateway = {
  getHome: () => selectedPublicGateway().getHome(),
  getHelp: (slug) => selectedPublicGateway().getHelp(slug),
  getModel: (id) => selectedPublicGateway().getModel(id),
  getModels: (filters) => selectedPublicGateway().getModels(filters),
  getPricing: () => selectedPublicGateway().getPricing(),
};

export const generationModeLabels: Readonly<Record<GenerationMode, string>> = {
  TEXT_TO_VIDEO: '文生视频',
  IMAGE_TO_VIDEO: '图生视频',
  FIRST_LAST_FRAME: '首尾帧',
  REFERENCE_VIDEO: '参考视频',
  EXTEND_VIDEO: '视频延长',
};

export const modelStateLabels: Readonly<Record<ModelState, string>> = {
  ACTIVE: '可用',
  MAINTENANCE: '维护中',
};
