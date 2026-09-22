import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PricingEditor } from '../components/operations/pricing-editor';
import { RoutingSimulator } from '../components/operations/routing-simulator';
import { TaskActions, TaskOperationsPanel } from '../components/operations/task-operations';
import {
  formatPoints,
  redactRawPayload,
  type RoutingSimulation,
  type TaskDetail,
} from '../lib/operations-control';
import {
  createQueueAction,
  createPricingPreviewAction,
  createPricingRollbackAction,
  createPricingSaveAction,
  createRoutingPreviewAction,
  createRoutingRollbackAction,
  createRoutingSaveAction,
  createTaskAction,
  loadTaskDetailView,
  loadTaskRawView,
  parseRoutingPolicyView,
  simulateRouting,
} from '../lib/operations-server';
import { createHttpOperationsPorts } from '../lib/http-operations-port';
import { createOutboundRequestContext } from '../lib/outbound-request-context';
import { signAdminSession } from '../lib/session-auth';

const taskId = '0198f7a4-c7d1-7b39-8a4e-73af0c1d2e3f';
const intentId = '0198f7a4-c7d2-7b39-8a4e-73af0c1d2e3f';
const routingVersionId = '0198f7a4-c7d6-7b39-8a4e-73af0c1d2e3f';
const pricingVersionId = '0198f7a4-c7d4-7b39-8a4e-73af0c1d2e3f';
const rollbackTargetVersionId = '0198f7a4-c7d7-7b39-8a4e-73af0c1d2e3f';
const receiptVersionId = '0198f7a4-c7d8-7b39-8a4e-73af0c1d2e3f';
const auditRecordId = '0198f7a4-c7d9-7b39-8a4e-73af0c1d2e3f';
const requestId = '0198f7a4-c7da-7b39-8a4e-73af0c1d2e3f';

const routingView = {
  backupCapabilityMapJson: '{"video-fast":["provider-b"]}',
  effectiveAt: '2026-09-11T00:00:00.000Z',
  failoverMode: 'SMART_ONLY',
  minimumMarginBps: 2000,
  priceWeight: 20,
  providerPriorityJson: '["provider-a","provider-b"]',
  publishPreflight: null,
  qualityWeight: 50,
  sourceUpdatedAt: '2026-09-10T00:00:00.000Z',
  speedWeight: 30,
  status: 'DRAFT',
  version: 7,
  versionId: routingVersionId,
  versions: [],
} as const;

const taskDirectory = {
  items: [],
  nextCursor: null,
  partialFields: [],
  queue: {
    backlog: 12,
    concurrencyLimit: 24,
    defaultPriority: 8,
    operationPreviews: [
      {
        action: 'PAUSE',
        expiresAt: '2099-09-11T00:05:00.000Z',
        impact: '暂停新任务出队',
        preflightToken: 'queue-pause-token',
        version: 12,
      },
      {
        action: 'UPDATE_LIMITS',
        expiresAt: '2099-09-11T00:05:00.000Z',
        impact: '更新全局队列容量',
        preflightToken: 'queue-limits-token',
        version: 12,
      },
    ],
    paused: false,
    rateLimitPerMinute: 600,
    running: 8,
    version: 12,
  },
  sourceUpdatedAt: '2099-09-10T00:00:00.000Z',
} as const;

const task: TaskDetail = {
  allowedOperations: ['RETRY_PROVIDER', 'CANCEL'],
  assignedAdminIds: [],
  attempt: {
    acceptance: 'AMBIGUOUS',
    circuitState: 'HALF_OPEN',
    externalTaskIdMasked: 'ext_****1234',
    number: 2,
    providerName: 'Mock Provider',
  },
  duplicatePurchaseRisk: true,
  financial: { chargedPoints: '1200', costPoints: '800', frozenPoints: '0', refundedPoints: '0' },
  id: taskId,
  ownerAdminId: '0198f7a4-c7d3-7b39-8a4e-73af0c1d2e3f',
  operationPreviews: [
    {
      impact: '可能产生新的供应商采购',
      operation: 'RETRY_PROVIDER',
      preflightToken: 'task-pf-retry-safe',
      purchaseSafety: 'NOT_ACCEPTED',
    },
    {
      impact: '释放冻结点数',
      operation: 'CANCEL',
      preflightToken: 'task-pf-cancel-safe',
      purchaseSafety: 'NOT_APPLICABLE',
    },
  ],
  parameterSnapshot: { duration: 5, prompt: '海边日落' },
  publicError: null,
  queue: { enqueuedAt: '2026-08-28T00:00:00.000Z', priority: 5, shard: 'video-cn-1' },
  rawExchange: {
    request: { authorization: '[REDACTED]', prompt: '海边日落' },
    response: { requestId: 'safe-request-id', token: '[REDACTED]' },
  },
  sourceUpdatedAt: '2026-08-28T00:00:00.000Z',
  status: 'PROVIDER_PENDING',
  timeline: [
    { at: '2026-08-28T00:00:00.000Z', code: 'CREATED', label: '任务已创建' },
    { at: '2026-08-28T00:00:01.000Z', code: 'PROVIDER_PENDING', label: '供应商状态未知' },
  ],
  userIdMasked: 'usr_****d2e3f',
  version: 4,
};

