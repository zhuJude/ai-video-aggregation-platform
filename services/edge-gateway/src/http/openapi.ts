const API_ERROR_RESPONSE = {
  content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
  description: 'Stable public error',
} as const;
const USER_SECURITY = [{ UserBearer: [] }];
const ADMIN_SECURITY = [{ AdminBearer: [] }];
const IDEMPOTENCY_PARAMETER = {
  in: 'header',
  name: 'idempotency-key',
  required: true,
  schema: { maxLength: 128, minLength: 16, pattern: '^[\\x21-\\x7E]+$', type: 'string' },
} as const;

export function buildOpenApiDocument(): Record<string, unknown> {
  return {
    components: {
      schemas: {
        ApiError: {
          additionalProperties: false,
          properties: {
            code: { pattern: '^[A-Z][A-Z0-9_]+$', type: 'string' },
            details: { additionalProperties: true, type: 'object' },
            message: { type: 'string' },
            retryable: { type: 'boolean' },
            traceId: { pattern: '^[a-f0-9]{32}$', type: 'string' },
          },
          required: ['code', 'message', 'retryable', 'traceId'],
          type: 'object',
        },
      },
      securitySchemes: {
        AdminBearer: { bearerFormat: 'JWT', scheme: 'bearer', type: 'http' },
        UserBearer: { bearerFormat: 'JWT', scheme: 'bearer', type: 'http' },
      },
    },
    info: { title: 'AI Video Aggregation Edge Gateway', version: '1.0.0' },
    openapi: '3.1.0',
    paths: {
      '/admin/v1/overview': {
        get: {
          operationId: 'getAdminOverview',
          responses: { '200': { description: 'Admin overview' }, default: API_ERROR_RESPONSE },
          security: ADMIN_SECURITY,
        },
      },
      '/admin/v1/wallet/adjustments': {
        post: {
          operationId: 'createWalletAdjustment',
          parameters: [IDEMPOTENCY_PARAMETER],
          responses: {
            '202': { description: 'Adjustment submitted' },
            default: API_ERROR_RESPONSE,
          },
          security: ADMIN_SECURITY,
        },
      },
      '/v1/dashboard': {
        get: {
          operationId: 'getUserDashboard',
          responses: { '200': { description: 'User dashboard' }, default: API_ERROR_RESPONSE },
          security: USER_SECURITY,
        },
      },
      '/v1/models': {
        get: {
          operationId: 'listModels',
          responses: { '200': { description: 'Model catalog' }, default: API_ERROR_RESPONSE },
          security: USER_SECURITY,
        },
      },
      '/v1/tasks': {
        post: {
          operationId: 'createTask',
          parameters: [IDEMPOTENCY_PARAMETER],
          responses: { '202': { description: 'Task accepted' }, default: API_ERROR_RESPONSE },
          security: USER_SECURITY,
        },
      },
      '/v1/tasks/{taskId}/events': {
        get: {
          operationId: 'streamTaskEvents',
          parameters: [
            {
              in: 'path',
              name: 'taskId',
              required: true,
              schema: { format: 'uuid', type: 'string' },
            },
            { in: 'header', name: 'Last-Event-ID', required: false, schema: { type: 'string' } },
          ],
          responses: {
            '200': {
              content: { 'text/event-stream': { schema: { type: 'string' } } },
              description: 'Authorized task status event stream',
            },
            default: API_ERROR_RESPONSE,
          },
          security: USER_SECURITY,
        },
      },
    },
  };
}
