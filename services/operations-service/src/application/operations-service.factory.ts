import { PrismaPublicationRepository, type PrismaPublicationClient } from '../adapters/prisma-publication.repository.js';
import { PrismaTicketRepository, type PrismaTicketClient } from '../adapters/prisma-ticket.repository.js';
import {
  OperationsOutboxDispatcher,
  OperationsOutboxJob,
  PrismaOperationsOutboxStore,
  type OperationsEventPublisher,
} from '../adapters/operations-outbox.dispatcher.js';
import { JwksAdminAuthenticator, JwksUserAuthenticator, type AdminTokenVerifier, type UserTokenVerifier } from '../http/http-auth.adapters.js';
import { OperationsHttpModule } from '../http/operations-http.module.js';
import { PublicationService } from './publication.service.js';
import { createUuidV7Generator } from '../domain/uuid-v7.js';
import { SecureAttachmentAuthorization, TicketService, type AttachmentAuthorizationGateway, type FeedbackSubjectAuthorizationPort } from './ticket.service.js';

/** Production composition; principals enter only through verified raw-token auth adapters. */
export function createOperationsSupportingServices(input: {
  prisma: PrismaPublicationClient & PrismaTicketClient & ConstructorParameters<typeof PrismaOperationsOutboxStore>[0];
  eventPublisher: OperationsEventPublisher;
  adminTokenVerifier: AdminTokenVerifier;
  userTokenVerifier: UserTokenVerifier;
  assetAuthorizationGateway: AttachmentAuthorizationGateway;
  feedbackSubjectAuthorization: FeedbackSubjectAuthorizationPort;
  auth: { issuer: string; audience: string };
  trustedIframeOrigins: readonly string[];
  now?: () => Date;
  id?: () => string;
}): {
  publication: PublicationService;
  ticket: TicketService;
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
  const ticket = new TicketService({
    repository: new PrismaTicketRepository(input.prisma),
    attachmentAuthorization: new SecureAttachmentAuthorization(input.assetAuthorizationGateway),
    feedbackSubjectAuthorization: input.feedbackSubjectAuthorization,
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
    ticket,
    outbox,
    outboxJob: new OperationsOutboxJob(outbox),
    http: new OperationsHttpModule({
      publication,
      ticket,
      userAuthenticator: new JwksUserAuthenticator(input.userTokenVerifier, input.auth),
      adminAuthenticator: new JwksAdminAuthenticator(input.adminTokenVerifier, input.auth),
    }),
  };
}
