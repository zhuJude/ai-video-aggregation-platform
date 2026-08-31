import { propagation, trace } from '@opentelemetry/api';
import {
  CompositePropagator,
  ExportResultCode,
  W3CTraceContextPropagator,
} from '@opentelemetry/core';
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  ConsoleSpanExporter,
  type ReadableSpan,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base';

const TRACE_PARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

export interface TraceContext {
  traceId: string;
  spanId: string;
  traceFlags?: string;
  correlationId: string;
}

export type TraceHeaders = Record<string, string | string[] | undefined>;

export interface TracingOptions {
  service: string;
  environment: string;
  version: string;
  otlpEndpoint?: string;
  fetchImplementation?: typeof fetch;
}

function header(headers: TraceHeaders, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export function injectTraceContext(headers: TraceHeaders, context: TraceContext): void {
  const flags = context.traceFlags ?? '01';
  if (
    !/^[0-9a-f]{32}$/.test(context.traceId) ||
    /^0+$/.test(context.traceId) ||
    !/^[0-9a-f]{16}$/.test(context.spanId) ||
    /^0+$/.test(context.spanId) ||
    !/^[0-9a-f]{2}$/.test(flags)
  ) {
    throw new Error('Invalid W3C trace context');
  }
  headers.traceparent = `00-${context.traceId}-${context.spanId}-${flags}`;
  headers['x-correlation-id'] = context.correlationId;
}

export function extractTraceContext(headers: TraceHeaders): Required<TraceContext> | undefined {
  const traceparent = header(headers, 'traceparent');
  const correlationId = header(headers, 'x-correlation-id');
  if (traceparent === undefined || correlationId === undefined) return undefined;
  const match = TRACE_PARENT.exec(traceparent);
  if (
    match === null ||
    match[1] === undefined ||
    match[2] === undefined ||
    match[3] === undefined
  ) {
    return undefined;
  }
  if (/^0+$/.test(match[1]) || /^0+$/.test(match[2])) return undefined;
  return { traceId: match[1], spanId: match[2], traceFlags: match[3], correlationId };
}

class OtlpJsonHttpExporter implements SpanExporter {
  private readonly fetchImplementation: typeof fetch;

  constructor(
    private readonly endpoint: string,
    private readonly resource: Record<string, string>,
    fetchImplementation?: typeof fetch,
  ) {
    this.fetchImplementation = fetchImplementation ?? fetch;
  }

  export(
    spans: ReadableSpan[],
    resultCallback: (result: { code: ExportResultCode }) => void,
  ): void {
    const body = {
      resourceSpans: [
        {
          resource: {
            attributes: Object.entries(this.resource).map(([key, value]) => ({
              key,
              value: { stringValue: value },
            })),
          },
          scopeSpans: [
            {
              scope: { name: 'repo-observability' },
              spans: spans.map((span) => ({
                traceId: span.spanContext().traceId,
                spanId: span.spanContext().spanId,
                name: span.name,
                kind: span.kind,
                startTimeUnixNano: String(
                  BigInt(span.startTime[0]) * 1_000_000_000n + BigInt(span.startTime[1]),
                ),
                endTimeUnixNano: String(
                  BigInt(span.endTime[0]) * 1_000_000_000n + BigInt(span.endTime[1]),
                ),
                attributes: Object.entries(span.attributes).map(([key, value]) => ({
                  key,
                  value: { stringValue: String(value) },
                })),
                status: span.status,
              })),
            },
          ],
        },
      ],
    };
    void this.fetchImplementation(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    })
      .then((response) => {
        resultCallback({ code: response.ok ? ExportResultCode.SUCCESS : ExportResultCode.FAILED });
      })
      .catch(() => {
        resultCallback({ code: ExportResultCode.FAILED });
      });
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

export function initializeTracing(options: TracingOptions): {
  tracer: ReturnType<typeof trace.getTracer>;
  shutdown: () => Promise<void>;
} {
  const exporter: SpanExporter =
    options.otlpEndpoint === undefined
      ? new ConsoleSpanExporter()
      : new OtlpJsonHttpExporter(
          options.otlpEndpoint,
          {
            'service.name': options.service,
            'service.version': options.version,
            'deployment.environment.name': options.environment,
          },
          options.fetchImplementation,
        );
  const provider = new BasicTracerProvider({
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });
  trace.setGlobalTracerProvider(provider);
  propagation.setGlobalPropagator(
    new CompositePropagator({ propagators: [new W3CTraceContextPropagator()] }),
  );
  return {
    tracer: trace.getTracer(options.service, options.version),
    shutdown: () => provider.shutdown(),
  };
}
