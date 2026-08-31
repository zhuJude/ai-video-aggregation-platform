import { types as utilTypes } from 'node:util';

import { createTraceId, isTraceId } from './trace-id';
import { createUuidV7, isUuidV7 } from './uuid-v7';

declare const outboundRequestContextBrand: unique symbol;

export type OutboundRequestContext = Readonly<{
  correlationId: string;
  traceId: string;
  [outboundRequestContextBrand]: true;
}>;

const issuedOutboundRequestContexts = new WeakSet<object>();

function readExactDataProperty(
  value: object,
  key: 'correlationId' | 'traceId',
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor && descriptor.enumerable
    ? descriptor.value
    : undefined;
}

export function parseOutboundRequestContext(value: unknown): OutboundRequestContext {
  try {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      utilTypes.isProxy(value)
    ) {
      throw new Error('invalid shape');
    }
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('invalid prototype');
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== 2 ||
      !keys.includes('correlationId') ||
      !keys.includes('traceId')
    ) {
      throw new Error('invalid keys');
    }
    const correlationId = readExactDataProperty(value, 'correlationId');
    const traceId = readExactDataProperty(value, 'traceId');
    if (!isTraceId(traceId) || !isUuidV7(correlationId)) {
      throw new Error('invalid values');
    }
    const snapshot = Object.freeze({ correlationId, traceId });
    issuedOutboundRequestContexts.add(snapshot);
    return snapshot as OutboundRequestContext;
  } catch {
    throw new Error('出站请求上下文无效');
  }
}

export function isOutboundRequestContext(value: unknown): value is OutboundRequestContext {
  return Boolean(
    value &&
    typeof value === 'object' &&
    issuedOutboundRequestContexts.has(value),
  );
}

export function createOutboundRequestContext(
  makeTraceId: () => string = createTraceId,
  makeCorrelationId: () => string = createUuidV7,
): OutboundRequestContext {
  return parseOutboundRequestContext({
    correlationId: makeCorrelationId(),
    traceId: makeTraceId(),
  });
}
