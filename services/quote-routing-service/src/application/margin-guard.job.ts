export interface ActiveModelMarginRules {
  modelId: string;
  costPoints: bigint;
  salePoints: bigint[];
  minimumMarginBasisPoints: number;
  costRuleVersion: number;
}

export interface MarginRuleSource {
  listActiveModels(): Promise<ActiveModelMarginRules[]>;
}

export interface CatalogModelControl {
  disableModel(modelId: string, reason: 'MARGIN_BELOW_MINIMUM'): Promise<void>;
}

export interface MarginRiskEvent {
  eventType: 'routing.margin-risk-detected.v1';
  modelId: string;
  costRuleVersion: number;
  costPoints: string;
  salePoints: string[];
  minimumMarginBasisPoints: number;
  occurredAt: string;
}

export interface MarginRiskPublisher {
  publish(event: MarginRiskEvent): Promise<void>;
}

export interface InternalTokenProvider {
  getToken(): Promise<string>;
}

export type FetchPort = (
  input: string | URL | globalThis.Request,
  init?: RequestInit,
) => Promise<Response>;

function meetsMinimumMargin(cost: bigint, sale: bigint, minimumMarginBps: number): boolean {
  if (cost < 0n || sale < 0n || !Number.isInteger(minimumMarginBps) || minimumMarginBps < 0) {
    throw Object.assign(new Error('INVALID_MARGIN_RULE'), { code: 'INVALID_MARGIN_RULE' });
  }
  if (sale === 0n) return cost === 0n;
  return (sale - cost) * 10_000n >= sale * BigInt(minimumMarginBps);
}

export class AuthenticatedCatalogModelControl implements CatalogModelControl {
  constructor(
    private readonly baseUrl: string,
    private readonly tokens: InternalTokenProvider,
    private readonly fetchPort: FetchPort = fetch,
  ) {}

  async disableModel(modelId: string, reason: 'MARGIN_BELOW_MINIMUM'): Promise<void> {
    const token = await this.tokens.getToken();
    const response = await this.fetchPort(
      `${this.baseUrl.replace(/\/$/, '')}/internal/models/${encodeURIComponent(modelId)}/disable`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ reason }),
      },
    );
    if (!response.ok) {
      throw Object.assign(new Error('CATALOG_DISABLE_REQUEST_FAILED'), {
        code: 'CATALOG_DISABLE_REQUEST_FAILED',
        status: response.status,
      });
    }
  }
}

export class MarginGuardJob {
  constructor(
    private readonly rules: MarginRuleSource,
    private readonly catalog: CatalogModelControl,
    private readonly events: MarginRiskPublisher,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async run(): Promise<void> {
    const models = await this.rules.listActiveModels();
    for (const model of models) {
      const anyProfitable = model.salePoints.some((sale) =>
        meetsMinimumMargin(model.costPoints, sale, model.minimumMarginBasisPoints),
      );
      if (anyProfitable) continue;
      await this.catalog.disableModel(model.modelId, 'MARGIN_BELOW_MINIMUM');
      await this.events.publish({
        eventType: 'routing.margin-risk-detected.v1',
        modelId: model.modelId,
        costRuleVersion: model.costRuleVersion,
        costPoints: model.costPoints.toString(),
        salePoints: model.salePoints.map((value) => value.toString()),
        minimumMarginBasisPoints: model.minimumMarginBasisPoints,
        occurredAt: this.now().toISOString(),
      });
    }
  }
}
