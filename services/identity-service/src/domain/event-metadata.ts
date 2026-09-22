import { randomBytes } from 'node:crypto';

import { generateUuidV7, isUuidV7 } from './uuid-v7.js';

const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/i;
const EVENT_METADATA_BRAND = new WeakSet<object>();

export interface IngressEventMetadata {
  readonly traceId?: string;
  readonly correlationId?: string;
  readonly causationId?: string;
}

export class EventMetadata {
  readonly traceId: string;
  readonly correlationId: string;
  readonly causationId?: string;

  private constructor(input: { traceId: string; correlationId: string; causationId?: string }) {
    this.traceId = input.traceId;
    this.correlationId = input.correlationId;
    if (input.causationId) this.causationId = input.causationId;
    EVENT_METADATA_BRAND.add(this);
    Object.freeze(this);
  }

  static create(): EventMetadata {
    return new EventMetadata({
      traceId: randomBytes(16).toString('hex'),
      correlationId: generateUuidV7(),
    });
  }

  static fromIngress(input: IngressEventMetadata): EventMetadata {
    const traceId = input.traceId?.trim();
    const correlationId = input.correlationId?.trim();
    const causationId = input.causationId?.trim();
    return new EventMetadata({
      traceId:
        traceId && TRACE_ID_PATTERN.test(traceId)
          ? traceId.toLowerCase()
          : randomBytes(16).toString('hex'),
      correlationId:
        correlationId && isUuidV7(correlationId) ? correlationId.toLowerCase() : generateUuidV7(),
      ...(causationId && isUuidV7(causationId) ? { causationId: causationId.toLowerCase() } : {}),
    });
  }

  static assertTrusted(metadata: EventMetadata): EventMetadata {
    if (!EVENT_METADATA_BRAND.has(metadata)) throw stableError('UNTRUSTED_EVENT_METADATA');
    return metadata;
  }
}

Object.freeze(EventMetadata.prototype);
Object.freeze(EventMetadata);

function stableError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
