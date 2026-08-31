export type ProviderState = 'ACCEPTED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED';

export interface CanonicalCreateTask {
  taskId: string;
  modelCode: string;
  parameters: Record<string, unknown>;
  idempotencyKey: string;
}

export interface ProviderResult {
  state: ProviderState;
  resultUrls?: string[];
  errorCode?: string;
  errorMessage?: string;
}

export interface VideoProviderAdapter {
  readonly code: string;
  validateConfiguration(): Promise<{ valid: boolean; issues: string[] }>;
  getHealth(): Promise<{ status: 'UP' | 'DEGRADED' | 'DOWN'; latencyMs: number }>;
  createTask(
    input: CanonicalCreateTask,
  ): Promise<{ providerTaskId: string; state: ProviderState }>;
  queryTask(input: { providerTaskId: string }): Promise<ProviderResult>;
  cancelTask?(input: { providerTaskId: string }): Promise<ProviderResult>;
  verifyCallback(input: {
    headers: Record<string, string>;
    body: unknown;
  }): Promise<{ valid: boolean; payload: unknown }>;
  normalizeCallback(input: { payload: unknown }): Promise<ProviderResult>;
  getBalance?(): Promise<{ unit: string; available: string }>;
}

export { runAdapterConformance } from './conformance.js';
