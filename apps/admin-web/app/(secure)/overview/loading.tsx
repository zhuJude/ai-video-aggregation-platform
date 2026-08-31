'use client';

import { Card, Text, Title2, makeStyles } from '@fluentui/react-components';

const useStyles = makeStyles({
  grid: {
    display: 'grid',
    gap: '12px',
    gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
  },
  skeleton: {
    backgroundColor: 'var(--colorNeutralBackground3)',
    borderRadius: '4px',
    height: '20px',
    width: '70%',
  },
  card: { display: 'grid', gap: '12px', minHeight: '172px', padding: '16px' },
});

export default function OverviewLoading() {
  const styles = useStyles();
  return (
    <section aria-busy="true" aria-labelledby="overview-loading-heading">
      <Title2 id="overview-loading-heading">运营总览</Title2>
      <Text>正在从权威数据源读取运营指标</Text>
      <div className={styles.grid}>
        {['users', 'tasks', 'finance', 'supplier-risk'].map((id) => (
          <Card className={styles.card} key={id}>
            <div className={styles.skeleton} />
            <div className={styles.skeleton} />
            <div className={styles.skeleton} />
          </Card>
        ))}
      </div>
    </section>
  );
}
