'use server';

import { createHttpOperationsPorts } from '../../../lib/http-operations-port';
import {
  createQueueAction,
  createTaskAction,
  loadTaskRawView,
} from '../../../lib/operations-server';

export async function executeQueueAction(form: FormData) {
  await createQueueAction({ port: createHttpOperationsPorts().tasks })(form);
}

export async function executeTaskAction(form: FormData) {
  await createTaskAction({ port: createHttpOperationsPorts().tasks })(form);
}
export async function loadTaskRawAction(taskId: string) {
  return loadTaskRawView({ port: createHttpOperationsPorts().tasks, taskId });
}
