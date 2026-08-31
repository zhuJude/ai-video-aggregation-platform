import { PrismaPublicationRepository, type PrismaPublicationClient } from '../adapters/prisma-publication.repository.js';
import {
  OperationsOutboxDispatcher,
  OperationsOutboxJob,
  PrismaOperationsOutboxStore,
  type OperationsEventPublisher,
} from '../adapters/operations-outbox.dispatcher.js';
import { JwksAdminAuthenticator, type AdminTokenVerifier } from '../http/http-auth.adapters.js';
import { OperationsHttpModule } from '../http/operations-http.module.js';
import { PublicationService } from './publication.service.js';
import { createUuidV7Generator } from '../domain/uuid-v7.js';

/** Complete Task 3 production composition; principals enter only through the verified auth adapter. */
export function createOperationsSupportingServices(input: {
  prisma: PrismaPublicationClient & ConstructorParameters<typeof PrismaOperationsOutboxStore>[0];
  eventPublisher: OperationsEventPublisher;
  adminTokenVerifier: AdminTokenVerifier;
  auth: { issuer: string; audience: string };
  trustedIframeOrigins: readonly string[];
  now?: () => Date;
  id?: () => string;
}): {
  publication: PublicationService;
  outbox: OperationsOutboxDispatcher;
  outboxJob: OperationsOutboxJob;
  http: OperationsHttpModule;
} {
  const id = input.id ?? createUuidV7Generator();
  const publication = new PublicationService({
    repository: new PrismaPublicationRepository(input.prisma),
    trustedIframeOrigins: input.trustedIframeOrigins,
    ...(input.now === undefined ? {} : { now: input.now }),
    id,
  });
  const outbox = new OperationsOutboxDispatcher(
    new PrismaOperationsOutboxStore(input.prisma),
    input.eventPublisher,
    input.now,
    id,
  );
  return {
    publication,
    outbox,
    outboxJob: new OperationsOutboxJob(outbox),
    http: new OperationsHttpModule({
      publication,
      adminAuthenticator: new JwksAdminAuthenticator(input.adminTokenVerifier, input.auth),
    }),
  };
}
