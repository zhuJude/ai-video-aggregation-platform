import { createHmac } from 'node:crypto';
import {
  deterministicEventId,
  type CallbackDelivery,
  type MockCallbackBody,
  type MockTaskResponse,
} from './protocol.js';

export function createCallbackDelivery(
  secret: string,
  task: MockTaskResponse,
  sequence: number,
): CallbackDelivery {
  const body: MockCallbackBody = {
    eventId: deterministicEventId(task.providerTaskId, sequence),
    providerTaskId: task.providerTaskId,
    sequence,
    state: task.state,
    occurredAt: `2030-01-01T00:00:0${String(sequence)}.000Z`,
    ...(task.resultUrls === undefined ? {} : { resultUrls: task.resultUrls }),
    ...(task.errorCode === undefined ? {} : { errorCode: task.errorCode }),
    ...(task.errorMessage === undefined ? {} : { errorMessage: task.errorMessage }),
  };
  const rawBody = Buffer.from(JSON.stringify(body));
  const signature = createHmac('sha256', secret).update(rawBody).digest('hex');
  return {
    body,
    rawBody,
    headers: {
      'content-type': 'application/json',
      'x-mock-signature': `sha256=${signature}`,
      'x-provider-event-id': body.eventId,
      'x-provider-sequence': String(body.sequence),
    },
  };
}
