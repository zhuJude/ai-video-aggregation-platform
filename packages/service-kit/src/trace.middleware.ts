import { randomBytes } from 'node:crypto';
import { HEADERS } from '@repo/contracts/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

export function traceMiddleware(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const incoming = request.headers[HEADERS.traceId];
  const traceId =
    typeof incoming === 'string' && /^[a-f0-9]{32}$/.test(incoming)
      ? incoming
      : randomBytes(16).toString('hex');

  request.headers[HEADERS.traceId] = traceId;
  void reply.header(HEADERS.traceId, traceId);
  return Promise.resolve();
}