describe('pricing and routing operations', () => {
  it('formats arbitrarily large point values without Number precision loss', () => {
    expect(formatPoints('900719925474099312345')).toBe('900,719,925,474,099,312,345');
  });

  it('blocks a sale rule below minimum margin and requires authoritative preview', () => {
    const onPreview = vi.fn();
    render(
      <PricingEditor
        costPoints="1000"
        minimumMarginBps={2000}
        onPreview={onPreview}
        permissions={['pricing:write', 'pricing:publish']}
        salePoints="1100"
        status="DRAFT"
        version={3}
        versionId="0198f7a4-c7d4-7b39-8a4e-73af0c1d2e3f"
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('低于最低毛利率');
    expect(screen.getByRole('button', { name: '发布定价' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('销售点数'), { target: { value: '1500' } });
    fireEvent.click(screen.getByRole('button', { name: '权威影响预览' }));
    expect(onPreview).toHaveBeenCalledTimes(1);
  });

  it('lets an independent publisher preview the current read-only pricing draft', () => {
    const onPreview = vi.fn();
    render(
      <PricingEditor
        costPoints="1000"
        minimumMarginBps={1000}
        onPreview={onPreview}
        permissions={['pricing:publish']}
        salePoints="1500"
        status="DRAFT"
        version={3}
        versionId="0198f7a4-c7d4-7b39-8a4e-73af0c1d2e3f"
      />,
    );
    expect(screen.getByLabelText('销售点数')).toBeDisabled();
    expect(screen.getByRole('button', { name: '权威影响预览' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '权威影响预览' }));
    expect(onPreview).toHaveBeenCalledTimes(1);
  });

  it('accepts pricing and routing preflight for read-plus-publish roles', async () => {
    const signingKey = 'test-signing-key-that-is-long-enough-for-hmac';
    const sessionBase = {
      dataScope: 'ALL' as const,
      expiresAt: Date.now() + 60_000,
      sessionInstanceId: intentId,
      subjectId: taskId,
    };
    const pricingSessionToken = await signAdminSession(
      { ...sessionBase, permissions: ['pricing:read', 'pricing:publish'] },
      signingKey,
    );
    const pricingForm = new FormData();
    pricingForm.set('effectiveAt', '2099-12-31T00:00:00.000Z');
    pricingForm.set('expectedVersion', '3');
    pricingForm.set('markupBps', '99999');
    pricingForm.set('ruleId', 'current');
    pricingForm.set('salePoints', '999999');
    pricingForm.set('strategy', 'TIERED');
    pricingForm.set('tiersJson', '[{"minimum":1,"salePoints":"1"}]');
    pricingForm.set('versionId', '0198f7a4-c7d4-7b39-8a4e-73af0c1d2e3f');
    const pricingPreview = vi.fn(() =>
      Promise.resolve({
        expiresAt: '2099-09-11T00:05:00.000Z',
        previewToken: 'pricing-preview-token',
        version: 3,
        versionId: '0198f7a4-c7d4-7b39-8a4e-73af0c1d2e3f',
      }),
    );
    await expect(
      createPricingPreviewAction({
        context: { sessionToken: pricingSessionToken, signingKey },
        port: {
          getPricing: () =>
            Promise.resolve({
              costPoints: '1000',
              effectiveAt: '2099-09-11T00:00:00.000Z',
              minimumMarginBps: 1000,
              rules: [
                {
                  costPoints: '1000',
                  durationSeconds: 5,
                  id: 'current',
                  markupBps: 0,
                  modelCode: 'video-fast',
                  parameterKey: 'default',
                  resolution: '1080p',
                  salePoints: '1500',
                  strategy: 'FIXED',
                  tiersJson: '[]',
                },
              ],
              salePoints: '1500',
              sourceUpdatedAt: '2099-09-10T00:00:00.000Z',
              status: 'DRAFT',
              version: 3,
              versionId: '0198f7a4-c7d4-7b39-8a4e-73af0c1d2e3f',
              versions: [],
            }),
          preview: pricingPreview,
          publish: vi.fn(),
          rollback: vi.fn(),
          save: vi.fn(),
        },
      })(pricingForm),
    ).resolves.toMatchObject({ previewToken: 'pricing-preview-token' });
    expect(pricingPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        effectiveAt: '2099-09-11T00:00:00.000Z',
        markupBps: 0,
        salePoints: '1500',
        strategy: 'FIXED',
        tiers: [],
      }),
    );

    const routingSessionToken = await signAdminSession(
      { ...sessionBase, permissions: ['routing:read', 'routing:publish'] },
      signingKey,
    );
    const routingForm = new FormData();
    routingForm.set('expectedVersion', '7');
    routingForm.set('versionId', routingVersionId);
    await expect(
      createRoutingPreviewAction({
        context: { sessionToken: routingSessionToken, signingKey },
        port: {
          getRouting: vi.fn(),
          preview: () =>
            Promise.resolve({
              diff: '权重变化',
              expiresAt: '2099-09-11T00:05:00.000Z',
              impact: '影响新任务',
              previewToken: 'routing-preview-token',
              version: 7,
              versionId: routingVersionId,
            }),
          publish: vi.fn(),
          rollback: vi.fn(),
          save: vi.fn(),
          simulate: vi.fn(),
        },
      })(routingForm),
    ).resolves.toMatchObject({ previewToken: 'routing-preview-token' });
  });

  it('rejects numeric point values inside tiered pricing JSON', async () => {
    const signingKey = 'test-signing-key-that-is-long-enough-for-hmac';
    const sessionToken = await signAdminSession(
      {
        dataScope: 'ALL',
        expiresAt: Date.now() + 60_000,
        permissions: ['pricing:write'],
        sessionInstanceId: intentId,
        subjectId: taskId,
      },
      signingKey,
    );
    const save = vi.fn();
    const form = new FormData();
    form.set('effectiveAt', '2099-09-11T00:00:00.000Z');
    form.set('expectedVersion', '3');
    form.set('intentId', intentId);
    form.set('markupBps', '0');
    form.set('reason', '新增阶梯价格');
    form.set('ruleId', 'current');
    form.set('salePoints', '1500');
    form.set('strategy', 'TIERED');
    form.set('tiersJson', '[{"minimumUnits":1,"salePoints":9007199254740993}]');
    form.set('versionId', '0198f7a4-c7d4-7b39-8a4e-73af0c1d2e3f');
    await expect(
      createPricingSaveAction({
        context: { sessionToken, signingKey },
        port: {
          getPricing: vi.fn(),
          preview: vi.fn(),
          publish: vi.fn(),
          rollback: vi.fn(),
          save,
        },
      })(form),
    ).rejects.toThrow('定价阶梯规则无效');
    expect(save).not.toHaveBeenCalled();
  });

  it.each([
    ['pricing', 'pricing:write'],
    ['routing', 'routing:write'],
  ] as const)(
    'rejects %s singleton mutations from a non-ALL data scope',
    async (kind, permission) => {
      const signingKey = 'test-signing-key-that-is-long-enough-for-hmac';
      const sessionToken = await signAdminSession(
        {
          dataScope: 'OWN',
          expiresAt: Date.now() + 60_000,
          permissions: [permission],
          sessionInstanceId: intentId,
          subjectId: taskId,
        },
        signingKey,
      );
      const mutation = vi.fn(() => Promise.resolve({ ok: true }));
      if (kind === 'pricing') {
        const form = new FormData();
        form.set('effectiveAt', '2099-09-11T00:00:00.000Z');
        form.set('expectedVersion', '7');
        form.set('intentId', intentId);
        form.set('markupBps', '5000');
        form.set('reason', '更新全局定价');
        form.set('ruleId', 'video-fast-5s');
        form.set('salePoints', '1500');
        form.set('strategy', 'FIXED');
        form.set('tiersJson', '[]');
        form.set('versionId', pricingVersionId);
        await expect(
          createPricingSaveAction({
            context: { sessionToken, signingKey },
            port: {
              getPricing: vi.fn(),
              preview: vi.fn(),
              publish: vi.fn(),
              rollback: vi.fn(),
              save: mutation,
            },
          })(form),
        ).rejects.toThrow('ALL');
      } else {
        const form = new FormData();
        form.set('backupCapabilityMapJson', '{"video-fast":["provider-b"]}');
        form.set('effectiveAt', '2099-09-11T00:00:00.000Z');
        form.set('expectedVersion', '7');
        form.set('failoverMode', 'SMART_ONLY');
        form.set('intentId', intentId);
        form.set('minimumMarginBps', '2000');
        form.set('priceWeight', '20');
        form.set('providerPriorityJson', '["provider-a","provider-b"]');
        form.set('qualityWeight', '50');
        form.set('reason', '更新全局路由');
        form.set('speedWeight', '30');
        form.set('versionId', routingVersionId);
        await expect(
          createRoutingSaveAction({
            context: { sessionToken, signingKey },
            port: {
              getRouting: vi.fn(),
              preview: vi.fn(),
              publish: vi.fn(),
              rollback: vi.fn(),
              save: mutation,
              simulate: vi.fn(),
            },
          })(form),
        ).rejects.toThrow('ALL');
      }
      expect(mutation).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['pricing', pricingVersionId],
    ['routing', routingVersionId],
  ] as const)('binds %s rollback to a fresh authoritative preview', async (kind, versionId) => {
    const signingKey = 'test-signing-key-that-is-long-enough-for-hmac';
    const permission = kind === 'pricing' ? 'pricing:rollback' : 'routing:rollback';
    const sessionToken = await signAdminSession(
      {
        dataScope: 'ALL',
        expiresAt: Date.now() + 60_000,
        permissions: [permission],
        sessionInstanceId: intentId,
        subjectId: taskId,
      },
      signingKey,
    );
    const previewRollback = vi.fn(() =>
      Promise.resolve({
        diff: '恢复上一已发布版本',
        expiresAt: '2099-09-11T00:05:00.000Z',
        impact: '影响后续新任务',
        previewToken: 'rollback-preview-token',
        sourceVersionId: versionId,
        targetVersionId: rollbackTargetVersionId,
        version: 7,
      }),
    );
    const rollback = vi.fn(() =>
      Promise.resolve({
        auditRecordId,
        idempotencyKey: intentId,
        operation: kind === 'pricing' ? 'PRICING_ROLLBACK' : 'ROUTING_ROLLBACK',
        requestId,
        sourceVersionId: versionId,
        status: 'PUBLISHED',
        targetVersionId: rollbackTargetVersionId,
        version: 8,
        versionId: receiptVersionId,
      }),
    );
    const form = new FormData();
    form.set('confirmed', 'true');
    form.set('expectedVersion', '7');
    form.set('intentId', intentId);
    form.set('reason', '恢复稳定版本');
    form.set('targetVersionId', rollbackTargetVersionId);
    form.set('versionId', versionId);
    if (kind === 'pricing') {
      await createPricingRollbackAction({
        context: { sessionToken, signingKey },
        port: {
          getPricing: () =>
            Promise.resolve({
              costPoints: '1000',
              effectiveAt: '2099-09-11T00:00:00.000Z',
              minimumMarginBps: 1000,
              rules: [],
              salePoints: '1500',
              sourceUpdatedAt: '2099-09-10T00:00:00.000Z',
              status: 'PUBLISHED',
              version: 7,
              versionId,
              versions: [
                {
                  effectiveAt: '2099-09-01T00:00:00.000Z',
                  status: 'PUBLISHED',
                  version: 6,
                  versionId: rollbackTargetVersionId,
                },
              ],
            }),
          preview: vi.fn(),
          previewRollback,
          publish: vi.fn(),
          rollback,
          save: vi.fn(),
        } as never,
      })(form);
    } else {
      await createRoutingRollbackAction({
        context: { sessionToken, signingKey },
        port: {
          getRouting: () =>
            Promise.resolve({
              ...routingView,
              status: 'PUBLISHED',
              versions: [
                {
                  effectiveAt: '2099-09-01T00:00:00.000Z',
                  status: 'PUBLISHED',
                  version: 6,
                  versionId: rollbackTargetVersionId,
                },
              ],
            }),
          preview: vi.fn(),
          previewRollback,
          publish: vi.fn(),
          rollback,
          save: vi.fn(),
          simulate: vi.fn(),
        } as never,
      })(form);
    }
    expect(previewRollback).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedVersion: 7,
        sourceVersionId: versionId,
        targetVersionId: rollbackTargetVersionId,
      }),
    );
    expect(rollback).toHaveBeenCalledWith(
      expect.objectContaining({
        preflightToken: 'rollback-preview-token',
        targetVersionId: rollbackTargetVersionId,
      }),
    );
  });

  it('rejects an unbound success-shaped receipt for pricing and routing mutations', async () => {
    const signingKey = 'test-signing-key-that-is-long-enough-for-hmac';
    const sessionBase = {
      dataScope: 'ALL' as const,
      expiresAt: Date.now() + 60_000,
      sessionInstanceId: intentId,
      subjectId: taskId,
    };
    const pricingToken = await signAdminSession(
      { ...sessionBase, permissions: ['pricing:write'] },
      signingKey,
    );
    const pricingForm = new FormData();
    pricingForm.set('effectiveAt', '2099-09-11T00:00:00.000Z');
    pricingForm.set('expectedVersion', '7');
    pricingForm.set('intentId', intentId);
    pricingForm.set('markupBps', '5000');
    pricingForm.set('reason', '更新全局定价');
    pricingForm.set('ruleId', 'video-fast-5s');
    pricingForm.set('salePoints', '1500');
    pricingForm.set('strategy', 'FIXED');
    pricingForm.set('tiersJson', '[]');
    pricingForm.set('versionId', pricingVersionId);
    await expect(
      createPricingSaveAction({
        context: { sessionToken: pricingToken, signingKey },
        port: {
          getPricing: vi.fn(),
          preview: vi.fn(),
          publish: vi.fn(),
          rollback: vi.fn(),
          save: () => Promise.resolve({ ok: true }),
        },
      })(pricingForm),
    ).rejects.toThrow('回执无效');

    const routingToken = await signAdminSession(
      { ...sessionBase, permissions: ['routing:write'] },
      signingKey,
    );
    const routingForm = new FormData();
    routingForm.set('backupCapabilityMapJson', '{"video-fast":["provider-b"]}');
    routingForm.set('effectiveAt', '2099-09-11T00:00:00.000Z');
    routingForm.set('expectedVersion', '7');
    routingForm.set('failoverMode', 'SMART_ONLY');
    routingForm.set('intentId', intentId);
    routingForm.set('minimumMarginBps', '2000');
    routingForm.set('priceWeight', '20');
    routingForm.set('providerPriorityJson', '["provider-a","provider-b"]');
    routingForm.set('qualityWeight', '50');
    routingForm.set('reason', '更新全局路由');
    routingForm.set('speedWeight', '30');
    routingForm.set('versionId', routingVersionId);
    await expect(
      createRoutingSaveAction({
        context: { sessionToken: routingToken, signingKey },
        port: {
          getRouting: vi.fn(),
          preview: vi.fn(),
          publish: vi.fn(),
          rollback: vi.fn(),
          save: () => Promise.resolve({ ok: true }),
          simulate: vi.fn(),
        },
      })(routingForm),
    ).rejects.toThrow('回执无效');
  });

  it('shows authoritative route candidates, exclusions, scores and margin risk', async () => {
    const result: RoutingSimulation = {
      candidates: [
        {
          costPoints: '800',
          marginBps: 4666,
          modelCode: 'video-fast',
          providerName: 'Provider A',
          salePoints: '1500',
          score: 92,
          scoreExplanation: ['质量 +45', '速度 +30', '价格 +17'],
          selected: true,
        },
      ],
      exclusions: [{ modelCode: 'video-cheap', reason: '供应商熔断' }],
      requestId: '0198f7a4-c7d5-7b39-8a4e-73af0c1d2e3f',
      sourceUpdatedAt: '2026-08-28T00:00:00.000Z',
    };
    const onSimulate = vi.fn(() => Promise.resolve(result));
    render(
      <RoutingSimulator
        expectedVersion={7}
        onSimulate={onSimulate}
        permissions={['routing:simulate']}
        versionId="0198f7a4-c7d6-7b39-8a4e-73af0c1d2e3f"
      />,
    );
    fireEvent.change(screen.getByLabelText('模拟参数 JSON'), {
      target: { value: '{"duration":5}' },
    });
    fireEvent.click(screen.getByRole('button', { name: '运行权威路由模拟' }));
    expect(await screen.findByText('Provider A')).toBeVisible();
    expect(screen.getByText('供应商熔断')).toBeVisible();
    expect(screen.getByText(/质量 \+45/)).toBeVisible();
    expect(screen.getByText('46.66%')).toBeVisible();
    expect(onSimulate).toHaveBeenCalledWith({
      duration: 5,
      expectedVersion: 7,
      routingVersionId: '0198f7a4-c7d6-7b39-8a4e-73af0c1d2e3f',
    });
  });

  it('rejects malformed routing mapping semantics and invalid preflight time', () => {
    expect(() => parseRoutingPolicyView({ ...routingView, providerPriorityJson: 'null' })).toThrow(
      '路由策略响应无效',
    );
    expect(() =>
      parseRoutingPolicyView({ ...routingView, backupCapabilityMapJson: '{"video-fast":null}' }),
    ).toThrow('路由策略响应无效');
    expect(() =>
      parseRoutingPolicyView({
        ...routingView,
        publishPreflight: {
          diff: '权重变化',
          expiresAt: 'not-a-date',
          impact: '影响新任务',
          previewToken: 'routing-preview-token',
          version: 7,
          versionId: routingVersionId,
        },
      }),
    ).toThrow('路由策略响应无效');
  });

  it('server-binds route simulation to the current authoritative version', async () => {
    const signingKey = 'test-signing-key-that-is-long-enough-for-hmac';
    const sessionToken = await signAdminSession(
      {
        dataScope: 'ALL',
        expiresAt: Date.now() + 60_000,
        permissions: ['routing:simulate'],
        sessionInstanceId: intentId,
        subjectId: taskId,
      },
      signingKey,
    );
    const simulate = vi.fn();
    await expect(
      simulateRouting(
        {
          context: { sessionToken, signingKey },
          port: {
            getRouting: () => Promise.resolve(routingView),
            preview: vi.fn(),
            publish: vi.fn(),
            rollback: vi.fn(),
            save: vi.fn(),
            simulate,
          },
        },
        { duration: 5, expectedVersion: 6, routingVersionId },
      ),
    ).rejects.toThrow('路由版本已变化');
    expect(simulate).not.toHaveBeenCalled();
  });
});

