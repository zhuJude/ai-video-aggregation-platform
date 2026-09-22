const TRACE_ID = /^[0-9a-f]{32}$/u;

export function isTraceId(value: unknown): value is string {
  return typeof value === 'string' && TRACE_ID.test(value);
}

export function createTraceId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}
