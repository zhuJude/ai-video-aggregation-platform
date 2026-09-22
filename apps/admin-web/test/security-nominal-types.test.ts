import { describe, expectTypeOf, it } from 'vitest';

import {
  createOutboundRequestContext,
  type OutboundRequestContext,
} from '../lib/outbound-request-context';
import {
  createSafeTelemetryEvent,
  type SafeTelemetryEvent,
  type SafeTelemetryPort,
} from '../lib/safe-telemetry';

describe('nominal security boundary types', () => {
  it('permits only factory-produced request contexts and telemetry events', () => {
    const plainContext = {
      correlationId: '0198f7a4-c6d9-7b39-8a4e-73af0c1d2e3f',
      traceId: '0123456789abcdef0123456789abcdef',
    };
    const aliasedContext = { ...plainContext, secret: 'must-not-pass' };

    // @ts-expect-error A structural plain object is not an outbound request context.
    const rejectedPlainContext: OutboundRequestContext = plainContext;
    // @ts-expect-error Extra fields hidden behind an alias cannot satisfy the nominal type.
    const rejectedAliasedContext: OutboundRequestContext = aliasedContext;

    const context: OutboundRequestContext = createOutboundRequestContext(
      () => plainContext.traceId,
      () => plainContext.correlationId,
    );
    const plainEvent = {
      ...plainContext,
      operation: 'overview.read' as const,
      reason: 'UPSTREAM_FAILURE' as const,
    };

    // @ts-expect-error A structural event cannot be sent to a safe telemetry sink.
    const rejectedPlainEvent: SafeTelemetryEvent = plainEvent;
    const sink: SafeTelemetryPort = { record() {} };
    // @ts-expect-error A safe telemetry sink accepts only factory-produced events.
    sink.record(plainEvent);
    const event: SafeTelemetryEvent = createSafeTelemetryEvent(
      'overview.read',
      'UPSTREAM_FAILURE',
      context,
    );

    expectTypeOf(rejectedPlainContext).toExtend<
      Readonly<{ correlationId: string; traceId: string }>
    >();
    expectTypeOf(rejectedAliasedContext).toExtend<
      Readonly<{ correlationId: string; traceId: string }>
    >();
    expectTypeOf(context).toEqualTypeOf<OutboundRequestContext>();
    expectTypeOf(rejectedPlainEvent).toExtend<Readonly<{ operation: string; reason: string }>>();
    expectTypeOf(event).toEqualTypeOf<SafeTelemetryEvent>();
  });
});
