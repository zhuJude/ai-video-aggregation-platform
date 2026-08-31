import { randomBytes } from 'node:crypto';
import type { ReportQueryService, ReportRange } from '../http/reports.controller.js';

export type ExportReport = 'overview' | 'finance' | 'providers' | 'models' | 'tasks' | 'users';
export type ExportStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';

export interface ExportJob {
  id: string;
  adminId: string;
  report: ExportReport;
  range: ReportRange;
  status: ExportStatus;
  createdAt: string;
  completedAt?: string;
  assetObjectKey?: string;
  errorCode?: string;
}

export interface PrivateAssetStore {
  putPrivate(input: { objectKey: string; body: string; expiresAt: string }): Promise<void>;
}

export interface AuditSink {
  record(entry: Record<string, string>): Promise<void>;
}

function uuidV7(now: number): string {
  const bytes = randomBytes(16);
  let timestamp = BigInt(now);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function csvCell(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toCsv(rows: Array<Record<string, string | number | null>>): string {
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return [
    headers.map(csvCell).join(','),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(',')),
  ].join('\r\n');
}

export class ExportService {
  private readonly jobs = new Map<string, ExportJob>();
  private readonly queue: string[] = [];

  constructor(
    private readonly queries: ReportQueryService,
    private readonly assets: PrivateAssetStore,
    private readonly audit: AuditSink,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async enqueue(adminId: string, report: ExportReport, range: ReportRange): Promise<ExportJob> {
    const createdAt = this.now();
    const job: ExportJob = {
      id: uuidV7(createdAt.getTime()),
      adminId,
      report,
      range: { ...range },
      status: 'QUEUED',
      createdAt: createdAt.toISOString(),
    };
    this.jobs.set(job.id, job);
    this.queue.push(job.id);
    await this.audit.record({
      action: 'REPORT_EXPORT_REQUESTED',
      adminId,
      exportId: job.id,
      report,
      occurredAt: job.createdAt,
    });
    return { ...job, range: { ...job.range } };
  }

  status(id: string): ExportJob | undefined {
    const job = this.jobs.get(id);
    return job === undefined ? undefined : { ...job, range: { ...job.range } };
  }

  async runNext(): Promise<boolean> {
    const id = this.queue.shift();
    if (id === undefined) return false;
    const job = this.jobs.get(id);
    if (job === undefined || job.status !== 'QUEUED') return false;
    job.status = 'RUNNING';
    try {
      const rows = await this.queries.exportRows(job.report, job.range);
      const completedAt = this.now();
      const expiresAt = new Date(completedAt.getTime() + 15 * 60 * 1000).toISOString();
      const datePrefix = completedAt.toISOString().slice(0, 10).replaceAll('-', '/');
      const assetObjectKey = `private/report-exports/${datePrefix}/${job.id}.csv`;
      await this.assets.putPrivate({ objectKey: assetObjectKey, body: toCsv(rows), expiresAt });
      job.status = 'SUCCEEDED';
      job.completedAt = completedAt.toISOString();
      job.assetObjectKey = assetObjectKey;
      await this.audit.record({
        action: 'REPORT_EXPORT_CREATED',
        adminId: job.adminId,
        exportId: job.id,
        report: job.report,
        assetObjectKey,
        occurredAt: job.completedAt,
      });
      return true;
    } catch {
      job.status = 'FAILED';
      job.completedAt = this.now().toISOString();
      job.errorCode = 'REPORT_EXPORT_FAILED';
      await this.audit.record({
        action: 'REPORT_EXPORT_FAILED',
        adminId: job.adminId,
        exportId: job.id,
        report: job.report,
        occurredAt: job.completedAt,
      });
      return false;
    }
  }
}