describe('task operations', () => {
  it('shows duplicate-purchase risk before provider retry', () => {
    render(<TaskActions permissions={['tasks:retry']} task={task} />);
    expect(screen.getByRole('alert')).toHaveTextContent('重复采购风险');
    expect(screen.getByRole('button', { name: '重试供应商' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: '人工退款' })).not.toBeInTheDocument();
  });

  it('allows provider switch after authoritative no-charge confirmation', () => {
    render(
      <TaskActions
        permissions={['tasks:switch']}
        task={{
          ...task,
          allowedOperations: ['SWITCH_PROVIDER'],
          duplicatePurchaseRisk: false,
          operationPreviews: [
            {
              impact: '当前供应商确认未计费，可切换',
              operation: 'SWITCH_PROVIDER',
              preflightToken: 'task-pf-switch-no-charge',
              purchaseSafety: 'CONFIRMED_NO_CHARGE',
            },
          ],
        }}
      />,
    );
    expect(screen.getByRole('button', { name: '切换供应商' })).toBeEnabled();
  });

  it('rejects global queue controls from a non-ALL data scope before reading queue state', async () => {
    const signingKey = 'test-signing-key-that-is-long-enough-for-hmac';
    const sessionToken = await signAdminSession(
      {
        dataScope: 'ASSIGNED',
        expiresAt: Date.now() + 60_000,
        permissions: ['tasks:read', 'tasks:priority-write'],
        sessionInstanceId: intentId,
        subjectId: task.ownerAdminId as string,
      },
      signingKey,
    );
    const listTasks = vi.fn(() => Promise.resolve(taskDirectory));
    const executeQueue = vi.fn(() =>
      Promise.resolve({
        auditRecordId,
        concurrencyLimit: 24,
        defaultPriority: 8,
        idempotencyKey: intentId,
        operation: 'UPDATE_LIMITS',
        paused: false,
        rateLimitPerMinute: 600,
        requestId,
        version: 13,
      }),
    );
    const form = new FormData();
    form.set('action', 'UPDATE_LIMITS');
    form.set('concurrencyLimit', '24');
    form.set('defaultPriority', '8');
    form.set('expectedPaused', 'false');
    form.set('expectedVersion', '12');
    form.set('impactToken', 'queue-limits-token');
    form.set('rateLimitPerMinute', '600');
    form.set('intentId', intentId);
    form.set('reason', '夜间批处理容量调整');
    form.set('confirmed', 'true');
    await expect(
      createQueueAction({
        context: { sessionToken, signingKey },
        port: { executeQueue, getTask: () => Promise.resolve(task), listTasks },
      })(form),
    ).rejects.toThrow('ALL');
    expect(listTasks).not.toHaveBeenCalled();
    expect(executeQueue).not.toHaveBeenCalled();
  });

  it('rejects unbound 2xx payloads for task and queue mutations', async () => {
    const signingKey = 'test-signing-key-that-is-long-enough-for-hmac';
    const sessionBase = {
      dataScope: 'ALL' as const,
      expiresAt: Date.now() + 60_000,
      sessionInstanceId: intentId,
      subjectId: task.ownerAdminId as string,
    };
    const taskToken = await signAdminSession(
      { ...sessionBase, permissions: ['tasks:cancel'] },
      signingKey,
    );
    const taskForm = new FormData();
    taskForm.set('action', 'CANCEL');
    taskForm.set('confirmed', 'true');
    taskForm.set('expectedVersion', '4');
    taskForm.set('impactToken', 'task-pf-cancel-safe');
    taskForm.set('intentId', intentId);
    taskForm.set('reason', '用户请求取消');
    taskForm.set('taskId', taskId);
    await expect(
      createTaskAction({
        context: { sessionToken: taskToken, signingKey },
        port: {
          execute: () => Promise.resolve({ ok: true }),
          getTask: () => Promise.resolve(task),
        },
      })(taskForm),
    ).rejects.toThrow('回执无效');

    const queueToken = await signAdminSession(
      { ...sessionBase, permissions: ['tasks:read', 'tasks:priority-write'] },
      signingKey,
    );
    const queueForm = new FormData();
    queueForm.set('action', 'UPDATE_LIMITS');
    queueForm.set('concurrencyLimit', '24');
    queueForm.set('confirmed', 'true');
    queueForm.set('defaultPriority', '8');
    queueForm.set('expectedPaused', 'false');
    queueForm.set('expectedVersion', '12');
    queueForm.set('impactToken', 'queue-limits-token');
    queueForm.set('intentId', intentId);
    queueForm.set('rateLimitPerMinute', '600');
    queueForm.set('reason', '夜间批处理容量调整');
    await expect(
      createQueueAction({
        context: { sessionToken: queueToken, signingKey },
        port: {
          executeQueue: () => Promise.resolve({ ok: true }),
          getTask: () => Promise.resolve(task),
          listTasks: () => Promise.resolve(taskDirectory),
        },
      })(queueForm),
    ).rejects.toThrow('回执无效');
  });

  it('executes queue limit updates only with permission, confirmation, reason and idempotency', async () => {
    const signingKey = 'test-signing-key-that-is-long-enough-for-hmac';
    const sessionToken = await signAdminSession(
      {
        dataScope: 'ALL',
        expiresAt: Date.now() + 60_000,
        permissions: ['tasks:read', 'tasks:priority-write'],
        sessionInstanceId: intentId,
        subjectId: task.ownerAdminId as string,
      },
      signingKey,
    );
    const executeQueue = vi.fn(() =>
      Promise.resolve({
        auditRecordId,
        concurrencyLimit: 24,
        defaultPriority: 8,
        idempotencyKey: intentId,
        operation: 'UPDATE_LIMITS',
        paused: false,
        rateLimitPerMinute: 600,
        requestId,
        version: 13,
      }),
    );
    const form = new FormData();
    form.set('action', 'UPDATE_LIMITS');
    form.set('concurrencyLimit', '24');
    form.set('defaultPriority', '8');
    form.set('expectedPaused', 'false');
    form.set('expectedVersion', '12');
    form.set('impactToken', 'queue-limits-token');
    form.set('rateLimitPerMinute', '600');
    form.set('intentId', intentId);
    form.set('reason', '夜间批处理容量调整');
    form.set('confirmed', 'true');
    await createQueueAction({
      context: { sessionToken, signingKey },
      port: {
        executeQueue,
        getTask: () => Promise.resolve(task),
        listTasks: () => Promise.resolve(taskDirectory),
      },
    })(form);
    expect(executeQueue).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'UPDATE_LIMITS',
        audit: { idempotencyKey: intentId, reason: '夜间批处理容量调整' },
        concurrencyLimit: 24,
        defaultPriority: 8,
        rateLimitPerMinute: 600,
      }),
    );
  });

  it('rejects a stale queue resume after the authoritative queue state changed', async () => {
    const signingKey = 'test-signing-key-that-is-long-enough-for-hmac';
    const sessionToken = await signAdminSession(
      {
        dataScope: 'ALL',
        expiresAt: Date.now() + 60_000,
        permissions: ['tasks:read', 'tasks:queue-resume'],
        sessionInstanceId: intentId,
        subjectId: task.ownerAdminId as string,
      },
      signingKey,
    );
    const executeQueue = vi.fn();
    const form = new FormData();
    form.set('action', 'RESUME');
    form.set('expectedPaused', 'true');
    form.set('expectedVersion', '11');
    form.set('impactToken', 'stale-resume-token');
    form.set('intentId', intentId);
    form.set('reason', '恢复处理');
    form.set('confirmed', 'true');
    await expect(
      createQueueAction({
        context: { sessionToken, signingKey },
        port: {
          executeQueue,
          getTask: () => Promise.resolve(task),
          listTasks: () => Promise.resolve(taskDirectory),
        },
      })(form),
    ).rejects.toThrow('队列状态已变化');
    expect(executeQueue).not.toHaveBeenCalled();
  });

  it('does not let pause permission smuggle queue limit changes', async () => {
    const signingKey = 'test-signing-key-that-is-long-enough-for-hmac';
    const sessionToken = await signAdminSession(
      {
        dataScope: 'ALL',
        expiresAt: Date.now() + 60_000,
        permissions: ['tasks:queue-pause'],
        sessionInstanceId: intentId,
        subjectId: task.ownerAdminId as string,
      },
      signingKey,
    );
    const executeQueue = vi.fn();
    const form = new FormData();
    form.set('action', 'PAUSE');
    form.set('concurrencyLimit', '999');
    form.set('defaultPriority', '99');
    form.set('rateLimitPerMinute', '999999');
    form.set('intentId', intentId);
    form.set('reason', '紧急暂停');
    form.set('confirmed', 'true');
    await expect(
      createQueueAction({
        context: { sessionToken, signingKey },
        port: { executeQueue, getTask: () => Promise.resolve(task) },
      })(form),
    ).rejects.toThrow('队列操作字段无效');
    expect(executeQueue).not.toHaveBeenCalled();
  });

  it('never loads raw exchange when the session lacks raw-read permission', async () => {
    const signingKey = 'test-signing-key-that-is-long-enough-for-hmac';
    const sessionToken = await signAdminSession(
      {
        dataScope: 'ALL',
        expiresAt: Date.now() + 60_000,
        permissions: ['tasks:read'],
        sessionInstanceId: intentId,
        subjectId: task.ownerAdminId as string,
      },
      signingKey,
    );
    const getRaw = vi.fn();
    const result = await loadTaskDetailView({
      context: { sessionToken, signingKey },
      taskId,
      port: {
        getTask() {
          return Promise.resolve(task);
        },
        getRaw,
      },
    });
    expect(getRaw).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty('rawExchange');
  });

  it('rechecks authoritative allowedOperations before executing a forged action', async () => {
    const signingKey = 'test-signing-key-that-is-long-enough-for-hmac';
    const sessionToken = await signAdminSession(
      {
        dataScope: 'ALL',
        expiresAt: Date.now() + 60_000,
        permissions: ['tasks:refund'],
        sessionInstanceId: intentId,
        subjectId: task.ownerAdminId as string,
      },
      signingKey,
    );
    const execute = vi.fn<() => void>();
    const form = new FormData();
    form.set('action', 'REFUND');
    form.set('taskId', taskId);
    form.set('expectedVersion', '4');
    form.set('impactToken', 'task-pf-refund-safe');
    form.set('intentId', intentId);
    form.set('reason', '补偿已核实的重复扣款');
    form.set('confirmed', 'true');
    await expect(
      createTaskAction({
        context: { sessionToken, signingKey },
        port: {
          execute() {
            execute();
            return Promise.resolve({ ok: true });
          },
          getTask() {
            return Promise.resolve(task);
          },
        },
      })(form),
    ).rejects.toThrow('当前任务不允许此操作');
    expect(execute).not.toHaveBeenCalled();
  });

  it('renders raw exchange only with raw-read permission and keeps redaction in the DOM', () => {
    const { rerender } = render(<TaskOperationsPanel permissions={['tasks:read']} task={task} />);
    expect(screen.queryByRole('tab', { name: '原始报文' })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('authorization');
    rerender(<TaskOperationsPanel permissions={['tasks:read', 'tasks:raw-read']} task={task} />);
    fireEvent.click(screen.getByRole('tab', { name: '原始报文' }));
    expect(screen.getByText(/\[REDACTED\]/)).toBeVisible();
    expect(document.body.textContent).not.toContain('Bearer');
  });

  it('redacts nested signed URLs and authorization material', () => {
    const redacted = JSON.stringify(
      redactRawPayload({
        downloadUrl:
          'https://media.example/file?X-Amz-Credential=AKIA123&X-Amz-Signature=secret#access_token=oauth',
        formText: 'client_secret=form-secret&password=form-password&safe=value',
        headersText:
          'Authorization: Basic dXNlcjpwYXNz\r\nCookie: session=cookie-secret\r\nSet-Cookie: refresh=refresh-secret',
        headers: { Authorization: 'Bearer secret' },
        rawAuthorizationJson: '{"Authorization":"Digest digest-secret"}',
        rawCookieJson: '{"Set-Cookie":"session=json-cookie-secret"}',
      }),
    );
    expect(redacted).not.toContain('AKIA123');
    expect(redacted).not.toContain('Signature=secret');
    expect(redacted).not.toContain('Bearer secret');
    expect(redacted).not.toContain('oauth');
    expect(redacted).not.toContain('dXNlcjpwYXNz');
    expect(redacted).not.toContain('form-secret');
    expect(redacted).not.toContain('form-password');
    expect(redacted).not.toContain('cookie-secret');
    expect(redacted).not.toContain('refresh-secret');
    expect(redacted).not.toContain('digest-secret');
    expect(redacted).not.toContain('json-cookie-secret');
    expect(redacted).toContain('[REDACTED]');
  });

  it('loads raw data on demand, rechecks scope, and redacts before returning it', async () => {
    const signingKey = 'test-signing-key-that-is-long-enough-for-hmac';
    const sessionToken = await signAdminSession(
      {
        dataScope: 'ALL',
        expiresAt: Date.now() + 60_000,
        permissions: ['tasks:read', 'tasks:raw-read'],
        sessionInstanceId: intentId,
        subjectId: task.ownerAdminId as string,
      },
      signingKey,
    );
    const result = await loadTaskRawView({
      context: { sessionToken, signingKey },
      taskId,
      port: {
        getTask() {
          return Promise.resolve(task);
        },
        getRaw() {
          return Promise.resolve({
            request: { authorization: 'Bearer secret' },
            response: {
              downloadUrl:
                'https://media.example/file?X-Amz-Credential=AKIA123&X-Amz-Signature=secret',
            },
          });
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain('AKIA123');
    expect(JSON.stringify(result)).not.toContain('Bearer secret');
  });

  it('submits an allowed task action only after impact, reason and confirmation', async () => {
    const actionable = {
      ...task,
      attempt: { ...task.attempt, acceptance: 'NOT_ACCEPTED' as const },
      duplicatePurchaseRisk: false,
    };
    const onAction = vi.fn<(form: FormData) => Promise<void>>(() => Promise.resolve());
    render(
      <TaskActions
        createIntentId={() => intentId}
        onAction={onAction}
        permissions={['tasks:cancel']}
        task={actionable}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '取消任务' }));
    expect(screen.getByText(/释放冻结点数/)).toBeVisible();
    fireEvent.change(screen.getByLabelText('操作原因'), { target: { value: '用户请求取消' } });
    fireEvent.click(screen.getByLabelText('我确认执行任务操作'));
    fireEvent.click(screen.getByRole('button', { name: '确认执行' }));
    await waitFor(() => {
      expect(onAction).toHaveBeenCalledTimes(1);
    });
    const form = onAction.mock.calls[0]?.[0] as FormData;
    expect(form.get('taskId')).toBe(taskId);
    expect(form.get('expectedVersion')).toBe('4');
    expect(form.get('intentId')).toBe(intentId);
    expect(form.get('reason')).toBe('用户请求取消');
    expect(form.get('impactToken')).toBe('task-pf-cancel-safe');
  });

  it('rejects a whitespace-only high-risk reason at the server boundary', async () => {
    const signingKey = 'test-signing-key-that-is-long-enough-for-hmac';
    const sessionToken = await signAdminSession(
      {
        dataScope: 'ALL',
        expiresAt: Date.now() + 60_000,
        permissions: ['tasks:cancel'],
        sessionInstanceId: intentId,
        subjectId: task.ownerAdminId as string,
      },
      signingKey,
    );
    const execute = vi.fn<() => void>();
    const form = new FormData();
    form.set('action', 'CANCEL');
    form.set('taskId', taskId);
    form.set('expectedVersion', '4');
    form.set('impactToken', 'task-pf-cancel-safe');
    form.set('intentId', intentId);
    form.set('reason', '   ');
    form.set('confirmed', 'true');
    await expect(
      createTaskAction({
        context: { sessionToken, signingKey },
        port: {
          execute() {
            execute();
            return Promise.resolve({ ok: true });
          },
          getTask() {
            return Promise.resolve(task);
          },
        },
      })(form),
    ).rejects.toThrow('任务操作字段无效');
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects an OWN-scope action outside the authoritative owner scope', async () => {
    const signingKey = 'test-signing-key-that-is-long-enough-for-hmac';
    const sessionToken = await signAdminSession(
      {
        dataScope: 'OWN',
        expiresAt: Date.now() + 60_000,
        permissions: ['tasks:cancel'],
        sessionInstanceId: intentId,
        subjectId: '0198f7a4-c7e1-7b39-8a4e-73af0c1d2e3f',
      },
      signingKey,
    );
    const form = new FormData();
    form.set('action', 'CANCEL');
    form.set('taskId', taskId);
    form.set('expectedVersion', '4');
    form.set('impactToken', 'task-pf-cancel-safe');
    form.set('intentId', intentId);
    form.set('reason', '用户请求取消');
    form.set('confirmed', 'true');
    await expect(
      createTaskAction({
        context: { sessionToken, signingKey },
        port: {
          execute() {
            return Promise.resolve({ ok: true });
          },
          getTask() {
            return Promise.resolve(task);
          },
        },
      })(form),
    ).rejects.toThrow('数据范围不允许此操作');
  });

  it('sends the stable idempotency key in the standard mutation header', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response('{}', { headers: { 'Content-Type': 'application/json' }, status: 200 }),
      ),
    );
    const port = createHttpOperationsPorts(
      { apiUrl: 'https://operations.example/', kmsIdentityReference: 'kms://admin/operations' },
      { fetchImpl },
    ).tasks;
    await port.execute?.({
      action: 'CANCEL',
      actorId: task.ownerAdminId as string,
      audit: { idempotencyKey: intentId, reason: '用户请求取消' },
      confirmed: true,
      expectedVersion: 4,
      impactToken: 'task-pf-cancel-safe',
      requestContext: createOutboundRequestContext(
        () => '00112233445566778899aabbccddeeff',
        () => taskId,
      ),
      scope: 'ALL',
      taskId,
      trustedSessionToken: 'trusted-session',
    });
    const requestInit = fetchImpl.mock.calls[0]?.[1];
    expect(new Headers(requestInit?.headers).get('Idempotency-Key')).toBe(intentId);
  });
});
