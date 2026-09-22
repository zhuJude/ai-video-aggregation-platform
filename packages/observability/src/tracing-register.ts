import { initializeTracing } from './tracing.js';

const service = process.env.OTEL_SERVICE_NAME ?? 'unknown-service';
const environment = process.env.DEPLOYMENT_ENVIRONMENT ?? 'local';
const version = process.env.SERVICE_VERSION ?? 'development';
const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;

export const registeredTracing = initializeTracing({
  service,
  environment,
  version,
  ...(otlpEndpoint === undefined ? {} : { otlpEndpoint }),
});
