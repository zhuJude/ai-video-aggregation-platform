import {
  createStudioTaskAction,
  getSmartStudioCapabilityAction,
  getStudioCapabilityAction,
  listStudioModelsAction,
  listStudioProvidersAction,
  quoteStudioTaskAction,
} from '../../app/studio/actions';
import type { StudioGateway } from './types';

/** The browser only invokes same-origin Server Actions; credentials and mock state stay server-side. */
export const clientStudioGateway: StudioGateway = {
  listProviders: listStudioProvidersAction,
  listModels: listStudioModelsAction,
  getCapability: getStudioCapabilityAction,
  getSmartCapability: getSmartStudioCapabilityAction,
  quote: quoteStudioTaskAction,
  createTask: (request, { idempotencyKey }) => createStudioTaskAction(request, idempotencyKey),
};
