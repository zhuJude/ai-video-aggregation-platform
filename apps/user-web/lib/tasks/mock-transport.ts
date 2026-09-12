import 'server-only';

import { taskGateway } from './gateway';
import { parseTaskDetail } from './runtime';

export async function createMockTaskPollResponse(
  ownerId: string,
  taskId: string,
): Promise<Response> {
  const detail = parseTaskDetail(await taskGateway.getTask(taskId, { ownerId }));
  return Response.json(
    { statusSnapshot: detail.statusSnapshot },
    { headers: { 'cache-control': 'no-store, private' } },
  );
}

export async function createMockTaskEventResponse(
  ownerId: string,
  taskId: string,
): Promise<Response> {
  const detail = parseTaskDetail(await taskGateway.getTask(taskId, { ownerId }));
  const snapshot = detail.statusSnapshot;
  const body = `id: ${snapshot.eventId}\nevent: task.status\ndata: ${JSON.stringify(snapshot)}\n\n`;
  return new Response(body, {
    headers: {
      'cache-control': 'no-cache, no-store, must-revalidate',
      'content-type': 'text/event-stream; charset=utf-8',
      'x-accel-buffering': 'no',
    },
  });
}
