import type { VideoProviderAdapter } from './index.js';

const providerStates: ReadonlySet<unknown> = new Set([
  'ACCEPTED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'CANCELED',
]);

export async function runAdapterConformance(adapter: VideoProviderAdapter): Promise<string[]> {
  const issues: string[] = [];
  const configuration = await adapter.validateConfiguration();
  if (!configuration.valid) {
    issues.push(...configuration.issues);
  }

  const health = await adapter.getHealth();
  if (health.status === 'DOWN') {
    issues.push('adapter health is DOWN');
  }

  const created = await adapter.createTask({
    taskId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a2',
    modelCode: 'test-model',
    parameters: { prompt: 'test' },
    idempotencyKey: 'conformance-create-1',
  });
  if (!created.providerTaskId) {
    issues.push('createTask returned no providerTaskId');
  }

  const queried = await adapter.queryTask({ providerTaskId: created.providerTaskId });
  if (!providerStates.has(queried.state)) {
    issues.push('queryTask returned an invalid state');
  }

  const callback = await adapter.verifyCallback({ headers: {}, body: {} });
  if (!callback.valid) {
    issues.push('callback verification rejected conformance fixture');
  }
  await adapter.normalizeCallback({ payload: callback.payload });

  return issues;
}
