'use server';

import {
  createCompensationApprovalAction,
  createCompensationRequestAction,
  createInvoiceTransitionAction,
  createOrderOperationAction,
} from '../../../lib/finance-operations';
import { createHttpFinanceOperationsPort } from '../../../lib/http-finance-port';
import { domainFormData } from '../../../lib/server-action-form';

export async function createCompensationRequest(form: FormData) {
  await createCompensationRequestAction({ port: createHttpFinanceOperationsPort() })(domainFormData(form));
}

export async function approveCompensationRequest(form: FormData) {
  await createCompensationApprovalAction({ port: createHttpFinanceOperationsPort() })(domainFormData(form));
}

export async function transitionInvoice(form: FormData) {
  await createInvoiceTransitionAction({ port: createHttpFinanceOperationsPort() })(domainFormData(form));
}

export async function executeOrderOperation(form: FormData) {
  await createOrderOperationAction({ port: createHttpFinanceOperationsPort() })(domainFormData(form));
}
