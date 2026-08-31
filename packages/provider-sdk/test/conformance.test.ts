import { describe, expect, it } from 'vitest';
import { runAdapterConformance, type VideoProviderAdapter } from '../src/index.js';

const adapter: VideoProviderAdapter = {
  code: 'fake',
  validateConfiguration() {
    return Promise.resolve({ valid: true, issues: [] });
  },
  getHealth() {
    return Promise.resolve({ status: 'UP', latencyMs: 5 });
  },
  createTask(input) {
    return Promise.resolve({ providerTaskId: `p-${input.taskId}`, state: 'ACCEPTED' });
  },
  queryTask() {
    return Promise.resolve({
      state: 'SUCCEEDED',
      resultUrls: ['https://example.invalid/result.mp4'],
    });
  },
  verifyCallback() {
    return Promise.resolve({ valid: true, payload: {} });
  },
  normalizeCallback() {
    return Promise.resolve({ state: 'SUCCEEDED', resultUrls: [] });
  },
};

describe('provider conformance', () => {
  it('accepts a complete adapter', async () => {
    await expect(runAdapterConformance(adapter)).resolves.toEqual([]);
  });
});
