import {
  createStudioTaskAction,
  getSmartStudioCapabilityAction,
  getStudioCapabilityAction,
  listStudioModelsAction,
  listStudioProvidersAction,
  quoteStudioTaskAction,
} from '../../app/studio/actions';
import { coordinateSessionRefresh } from '../auth/client-session';
import type { StudioGateway } from './types';

type StudioActionResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly outcome: 'SESSION_REFRESH_REQUIRED' };

function loginRequired(): Error & { readonly outcome: 'DEFINITIVE_FAILURE' } {
  return Object.assign(new Error('LOGIN_REQUIRED'), { outcome: 'DEFINITIVE_FAILURE' as const });
}

async function runWithSessionRefresh<T>(
  operation: () => Promise<StudioActionResult<T>>,
): Promise<T> {
  const initial = await operation();
  if (initial.ok) return initial.data;
  if (!(await coordinateSessionRefresh())) throw loginRequired();
  const retried = await operation();
  if (!retried.ok) throw loginRequired();
  return retried.data;
}

/** The browser only invokes same-origin Server Actions; credentials and mock state stay server-side. */
export const clientStudioGateway: StudioGateway = {
  listProviders: () => runWithSessionRefresh(listStudioProvidersAction),
  listModels: () => runWithSessionRefresh(listStudioModelsAction),
  getCapability: (modelId) =>
    runWithSessionRefresh(() => getStudioCapabilityAction(modelId)),
  getSmartCapability: (mode) =>
    runWithSessionRefresh(() => getSmartStudioCapabilityAction(mode)),
  quote: (request) => runWithSessionRefresh(() => quoteStudioTaskAction(request)),
  createTask: (request, { idempotencyKey }) =>
    runWithSessionRefresh(() => createStudioTaskAction(request, idempotencyKey)),
};
