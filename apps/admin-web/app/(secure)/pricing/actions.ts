'use server';

import { createHttpOperationsPorts } from '../../../lib/http-operations-port';
import {
  createPricingPreviewAction,
  createPricingPublishAction,
  createPricingRollbackAction,
  createPricingSaveAction,
} from '../../../lib/operations-server';

export async function previewPricingAction(form: FormData) {
  return createPricingPreviewAction({ port: createHttpOperationsPorts().pricing })(form);
}
export async function publishPricingAction(form: FormData) {
  await createPricingPublishAction({ port: createHttpOperationsPorts().pricing })(form);
}
export async function savePricingAction(form: FormData) {
  await createPricingSaveAction({ port: createHttpOperationsPorts().pricing })(form);
}
export async function rollbackPricingAction(form: FormData) {
  await createPricingRollbackAction({ port: createHttpOperationsPorts().pricing })(form);
}
