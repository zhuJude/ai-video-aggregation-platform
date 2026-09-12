import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

const host = '127.0.0.1';
const port = 4310;
const refreshToken = 'R'.repeat(43);
const sessionId = '0198f4d4-21c2-7b7d-8a03-08a0da2a6e11';

function json(
  response: ServerResponse,
  status: number,
  responseBody: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  response.end(JSON.stringify(responseBody));
}

async function requestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('INVALID_REQUEST_BODY');
  }
  return value as Record<string, unknown>;
}

function accessToken(sid = sessionId): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'ES256', typ: 'JWT' })}.${encode({
    aud: 'user-web',
    exp: Math.floor(Date.now() / 1_000) + 900,
    iss: 'identity-service',
    sid,
    sub: 'untrusted-e2e-subject',
  })}.deterministic-gateway-signature`;
}

const server = createServer((request, response) => {
  void (async () => {
    try {
      if (request.method === 'GET' && request.url === '/health/live') {
        json(response, 200, { status: 'ok' });
        return;
      }
      if (request.method === 'GET' && request.url === '/health/ready') {
        json(response, 200, { ok: true, checks: { bootstrap: true } });
        return;
      }
      if (request.method === 'POST' && request.url === '/v1/auth/sms/request') {
        const payload = await requestBody(request);
        if (!/^1\d{10}$/.test(String(payload.phone)) || typeof payload.deviceId !== 'string') {
          json(response, 400, { code: 'INVALID_REQUEST' });
          return;
        }
        json(response, 202, { accepted: true }, { 'retry-after': '60' });
        return;
      }
      if (request.method === 'POST' && request.url === '/v1/auth/sms/verify') {
        const payload = await requestBody(request);
        if (payload.phone !== '13800138000' || payload.code !== '123456') {
          json(response, 400, {
            code: 'INVALID_SMS_CODE',
            message: '验证码无效',
            retryable: false,
            traceId: 'a'.repeat(32),
          });
          return;
        }
        json(
          response,
          200,
          { accessToken: accessToken(), sessionId },
          {
            'set-cookie': `refresh_token=${refreshToken}; Path=/auth/refresh; HttpOnly; Secure; SameSite=Lax`,
          },
        );
        return;
      }
      if (request.method === 'POST' && request.url === '/v1/auth/refresh') {
        json(
          response,
          200,
          { accessToken: accessToken(), sessionId },
          {
            'set-cookie': `refresh_token=${refreshToken}; Path=/auth/refresh; HttpOnly; Secure; SameSite=Lax`,
          },
        );
        return;
      }
      if (request.method === 'GET' && request.url === '/v1/sessions') {
        json(response, 200, [
          {
            id: sessionId,
            deviceName: 'Playwright Chromium',
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 900_000).toISOString(),
          },
        ]);
        return;
      }
      json(response, 404, { code: 'NOT_FOUND' });
    } catch {
      json(response, 400, { code: 'INVALID_REQUEST' });
    }
  })();
});

server.listen(port, host, () => process.stdout.write(`mock gateway ${host}:${String(port)}\n`));
