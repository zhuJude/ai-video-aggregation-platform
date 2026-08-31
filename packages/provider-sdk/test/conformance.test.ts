import { describe, expect, it } from 'vitest';
import { runAdapterConformance, type VideoProviderAdapter } from '../src/index.js';

const adapter: VideoProviderAdapter = {
  code: 'fake',
  async validateConfiguration() {
    return { valid: true, issues: [] };
  },
  async getHealth() {
    return { status: 'UP', latencyMs: 5 };
  },
  async createTask(input) {
    return { providerTaskId: `p-${input.taskId}`, state: 'ACCEPTED' };
  },
  async queryTask() {
    return {
      state: 'SUCCEEDED',
      resultUrls: ['https://example.invalid/result.mp4'],
    };
  },
  async verifyCallback() {
    return { valid: true, payload: {} };
  },
  async normalizeCallback() {
    return { state: 'SUCCEEDED', resultUrls: [] };
  },
};

describe('provider conformance', () => {
  it('accepts a complete adapter', async () => {
    await expect(runAdapterConformance(adapter)).resolves.toEqual([]);
  });
});
