'use client';

import {
  Button,
  Field,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  Textarea,
  makeStyles,
} from '@fluentui/react-components';
import { useRef, useState } from 'react';
import { formatBps, formatPoints, type RoutingSimulation } from '../../lib/operations-control';

type RoutingSimulatorProps = Readonly<{
  expectedVersion?: number;
  onSimulate: (parameters: Readonly<Record<string, unknown>>) => Promise<RoutingSimulation>;
  permissions: readonly string[];
  versionId?: string;
}>;
const useStyles = makeStyles({ actions: { marginTop: '10px' }, section: { marginTop: '18px' } });

export function RoutingSimulator({
  expectedVersion,
  onSimulate,
  permissions,
  versionId,
}: RoutingSimulatorProps) {
  const styles = useStyles();
  const [json, setJson] = useState('{}');
  const [result, setResult] = useState<RoutingSimulation>();
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const generation = useRef(0);
  const canSimulate = permissions.includes('*') || permissions.includes('routing:simulate');
  async function simulate() {
    if (!canSimulate || pending) return;
    let parsed: unknown;
    try {
      if (json.length > 32_000) throw new Error('too large');
      parsed = JSON.parse(json);
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object')
        throw new Error('invalid');
    } catch {
      setError('模拟参数必须是有效且受限的 JSON 对象');
      return;
    }
    const requestGeneration = ++generation.current;
    setPending(true);
    setError('');
    try {
      const response = await onSimulate({
        ...(parsed as Readonly<Record<string, unknown>>),
        ...(expectedVersion === undefined ? {} : { expectedVersion }),
        ...(versionId === undefined ? {} : { routingVersionId: versionId }),
      });
      if (generation.current === requestGeneration) setResult(response);
    } catch {
      if (generation.current === requestGeneration) setError('权威路由模拟失败');
    } finally {
      if (generation.current === requestGeneration) setPending(false);
    }
  }
  return (
    <section aria-label="路由策略模拟器">
      <Field label="模拟参数 JSON">
        <Textarea
          aria-label="模拟参数 JSON"
          onChange={(_e, data) => {
            setJson(data.value);
          }}
          resize="vertical"
          value={json}
        />
      </Field>
      {error ? <Text role="alert">{error}</Text> : null}
      <div className={styles.actions}>
        <Button
          appearance="primary"
          disabled={!canSimulate || pending}
          onClick={() => {
            void simulate();
          }}
        >
          运行权威路由模拟
        </Button>
      </div>
      {result ? (
        <div className={styles.section}>
          <Table aria-label="路由候选评分">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>候选</TableHeaderCell>
                <TableHeaderCell>成本 / 售价</TableHeaderCell>
                <TableHeaderCell>毛利</TableHeaderCell>
                <TableHeaderCell>评分解释</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.candidates.map((candidate) => (
                <TableRow key={`${candidate.providerName}-${candidate.modelCode}`}>
                  <TableCell>
                    <span>{candidate.providerName}</span>
                    <br />
                    {candidate.modelCode}
                    {candidate.selected ? ' · 最终选择' : ''}
                  </TableCell>
                  <TableCell>
                    {formatPoints(candidate.costPoints)} / {formatPoints(candidate.salePoints)}
                  </TableCell>
                  <TableCell>{formatBps(candidate.marginBps)}</TableCell>
                  <TableCell>
                    {candidate.score} · {candidate.scoreExplanation.join('；')}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {result.exclusions.length > 0 ? (
            <Table aria-label="路由排除原因">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>模型</TableHeaderCell>
                  <TableHeaderCell>排除原因</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.exclusions.map((item) => (
                  <TableRow key={`${item.modelCode}-${item.reason}`}>
                    <TableCell>{item.modelCode}</TableCell>
                    <TableCell>{item.reason}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
