'use server';

import { createHttpOperationsPorts } from '../../../lib/http-operations-port';
import {
  createRoutingPublishAction,
  createRoutingPreviewAction,
  createRoutingRollbackAction,
  createRoutingSaveAction,
  simulateRouting,
} from '../../../lib/operations-server';

export async function simulateRoutingAction(parameters: Readonly<Record<string, unknown>>) {
  return simulateRouting({ port: createHttpOperationsPorts().routing }, parameters);
}
export async function saveRoutingAction(form: FormData) {
  await createRoutingSaveAction({ port: createHttpOperationsPorts().routing })(form);
}
export async function publishRoutingAction(form: FormData) {
  await createRoutingPublishAction({ port: createHttpOperationsPorts().routing })(form);
}
export async function previewRoutingAction(form: FormData) {
  await createRoutingPreviewAction({ port: createHttpOperationsPorts().routing })(form);
}
export async function rollbackRoutingAction(form: FormData) {
  await createRoutingRollbackAction({ port: createHttpOperationsPorts().routing })(form);
}
