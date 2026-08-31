import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

interface AlertRule {
  alert: string;
  expr: string;
  for: string;
  labels: { severity: string; owner: string; dedup_key: string };
  annotations: {
    runbook_url: string;
    resolve_policy?: string;
    healthy_confirmation?: string;
  };
}

async function loadRules(): Promise<AlertRule[]> {
  const content = await readFile(resolve(packageRoot, 'alerts/rules.yaml'), 'utf8');
  const document = parse(content) as { groups: Array<{ rules: AlertRule[] }> };
  return document.groups.flatMap((group) => group.rules);
}

describe('production alert rules', () => {
  it.each([
    'WalletLedgerMismatch',
    'DuplicatePaymentEffect',
    'CoreApiUnavailable',
    'PaymentFailureSpike',
    'QueueStalled',
    'ProviderBalanceLow',
  ])('defines %s', async (name) => {
    expect((await loadRules()).map((rule) => rule.alert)).toContain(name);
  });

  it('defines routing, deduplication and runbook metadata for every alert', async () => {
    for (const rule of await loadRules()) {
      expect(rule.expr).toBeTruthy();
      expect(rule.for).toMatch(/^\d+[smh]$/);
      expect(rule.labels.severity).toMatch(/^P[0-3]$/);
      expect(rule.labels.owner).toBeTruthy();
      expect(rule.labels.dedup_key).toBeTruthy();
      expect(rule.annotations.runbook_url).toContain('/observability#');
    }
  });

  it('requires a healthy confirmation window before P0 alerts resolve', async () => {
    const p0Rules = (await loadRules()).filter((rule) => rule.labels.severity === 'P0');
    expect(p0Rules.length).toBeGreaterThan(0);
    for (const rule of p0Rules) {
      expect(rule.annotations.resolve_policy).toBe('healthy_window');
      expect(rule.annotations.healthy_confirmation).toMatch(/^\d+[mh]$/);
    }
  });
});

describe('Grafana-compatible dashboards', () => {
  it.each([
    ['platform-overview.json', ['Availability', 'HTTP p95 latency', 'Task funnel', 'Queue lag']],
    [
      'provider-health.json',
      ['Provider health', 'Provider p95 latency', 'Provider errors', 'Balance'],
    ],
    [
      'finance-integrity.json',
      ['Payment effects', 'Ledger mismatch', 'Reconciliation', 'Refund backlog'],
    ],
  ])('defines required panels in %s without forbidden labels', async (filename, requiredTitles) => {
    const content = await readFile(resolve(packageRoot, 'dashboards', filename), 'utf8');
    const dashboard = JSON.parse(content) as { panels: Array<{ title: string }> };
    const titles = dashboard.panels.map((panel) => panel.title);
    for (const title of requiredTitles) expect(titles).toContain(title);
    expect(content).not.toMatch(/user_?id|task_?id|order_?id|object_?key|phone/i);
  });
});
