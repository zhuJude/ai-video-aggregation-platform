'use client';

import { Badge, Card, CardHeader, Text, Title2, makeStyles } from '@fluentui/react-components';

import type {
  OverviewDataset,
  OverviewMeasure,
  OverviewSourceStatus,
} from '../lib/overview-view-loader';

export type { OverviewDataset } from '../lib/overview-view-loader';

export type OverviewCockpitProps = Readonly<{
  datasets: readonly OverviewDataset[];
}>;

const useStyles = makeStyles({
  grid: {
    display: 'grid',
    gap: '12px',
    gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
  },
  card: { minHeight: '172px' },
  measures: {
    display: 'grid',
    gap: '8px',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  },
  measure: { display: 'grid', gap: '2px', minWidth: 0 },
  status: { display: 'grid', gap: '8px', marginTop: '12px' },
  warning: { color: 'var(--colorPaletteRedForeground1)' },
});

const statusCopy: Readonly<Record<OverviewSourceStatus, string>> = {
  EMPTY: '当前范围没有可展示数据',
  ERROR: '数据源暂时不可用',
  PARTIAL: '数据不完整',
  READY: '数据由权威服务提供',
  STALE: '数据已过期，等待刷新',
};

function statusColor(
  status: OverviewSourceStatus,
): 'danger' | 'informative' | 'success' | 'warning' {
  if (status === 'ERROR') return 'danger';
  if (status === 'PARTIAL' || status === 'STALE') return 'warning';
  if (status === 'READY') return 'success';
  return 'informative';
}

export function formatOverviewMeasure(measure: OverviewMeasure): string {
  if ('unit' in measure) return `${measure.value} 秒`;
  if (!('minorUnits' in measure)) return measure.value;
  const padded = measure.minorUnits.padStart(3, '0');
  const integer = padded.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
  const fraction = padded.slice(-2);
  const sign = measure.direction === 'DEBIT' ? '-' : '';
  return `${measure.currency} ${sign}${integer}.${fraction}`;
}

export function OverviewCockpit({ datasets }: OverviewCockpitProps) {
  const styles = useStyles();
  const requiresCaution = datasets.some((dataset) => dataset.status !== 'READY');

  return (
    <section aria-labelledby="overview-heading">
      <Title2 id="overview-heading">运营总览</Title2>
      <div className={styles.grid}>
        {datasets.map((dataset) => (
          <Card className={styles.card} key={dataset.id}>
            <CardHeader
              header={<Text weight="semibold">{dataset.label}</Text>}
              action={
                <Badge appearance="tint" color={statusColor(dataset.status)}>
                  {dataset.status}
                </Badge>
              }
            />
            <div className={styles.measures}>
              {dataset.measures.map((measure) => (
                <div className={styles.measure} key={measure.id}>
                  <Text size={200}>{measure.label}</Text>
                  <Text weight="semibold" wrap={false}>
                    {formatOverviewMeasure(measure)}
                  </Text>
                </div>
              ))}
            </div>
            <div className={styles.status}>
              <Text>{statusCopy[dataset.status]}</Text>
              {(dataset.warning ?? dataset.reason) ? (
                <Text
                  className={styles.warning}
                  role={dataset.status === 'ERROR' ? 'alert' : undefined}
                >
                  {dataset.warning ?? dataset.reason}
                </Text>
              ) : null}
              <Text size={200}>来源时间 {dataset.sourceTimestamp ?? '未提供'}</Text>
            </div>
          </Card>
        ))}
      </div>
      {requiresCaution ? <Text role="alert">数据不完整，不能作为权威计算依据</Text> : null}
    </section>
  );
}
