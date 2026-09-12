'use server';

import {
  requireMutableAuthenticatedServerSession,
  SessionRefreshRequiredError,
} from '../../lib/auth/server-session';
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

export type StudioActionResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly outcome: 'SESSION_REFRESH_REQUIRED' };

async function runStudioAction<T>(operation: () => Promise<T>): Promise<StudioActionResult<T>> {
  try {
    return { ok: true, data: await operation() };
  } catch (error) {
    if (error instanceof SessionRefreshRequiredError) {
      return { ok: false, outcome: 'SESSION_REFRESH_REQUIRED' };
    }
    throw error;
  }
}

export async function listStudioProvidersAction() {
  return runStudioAction(async () => (await gateway()).listProviders());
}

export async function listStudioModelsAction() {
  return runStudioAction(async () => (await gateway()).listModels());
}

export async function getStudioCapabilityAction(modelId: string) {
  return runStudioAction(async () => (await gateway()).getCapability(modelId));
}

export async function getSmartStudioCapabilityAction(mode: StudioGenerationMode) {
  return runStudioAction(async () => (await gateway()).getSmartCapability(mode));
}

export async function quoteStudioTaskAction(request: StudioQuoteRequest) {
  return runStudioAction(async () => (await gateway()).quote(request));
}

export async function createStudioTaskAction(
  request: StudioCreateTaskRequest,
  idempotencyKey: string,
) {
  return runStudioAction(async () =>
    (await gateway()).createTask(request, { idempotencyKey }),
  );
}
