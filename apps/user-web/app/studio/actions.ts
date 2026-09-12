'use server';

import { requireMutableAuthenticatedServerSession } from '../../lib/auth/server-session';
import { createStudioServerGateway } from '../../lib/studio/server-gateway';
import type {
  StudioCreateTaskRequest,
  StudioGenerationMode,
  StudioQuoteRequest,
} from '../../lib/studio/types';

async function gateway() {
  const session = await requireMutableAuthenticatedServerSession();
  return createStudioServerGateway(session);
}

export async function listStudioProvidersAction() {
  return (await gateway()).listProviders();
}

export async function listStudioModelsAction() {
  return (await gateway()).listModels();
}

export async function getStudioCapabilityAction(modelId: string) {
  return (await gateway()).getCapability(modelId);
}

export async function getSmartStudioCapabilityAction(mode: StudioGenerationMode) {
  return (await gateway()).getSmartCapability(mode);
}

export async function quoteStudioTaskAction(request: StudioQuoteRequest) {
  return (await gateway()).quote(request);
}

export async function createStudioTaskAction(
  request: StudioCreateTaskRequest,
  idempotencyKey: string,
) {
  return (await gateway()).createTask(request, { idempotencyKey });
}
