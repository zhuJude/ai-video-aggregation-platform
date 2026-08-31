import { HEADERS } from '@repo/contracts/common';

export interface RawTaskStreamEvent {
  readonly data: unknown;
  readonly eventId: string;
  readonly eventType: 'message' | 'task.status' | 'task-transition';
}

export interface TaskEventStreamOptions {
  readonly lastEventId?: string;
  readonly onEvent: (event: RawTaskStreamEvent) => void;
  readonly signal: AbortSignal;
}

function gatewayUrl(path: `/v1/${string}`): string {
  const configuredGateway = process.env.NEXT_PUBLIC_GATEWAY_URL?.trim();
  const browserOrigin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
  return new URL(path, configuredGateway || browserOrigin).toString();
}

function traceId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

function consumeFrame(frame: string, onEvent: TaskEventStreamOptions['onEvent']): void {
  const lines = frame.split('\n');
  let eventName = 'message';
  let eventId = '';
  const data: string[] = [];
  for (const line of lines) {
    if (line === '' || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') eventName = value;
    else if (field === 'id') {
      if (value.includes('\0')) throw new Error('INVALID_TASK_EVENT_ID');
      eventId = value;
    } else if (field === 'data') data.push(value);
  }
  if (data.length === 0) return;
  if (eventName !== 'message' && eventName !== 'task.status' && eventName !== 'task-transition') {
    throw new Error('INVALID_TASK_EVENT_TYPE');
  }
  if (!eventId) throw new Error('MISSING_TASK_EVENT_ID');
  let payload: unknown;
  try {
    payload = JSON.parse(data.join('\n')) as unknown;
  } catch {
    throw new Error('INVALID_TASK_EVENT_JSON');
  }
  onEvent({ data: payload, eventId, eventType: eventName });
}

export async function openTaskEventStream(
  taskId: string,
  options: TaskEventStreamOptions,
): Promise<void> {
  const headers = new Headers({ accept: 'text/event-stream' });
  headers.set(HEADERS.traceId, traceId());
  headers.set(HEADERS.correlationId, crypto.randomUUID());
  if (options.lastEventId) headers.set('Last-Event-ID', options.lastEventId);
  const response = await fetch(gatewayUrl(`/v1/tasks/${encodeURIComponent(taskId)}/events`), {
    credentials: 'include',
    headers,
    method: 'GET',
    signal: options.signal,
  });
  if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) {
    throw new Error('TASK_EVENT_STREAM_UNAVAILABLE');
  }
  if (!response.body) throw new Error('TASK_EVENT_STREAM_MISSING_BODY');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let completed = false;
  try {
    while (!options.signal.aborted) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      buffer = buffer.replace(/\r\n/g, '\n');
      buffer = chunk.done ? buffer.replace(/\r/g, '\n') : buffer.replace(/\r(?=.)/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        consumeFrame(buffer.slice(0, boundary), options.onEvent);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');
      }
      if (chunk.done) {
        completed = true;
        break;
      }
    }
    if (buffer.trim()) consumeFrame(buffer, options.onEvent);
    if (!options.signal.aborted) throw new Error('TASK_EVENT_STREAM_CLOSED');
  } finally {
    if (!completed) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
}
