import 'server-only';

import {
  readMockCommercialTask,
  readOrAdvanceMockCommercialTaskEvent,
} from '../studio/mock-commercial-store';
import { isTaskEventCursor } from './identifiers';

export async function createMockTaskPollResponse(
  ownerId: string,
  taskId: string,
): Promise<Response> {
  const detail = await readMockCommercialTask(ownerId, taskId);
  if (!detail) throw new Error('TASK_NOT_FOUND');
  return Response.json(
    { statusSnapshot: detail.statusSnapshot },
    { headers: { 'cache-control': 'no-store, private' } },
  );
}

export async function createMockTaskEventResponse(
  ownerId: string,
  taskId: string,
  lastEventId?: string,
): Promise<Response> {
  if (lastEventId !== undefined && !isTaskEventCursor(lastEventId)) {
    throw new Error('INVALID_TASK_CURSOR');
  }
  const snapshot = await readOrAdvanceMockCommercialTaskEvent(ownerId, taskId, lastEventId);
  if (!snapshot) throw new Error('TASK_NOT_FOUND');
  const body = `id: ${snapshot.eventId}\nevent: task.status\ndata: ${JSON.stringify(snapshot)}\n\n`;
  return new Response(body, {
    headers: {
      'cache-control': 'no-cache, no-store, must-revalidate',
      'content-type': 'text/event-stream; charset=utf-8',
      'x-accel-buffering': 'no',
    },
  });
}
