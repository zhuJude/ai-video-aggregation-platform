export type GenerationMode =
  'TEXT_TO_VIDEO' | 'IMAGE_TO_VIDEO' | 'FIRST_LAST_FRAME' | 'REFERENCE_VIDEO' | 'EXTEND_VIDEO';

export type ModelState = 'ACTIVE' | 'MAINTENANCE';
export type SpeedLabel = '较快' | '均衡' | '深度';

export interface ProviderSummary {
  id: string;
  displayName: string;
}

export interface PointRange {
  min: number;
  max: number;
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
  pointRange: PointRange;
  speed: SpeedLabel;
  qualityLabel: string;
  state: ModelState;
  stateMessage: string;
  publishedDescription: string;
  billingRules: readonly BillingRule[];
}

export interface CreatorCase {
  id: string;
  title: string;
  category: string;
  summary: string;
  modelId: string;
}

export interface HomeResponse {
  popularModels: readonly PublicModel[];
  creatorCases: readonly CreatorCase[];
}

export interface ModelFilters {
  mode?: GenerationMode;
  providerId?: string;
  capability?: string;
  price?: 'UNDER_150' | '150_TO_300' | 'OVER_300';
  speed?: SpeedLabel;
  state?: ModelState;
}

export interface ModelsResponse {
  items: readonly PublicModel[];
  total: number;
  filters: ModelFilters;
  providers: readonly ProviderSummary[];
  capabilities: readonly string[];
}

export interface PointConversion {
  currency: 'CNY';
  amountMinor: number;
  points: number;
}

export interface RechargePackage {
  id: string;
  title: string;
  amountMinor: number;
  points: number;
}

export interface PricingResponse {
  conversion: PointConversion;
  modelBillingRules: readonly BillingRule[];
  failureRefundRule: string;
  acceptedCancellationRule: string;
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
  kind: 'GUIDE' | 'FAQ' | 'ANNOUNCEMENT' | 'LEGAL';
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

export type GatewayResult<T> =
  | { ok: true; data: T; meta: { transport: 'fixture'; version: string } }
  | { ok: false; error: GatewayError };

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
    pointRange: { min: 80, max: 140, unit: '点数' },
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
    pointRange: { min: 120, max: 240, unit: '点数' },
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
    pointRange: { min: 280, max: 420, unit: '点数' },
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
  conversion: { currency: 'CNY', amountMinor: 100, points: 100 },
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
    { id: 'points-3000', title: '轻量包', amountMinor: 3000, points: 3000 },
    { id: 'points-10000', title: '标准包', amountMinor: 10000, points: 10000 },
    { id: 'points-30000', title: '制作包', amountMinor: 30000, points: 30000 },
  ],
};

function success<T>(data: T): GatewayResult<T> {
  return { ok: true, data, meta: { transport: 'fixture', version: 'ws15-v1' } };
}

function priceMatches(model: PublicModel, price: ModelFilters['price']): boolean {
  if (!price) return true;
  if (price === 'UNDER_150') return model.pointRange.min < 150;
  if (price === '150_TO_300') return model.pointRange.min <= 300 && model.pointRange.max >= 150;
  return model.pointRange.max > 300;
}

class FixturePublicSiteGateway implements PublicSiteGateway {
  getHome(): Promise<GatewayResult<HomeResponse>> {
    return Promise.resolve(success({ popularModels: models, creatorCases }));
  }

  getHelp(slug: readonly string[]): Promise<GatewayResult<HelpResponse>> {
    const key = slug.join('/');
    const article = helpArticles.find((item) => item.slug.join('/') === key) ?? null;
    return Promise.resolve(
      success({
        article,
        navigation: helpArticles.map((item) => ({ slug: item.slug, title: item.title })),
      }),
    );
  }

  getModel(id: string): Promise<GatewayResult<PublicModel | null>> {
    return Promise.resolve(success(models.find((model) => model.id === id) ?? null));
  }

  getModels(filters: ModelFilters): Promise<GatewayResult<ModelsResponse>> {
    const items = models.filter(
      (model) =>
        (!filters.mode || model.modes.includes(filters.mode)) &&
        (!filters.providerId || model.provider.id === filters.providerId) &&
        (!filters.capability || model.capabilities.includes(filters.capability)) &&
        priceMatches(model, filters.price) &&
        (!filters.speed || model.speed === filters.speed) &&
        (!filters.state || model.state === filters.state),
    );

    return Promise.resolve(
      success({
        items,
        total: items.length,
        filters,
        providers: Object.values(providers),
        capabilities: [...new Set(models.flatMap((model) => model.capabilities))],
      }),
    );
  }

  getPricing(): Promise<GatewayResult<PricingResponse>> {
    return Promise.resolve(success(pricing));
  }
}

// Swap this transport at the composition boundary when the WS09 HTTP Gateway becomes available.
export const publicSiteGateway: PublicSiteGateway = new FixturePublicSiteGateway();

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
