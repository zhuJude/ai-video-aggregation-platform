/* eslint-disable @typescript-eslint/require-await -- ports are deliberately asynchronous boundaries. */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { OverviewCockpit } from '../components/overview-cockpit';
import {
  type OverviewPort,
  type OverviewView,
  loadOverviewView,
} from '../lib/overview-view-loader';
import { signAdminSession } from '../lib/session-auth';

const signingKey = 'overview-view-loader-signing-key-at-least-32-bytes';
const sourceTimestamp = '2026-08-31T08:00:00.000Z';

const configuredView: OverviewView = {
  datasets: [
    {
      id: 'operations',
      label: '用户与点数',
      sourceTimestamp,
      status: 'READY',
      measures: [
        { id: 'registrations', label: '注册用户', value: '9007199254740993' },
        { id: 'active-users', label: '活跃用户', value: '42' },
        { id: 'recharge-points', label: '充值点数', value: '1234567890123456789025' },
        { id: 'consumption-points', label: '消耗点数', value: '432150' },
      ],
    },
    {
      id: 'tasks',
      label: '任务与队列',
      sourceTimestamp,
      status: 'PARTIAL',
      warning: '队列统计延迟',
      measures: [
        { id: 'task-count', label: '任务数', value: '1234' },
        { id: 'success-rate', label: '成功率', value: '99.95%' },
        { id: 'average-generation-duration', label: '平均生成时长', unit: 'SECONDS', value: '12' },
        { id: 'queue-backlog', label: '队列积压', value: '8' },
      ],
    },
    {
      id: 'finance',
      label: '财务',
      sourceTimestamp,
      status: 'STALE',
      warning: '成本源等待刷新',
      measures: [
        { currency: 'CNY', id: 'income', label: '收入', minorUnits: '1000000' },
        { currency: 'CNY', id: 'provider-cost', label: '供应商成本', minorUnits: '450000' },
        {
          currency: 'CNY',
          direction: 'CREDIT',
          id: 'gross-margin',
          label: '毛利',
          minorUnits: '550000',
        },
        { id: 'gross-margin-rate', label: '毛利率', value: '55.00%' },
        { currency: 'CNY', id: 'average-revenue-per-user', label: '客单价', minorUnits: '23810' },
        { id: 'repeat-purchase-rate', label: '复购率', value: '42.50%' },
      ],
    },
    {
      id: 'supplier-risk',
      label: '供应商与风险',
      sourceTimestamp,
      status: 'EMPTY',
      warning: '当前范围没有支付异常',
      measures: [
        { id: 'supplier-balance', label: '供应商余额', value: '0' },
        { id: 'supplier-failure-rate', label: '供应商失败率', value: '0.00%' },
        { id: 'payment-anomalies', label: '支付异常', value: '0' },
        { id: 'service-alerts', label: '服务告警', value: '0' },
      ],
    },
    {
      id: 'upstream-error',
      label: '独立故障源',
      status: 'ERROR',
      reason: 'UPSTREAM_FAILURE',
      measures: [],
    },
  ],
};

describe('overview server loader', () => {
  it('authorizes overview reads and passes the trusted session to the configured authoritative port', async () => {
    const token = await signAdminSession(
      {
        dataScope: 'ALL',
        expiresAt: Date.now() + 60_000,
        permissions: ['overview:read'],
        subjectId: '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f',
        sessionInstanceId: '0198f7a4-c6da-7b39-8a4e-73af0c1d2e3f',
      },
      signingKey,
    );
    let received: unknown;
    const port: OverviewPort = {
      async getOverview(input) {
        received = input;
        return configuredView;
      },
    };

    await expect(
      loadOverviewView({ context: { sessionToken: token, signingKey }, port }),
    ).resolves.toEqual(configuredView);
    expect(received).toMatchObject({ trustedSessionToken: token });
    const requestContext = (
      received as { requestContext: { correlationId: string; traceId: string } }
    ).requestContext;
    expect(requestContext.correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(requestContext.traceId).toMatch(/^[0-9a-f]{32}$/u);
  });

  it('formats a huge validated minor-unit amount in the UI without Number precision loss', () => {
    const huge = '900719925474099312345678901234567890';
    render(
      <OverviewCockpit
        datasets={[
          {
            id: 'finance',
            label: '财务',
            measures: [{ currency: 'CNY', id: 'income', label: '收入', minorUnits: huge }],
            sourceTimestamp: '2026-08-31T08:00:00.000Z',
            status: 'READY',
          } as never,
        ]}
      />,
    );
    expect(screen.getByText('CNY 9,007,199,254,740,993,123,456,789,012,345,678.90')).toBeVisible();
  });

  it('formats an explicit DEBIT gross margin as negative without accepting a signed numeric scalar', () => {
    render(
      <OverviewCockpit
        datasets={[
          {
            id: 'finance',
            label: '财务',
            measures: [
              {
                currency: 'CNY',
                direction: 'DEBIT',
                id: 'gross-margin',
                label: '毛利',
                minorUnits: '5500',
              },
            ],
            sourceTimestamp,
            status: 'READY',
          },
        ]}
      />,
    );
    expect(screen.getByText('CNY -55.00')).toBeVisible();
  });

  it('denies missing overview permission before invoking the port', async () => {
    const token = await signAdminSession(
      {
        dataScope: 'ALL',
        expiresAt: Date.now() + 60_000,
        permissions: ['users:read'],
        subjectId: '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f',
        sessionInstanceId: '0198f7a4-c6da-7b39-8a4e-73af0c1d2e3f',
      },
      signingKey,
    );
    let calls = 0;
    const port: OverviewPort = {
      async getOverview() {
        calls += 1;
        return configuredView;
      },
    };

    await expect(
      loadOverviewView({ context: { sessionToken: token, signingKey }, port }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(calls).toBe(0);
  });
});

describe('overview cockpit authoritative states', () => {
  it('renders ready values, source timestamps, and partial, stale, empty, and error warnings', () => {
    render(<OverviewCockpit datasets={configuredView.datasets} />);

    expect(screen.getByText('9007199254740993')).toBeVisible();
    expect(screen.getAllByText(`来源时间 ${sourceTimestamp}`)).toHaveLength(4);
    expect(screen.getByText('队列统计延迟')).toBeVisible();
    expect(screen.getByText('成本源等待刷新')).toBeVisible();
    expect(screen.getByText('客单价')).toBeVisible();
    expect(screen.getByText('CNY 238.10')).toBeVisible();
    expect(screen.getByText('复购率')).toBeVisible();
    expect(screen.getByText('42.50%')).toBeVisible();
    expect(screen.getByText('12 秒')).toBeVisible();
    expect(screen.getByText('当前范围没有支付异常')).toBeVisible();
    expect(screen.getByText('独立故障源')).toBeVisible();
    expect(screen.getByText('数据不完整，不能作为权威计算依据')).toBeVisible();
  });
});
