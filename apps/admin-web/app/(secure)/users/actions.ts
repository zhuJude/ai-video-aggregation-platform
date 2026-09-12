'use server';

import { createHttpUserOperationPorts } from '../../../lib/http-user-operation-port';
import {
  createUserCsvExportAction,
  createWalletAdjustmentPreviewAction,
  createWalletAdjustmentRequestAction,
  createWalletAdjustmentApprovalAction,
  createWalletAdjustmentApprovalPreviewAction,
} from '../../../lib/user-operation-actions';
import { createUserStatusAction } from '../../../lib/protected-user-action';
import { createExactPhoneLookupAction } from '../../../lib/user-view-loaders';

export async function lookupExactPhoneAction(formData: FormData) {
  const ports = createHttpUserOperationPorts();
  return createExactPhoneLookupAction({ port: ports.exactPhonePort })(formData);
}

export async function requestWalletAdjustmentAction(
  formData: FormData,
): Promise<Readonly<{ auditRecordId: string; ok: true; requestId: string; status: 'PENDING_APPROVAL' }>> {
  const ports = createHttpUserOperationPorts();
  return createWalletAdjustmentRequestAction({
    adjustmentPort: ports.adjustmentPort,
    scopePort: ports.scopePort,
  })(formData);
}

export async function previewWalletAdjustmentAction(formData: FormData) {
  const ports = createHttpUserOperationPorts();
  return createWalletAdjustmentPreviewAction({ adjustmentPort: ports.adjustmentPort, scopePort: ports.scopePort })(formData);
}

export async function previewWalletAdjustmentApprovalAction(formData: FormData) {
  const ports = createHttpUserOperationPorts();
  return createWalletAdjustmentApprovalPreviewAction({ adjustmentPort: ports.adjustmentPort, scopePort: ports.scopePort })(formData);
}

export async function approveWalletAdjustmentAction(formData: FormData) {
  const ports = createHttpUserOperationPorts();
  return createWalletAdjustmentApprovalAction({ adjustmentPort: ports.adjustmentPort, scopePort: ports.scopePort })(formData);
}

export async function requestUsersCsvExportAction(
  formData: FormData,
): Promise<Readonly<{ auditRecordId: string; downloadUrl: string; expiresAt: string; ok: true }>> {
  const ports = createHttpUserOperationPorts();
  return createUserCsvExportAction({ exportPort: ports.exportPort })(formData);
}

export async function requestUserStatusChangeAction(formData: FormData): Promise<Readonly<{ auditRecordId: string; ok: true; requestId: string }>> {
  const ports = createHttpUserOperationPorts();
  return createUserStatusAction({ port: ports.statusPort, scopePort: ports.scopePort })(formData);
}
