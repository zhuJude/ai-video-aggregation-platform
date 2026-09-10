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

export async function operateContent(form: FormData) {
  await createContentPublicationAction({ port: createHttpGovernanceOperationsPort() })(form);
}

export async function saveContentDraft(form: FormData) {
  await createContentDraftAction({ port: createHttpGovernanceOperationsPort() })(form);
}

export async function validateContentDraft(form: FormData) {
  await createContentValidationAction({ port: createHttpGovernanceOperationsPort() })(form);
}

export async function addTicketMessage(form: FormData) {
  await createTicketMessageAction({ port: createHttpGovernanceOperationsPort() })(form);
}

export async function transitionTicket(form: FormData) {
  await createTicketTransitionAction({ port: createHttpGovernanceOperationsPort() })(form);
}

export async function updateRole(form: FormData) {
  await createRoleUpdateAction({ port: createHttpGovernanceOperationsPort() })(form);
}

export async function updateAdmin(form: FormData) {
  await createAdminUpdateAction({ port: createHttpGovernanceOperationsPort() })(form);
}

export async function exportAudit(form: FormData) {
  await createAuditExportAction({ port: createHttpGovernanceOperationsPort() })(form);
}

export async function operateSystem(form: FormData) {
  await createSystemMutationAction({ port: createHttpGovernanceOperationsPort() })(form);
}
