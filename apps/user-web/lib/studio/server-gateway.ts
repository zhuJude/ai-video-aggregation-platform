import 'server-only';

import { studioGateway as staticStudioGateway } from './gateway';
import { createMockCommercialTask, saveMockCommercialQuote } from './mock-commercial-store';
import type { StudioGateway } from './types';

export function createStudioServerGateway(context: { readonly ownerId: string }): StudioGateway {
  const requireEnabled = () => {
    if (process.env.USER_WEB_STUDIO_MODE !== 'mock') {
      throw new Error('STUDIO_GATEWAY_UNAVAILABLE');
    }
  };
  return {
    async listProviders() {
      requireEnabled();
      return staticStudioGateway.listProviders();
    },
    async listModels() {
      requireEnabled();
      return staticStudioGateway.listModels();
    },
    async getCapability(modelId) {
      requireEnabled();
      return staticStudioGateway.getCapability(modelId);
    },
    async getSmartCapability(mode) {
      requireEnabled();
      return staticStudioGateway.getSmartCapability(mode);
    },
    async quote(request) {
      requireEnabled();
      const quote = await staticStudioGateway.quote(request);
      return saveMockCommercialQuote(context.ownerId, request, quote);
    },
    async createTask(request, options) {
      requireEnabled();
      return createMockCommercialTask(context.ownerId, request, options.idempotencyKey);
    },
  };
}
