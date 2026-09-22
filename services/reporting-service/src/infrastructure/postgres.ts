import type {
  DailyMetric,
  ModelDailyMetric,
  ProviderDailyMetric,
  UserSegmentMetric,
} from '../application/projector.js';
import type { ReportProjectionReader } from '../http/reports.controller.js';
import type { BooleanHealthProbe, ProjectionFreshnessProbe } from '../runtime/runtime.js';

export interface SqlClient {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>> }>;
}

function requiredString(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  throw new Error(`Database field ${field} is not a string`);
}

function bigintValue(row: Record<string, unknown>, field: string): bigint {
  const value = row[field];
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  throw new Error(`Database field ${field} is not an integer`);
}

function safeNumber(row: Record<string, unknown>, field: string): number {
  const value = bigintValue(row, field);
  const numberValue = Number(value);
  if (!Number.isSafeInteger(numberValue))
    throw new Error(`Database field ${field} exceeds safe range`);
  return numberValue;
}

const ACTIVE_JOIN = `JOIN "ProjectionVersion" v
  ON v."version" = metric."projectionVersion" AND v."active" = TRUE`;

export class PostgresReportingReader implements ReportProjectionReader, ProjectionFreshnessProbe {
  constructor(private readonly client: SqlClient) {}

  async allDailyMetrics(): Promise<DailyMetric[]> {
    const result = await this.client.query(`
      SELECT
        metric."businessDate"::text AS date,
        metric."rechargePoints"::text AS "rechargePoints",
        metric."rechargeAmountMinor"::text AS "rechargeAmountMinor",
        metric."consumedPoints"::text AS "consumedPoints",
        metric."revenueMinor"::text AS "revenueMinor",
        metric."providerCostMinor"::text AS "providerCostMinor",
        metric."marginNumeratorMinor"::text AS "marginNumeratorMinor",
        metric."marginDenominatorMinor"::text AS "marginDenominatorMinor",
        metric."successfulTasks"::text AS "successfulTasks",
        metric."failedTasks"::text AS "failedTasks",
        metric."taskDurationMsTotal"::text AS "taskDurationMsTotal",
        metric."taskDurationSamples"::text AS "taskDurationSamples"
      FROM "DailyBusinessMetric" metric
      ${ACTIVE_JOIN}
      ORDER BY metric."businessDate"
    `);
    return result.rows.map((row) => ({
      date: requiredString(row, 'date'),
      rechargePoints: bigintValue(row, 'rechargePoints'),
      rechargeAmountMinor: bigintValue(row, 'rechargeAmountMinor'),
      consumedPoints: bigintValue(row, 'consumedPoints'),
      revenueMinor: bigintValue(row, 'revenueMinor'),
      providerCostMinor: bigintValue(row, 'providerCostMinor'),
      marginNumeratorMinor: bigintValue(row, 'marginNumeratorMinor'),
      marginDenominatorMinor: bigintValue(row, 'marginDenominatorMinor'),
      successfulTasks: safeNumber(row, 'successfulTasks'),
      failedTasks: safeNumber(row, 'failedTasks'),
      taskDurationMsTotal: bigintValue(row, 'taskDurationMsTotal'),
      taskDurationSamples: safeNumber(row, 'taskDurationSamples'),
    }));
  }

  async allProviderDailyMetrics(): Promise<ProviderDailyMetric[]> {
    const result = await this.client.query(`
      SELECT metric."businessDate"::text AS date, metric."providerId"::text AS "providerId",
        metric."successfulTasks"::text AS "successfulTasks",
        metric."failedTasks"::text AS "failedTasks",
        metric."providerCostMinor"::text AS "providerCostMinor",
        metric."durationMsTotal"::text AS "durationMsTotal",
        metric."durationSamples"::text AS "durationSamples"
      FROM "ProviderDailyMetric" metric
      ${ACTIVE_JOIN}
      ORDER BY metric."businessDate", metric."providerId"
    `);
    return result.rows.map((row) => ({
      date: requiredString(row, 'date'),
      providerId: requiredString(row, 'providerId'),
      successfulTasks: safeNumber(row, 'successfulTasks'),
      failedTasks: safeNumber(row, 'failedTasks'),
      providerCostMinor: bigintValue(row, 'providerCostMinor'),
      durationMsTotal: bigintValue(row, 'durationMsTotal'),
      durationSamples: safeNumber(row, 'durationSamples'),
    }));
  }

  async allModelDailyMetrics(): Promise<ModelDailyMetric[]> {
    const result = await this.client.query(`
      SELECT metric."businessDate"::text AS date, metric."modelId"::text AS "modelId",
        metric."successfulTasks"::text AS "successfulTasks",
        metric."failedTasks"::text AS "failedTasks",
        metric."consumedPoints"::text AS "consumedPoints",
        metric."revenueMinor"::text AS "revenueMinor",
        metric."providerCostMinor"::text AS "providerCostMinor"
      FROM "ModelDailyMetric" metric
      ${ACTIVE_JOIN}
      ORDER BY metric."businessDate", metric."modelId"
    `);
    return result.rows.map((row) => ({
      date: requiredString(row, 'date'),
      modelId: requiredString(row, 'modelId'),
      successfulTasks: safeNumber(row, 'successfulTasks'),
      failedTasks: safeNumber(row, 'failedTasks'),
      consumedPoints: bigintValue(row, 'consumedPoints'),
      revenueMinor: bigintValue(row, 'revenueMinor'),
      providerCostMinor: bigintValue(row, 'providerCostMinor'),
    }));
  }

  async allUserSegmentMetrics(): Promise<UserSegmentMetric[]> {
    const result = await this.client.query(`
      SELECT metric."businessDate"::text AS date, metric."segment",
        metric."acquiredUsers"::text AS "acquiredUsers",
        metric."activeUsers"::text AS "activeUsers",
        metric."retainedUsers"::text AS "retainedUsers"
      FROM "UserSegmentMetric" metric
      ${ACTIVE_JOIN}
      ORDER BY metric."businessDate", metric."segment"
    `);
    return result.rows.map((row) => ({
      date: requiredString(row, 'date'),
      segment: requiredString(row, 'segment'),
      acquiredUsers: safeNumber(row, 'acquiredUsers'),
      activeUsers: safeNumber(row, 'activeUsers'),
      retainedUsers: safeNumber(row, 'retainedUsers'),
    }));
  }

  async checkpoint(): Promise<{ projectedThrough: string } | undefined> {
    const result = await this.client.query(`
      SELECT checkpoint."projectedThrough"
      FROM "ProjectionCheckpoint" checkpoint
      JOIN "ProjectionVersion" v
        ON v."version" = checkpoint."projectionVersion" AND v."active" = TRUE
      WHERE checkpoint."consumer" = 'reporting'
      LIMIT 1
    `);
    const row = result.rows[0];
    return row === undefined
      ? undefined
      : { projectedThrough: requiredString(row, 'projectedThrough') };
  }

  async projectedThrough(): Promise<string | undefined> {
    return (await this.checkpoint())?.projectedThrough;
  }
}

export class PostgresHealthProbe implements BooleanHealthProbe {
  constructor(private readonly client: SqlClient) {}

  async check(): Promise<boolean> {
    try {
      await this.client.query('SELECT 1 AS ok');
      return true;
    } catch {
      return false;
    }
  }
}
