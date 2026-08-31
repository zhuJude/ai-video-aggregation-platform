import type { AliyunOssObjectStore } from '../adapters/aliyun-oss.object-store.js';
import { PinnedResultDownloadTransport } from '../adapters/pinned-result-download.transport.js';
import { PrismaResultImportRepository } from '../adapters/prisma-result-import.repository.js';
import { PrismaAssetLifecycleRepository } from '../adapters/prisma-asset-lifecycle.repository.js';
import { AssetOutboxJob, PrismaOutboxDispatcher, type AssetEventPublisher } from '../adapters/prisma-outbox.dispatcher.js';
import { AssetLifecycleJob } from './lifecycle.job.js';
import { ResultImportService, type ResultOutboxDispatcher } from './result-import.service.js';
import { AssetHttpModule } from '../http/asset-http.module.js';
import {
  JwksUserAuthenticator,
  KmsProviderCallbackAuthenticator,
  PrismaProviderNonceStore,
  PrismaProviderTaskAuthorization,
  ProviderNonceCleanupJob,
  type IdentityTokenVerifier,
  type KmsMacVerifier,
} from '../http/http-auth.adapters.js';

/** Production composition deliberately excludes ObjectStore.copyFromUrl/global fetch. */
export function createResultImportService(input: {
  objectStore: AliyunOssObjectStore;
  prisma: ConstructorParameters<typeof PrismaResultImportRepository>[0];
  outboxKick: ResultOutboxDispatcher;
}): ResultImportService {
  return new ResultImportService({
    objectStore: input.objectStore,
    transport: new PinnedResultDownloadTransport({ sink: input.objectStore }),
    repository: new PrismaResultImportRepository(input.prisma),
    events: input.outboxKick,
  });
}

/** Complete production composition: pinned/private import, durable outbox and both deletion queues. */
export function createAssetSupportingServices(input: {
  objectStore: AliyunOssObjectStore;
  prisma: ConstructorParameters<typeof PrismaResultImportRepository>[0];
  eventPublisher: AssetEventPublisher;
  identityTokenVerifier: IdentityTokenVerifier;
  providerCallbackAuth: {
    providers: Readonly<Record<string, { kmsKeyReference: string }>>;
    macVerifier: KmsMacVerifier;
  };
}): { resultImport: ResultImportService; lifecycle: AssetLifecycleJob; outbox: PrismaOutboxDispatcher; outboxJob: AssetOutboxJob; nonceCleanup: ProviderNonceCleanupJob; http: AssetHttpModule } {
  const outbox = new PrismaOutboxDispatcher(input.prisma, input.eventPublisher);
  const nonceStore = new PrismaProviderNonceStore(input.prisma);
  const resultImport = createResultImportService({ objectStore: input.objectStore, prisma: input.prisma, outboxKick: outbox });
  const lifecycle = new AssetLifecycleJob({
    repository: new PrismaAssetLifecycleRepository(input.prisma),
    objectStore: input.objectStore,
  });
  return {
    outbox,
    outboxJob: new AssetOutboxJob(outbox),
    nonceCleanup: new ProviderNonceCleanupJob(nonceStore),
    resultImport,
    lifecycle,
    http: new AssetHttpModule({
      resultImport,
      lifecycle,
      userAuthenticator: new JwksUserAuthenticator(input.identityTokenVerifier),
      providerCallbackAuthenticator: new KmsProviderCallbackAuthenticator({
        ...input.providerCallbackAuth,
        nonceStore,
      }),
      providerTaskAuthorization: new PrismaProviderTaskAuthorization(input.prisma),
    }),
  };
}
