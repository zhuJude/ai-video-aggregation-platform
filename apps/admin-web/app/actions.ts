'use server';

import { createHttpUserOperationPorts } from '../lib/http-user-operation-port';
import { createRefreshUserAction } from '../lib/protected-user-action';

export async function refreshUserAction(
  formData: FormData,
): Promise<Readonly<{ ok: true }>> {
  const ports = createHttpUserOperationPorts();
  const action = createRefreshUserAction(ports);
  return action(formData);
}
