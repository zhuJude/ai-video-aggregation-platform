'use server';

import {
  createAuditExportAction,
  createAdminUpdateAction,
  createContentDraftAction,
  createContentPublicationAction,
  createContentValidationAction,
  createRoleUpdateAction,
  createSystemMutationAction,
  createTicketMessageAction,
  createTicketTransitionAction,
} from '../../lib/governance-operations';
import { createHttpGovernanceOperationsPort } from '../../lib/http-governance-port';
import { domainFormData } from '../../lib/server-action-form';

export async function operateContent(form: FormData) {
  await createContentPublicationAction({ port: createHttpGovernanceOperationsPort() })(domainFormData(form));
}

export async function saveContentDraft(form: FormData) {
  await createContentDraftAction({ port: createHttpGovernanceOperationsPort() })(domainFormData(form));
}

export async function validateContentDraft(form: FormData) {
  await createContentValidationAction({ port: createHttpGovernanceOperationsPort() })(domainFormData(form));
}

export async function addTicketMessage(form: FormData) {
  await createTicketMessageAction({ port: createHttpGovernanceOperationsPort() })(domainFormData(form));
}

export async function transitionTicket(form: FormData) {
  await createTicketTransitionAction({ port: createHttpGovernanceOperationsPort() })(domainFormData(form));
}

export async function updateRole(form: FormData) {
  await createRoleUpdateAction({ port: createHttpGovernanceOperationsPort() })(domainFormData(form));
}

export async function updateAdmin(form: FormData) {
  await createAdminUpdateAction({ port: createHttpGovernanceOperationsPort() })(domainFormData(form));
}

export async function exportAudit(form: FormData) {
  await createAuditExportAction({ port: createHttpGovernanceOperationsPort() })(domainFormData(form));
}

export async function operateSystem(form: FormData) {
  await createSystemMutationAction({ port: createHttpGovernanceOperationsPort() })(domainFormData(form));
}
