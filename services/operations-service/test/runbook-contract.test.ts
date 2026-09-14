import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('supporting services runbook', () => {
  it('contains executable commands and every required incident procedure', async () => {
    const runbook = await readFile(
      resolve(import.meta.dirname, '../../../docs/runbooks/supporting-services.md'),
      'utf8',
    );
    for (const section of [
      'Start and stop',
      'SLO and alerts',
      'Metrics',
      'OSS/KMS/RAM credential rotation',
      'Stuck provider import',
      'SSRF or supplier import incident',
      'Orphan scan',
      'Private object permissions',
      'Accidental deletion and final deletion',
      'CMS version rollback',
      'Ticket privacy incident',
      'SMS outage',
      'UNKNOWN_ACCEPTANCE and receipt reconciliation',
      'Operator queue',
      'Notification replay and DLQ',
      'Database migration and rollback',
      'Disaster recovery',
    ]) {
      expect(runbook, section).toContain(`## ${section}`);
    }
    expect(runbook).toContain('corepack pnpm --filter @repo/asset-service start');
    expect(runbook).toContain('GET /health/ready');
    expect(runbook).toContain('GET /metrics');
    expect(runbook).toContain('ASSET_WORKERS_ENABLED=false');
    expect(runbook).toContain('OPERATIONS_WORKERS_ENABLED=false');
    expect(runbook).toContain('NOTIFICATION_WORKERS_ENABLED=false');
    expect(runbook).toContain('ossutil');
    expect(runbook).toContain('mqadmin');
    expect(runbook).toContain('inventory --method list "oss://$env:OSS_BUCKET"');
    expect(runbook).toContain(
      'inventory --method get "oss://$env:OSS_BUCKET" "$env:OSS_INVENTORY_ID" --local_xml_file',
    );
    expect(runbook).toContain('OSS_INVENTORY_ID');
    expect(runbook).toContain('OSS_INVENTORY_DEST_BUCKET');
    expect(runbook).toContain('manifest.json');
    expect(runbook).toContain('creationTimestamp');
    expect(runbook).toContain('Weekly');
    expect(runbook).toContain('SSE-OSS');
    expect(runbook).not.toMatch(/daily schedule, CSV format, and KMS encryption/i);
    expect(runbook).toContain('get-bucket-public-access-block --bucket "$env:OSS_BUCKET"');
    expect(runbook).toContain('WS20');
    expect(runbook.match(/Prerequisite:/g)?.length).toBeGreaterThanOrEqual(12);
    expect(runbook.match(/Verify:/g)?.length).toBeGreaterThanOrEqual(12);
    expect(runbook).not.toContain('controlled replay operation');
    expect(runbook).not.toMatch(/<YOUR_|changeme|accessKeySecret\s*[:=]|TODO/i);
  });
});
