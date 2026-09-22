'use server';

import { createHttpModelCapabilityPorts } from '../../../lib/http-model-capability-port';
import {
  createCapabilityAction,
  type CapabilityCommandKind,
  type CapabilityMutationReceipt,
  type CapabilityValidationReceipt,
} from '../../../lib/model-capability-operations';

async function execute(kind: CapabilityCommandKind, source: FormData) {
  const formData = new FormData();
  for (const [key, value] of source.entries()) formData.append(key, value);
  formData.set('kind', kind);
  const ports = createHttpModelCapabilityPorts();
  return createCapabilityAction({ detailPort: ports.detailPort, port: ports.commandPort })(
    formData,
  );
}

export async function validateCapabilityAction(
  formData: FormData,
): Promise<CapabilityValidationReceipt> {
  const receipt = await execute('VALIDATE', formData);
  if (!('valid' in receipt)) throw new Error('模型能力校验回执无效');
  return receipt;
}

export async function saveCapabilityAction(formData: FormData) {
  return execute('SAVE', formData);
}

export async function createCapabilityDraftAction(formData: FormData) {
  return execute('CREATE_DRAFT', formData);
}

export async function publishCapabilityAction(
  formData: FormData,
): Promise<CapabilityMutationReceipt & { status: 'PUBLISHED' }> {
  const receipt = await execute('PUBLISH', formData);
  if (!('status' in receipt) || receipt.status !== 'PUBLISHED')
    throw new Error('模型能力操作回执无效');
  return receipt as CapabilityMutationReceipt & { status: 'PUBLISHED' };
}

export async function rollbackCapabilityAction(
  formData: FormData,
): Promise<CapabilityMutationReceipt & { status: 'PUBLISHED' }> {
  const receipt = await execute('ROLLBACK', formData);
  if (!('status' in receipt) || receipt.status !== 'PUBLISHED')
    throw new Error('模型能力操作回执无效');
  return receipt as CapabilityMutationReceipt & { status: 'PUBLISHED' };
}
