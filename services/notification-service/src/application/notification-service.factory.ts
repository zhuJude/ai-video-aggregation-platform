import {
  AliyunSmsSender,
  KmsRamRoleCredentialResolver,
  createAliyunSdkSmsClient,
  type AliyunSmsConfig,
  type KmsSecretResolver,
  type RamRoleSessionIssuer,
} from '../adapters/aliyun-sms.sender.js';
import {
  KmsPhoneProtector,
  PrismaNotificationRepository,
  type KmsDataKeyResolver,
  type PrismaNotificationClient,
} from '../adapters/prisma-notification.repository.js';
import { JwksUserAuthenticator, type UserTokenVerifier } from '../http/http-auth.adapter.js';
import { NotificationHttpModule } from '../http/notification-http.module.js';
import { createUuidV7Generator } from '../domain/uuid-v7.js';
import {
  NotificationConsumer,
  NotificationService,
  NotificationWorker,
  NotificationWorkerRunner,
  TemplateService,
} from './notification.consumer.js';

/** Production composition has no environment-driven or development credential fallback. */
export async function createNotificationServices(input: {
  prisma: PrismaNotificationClient;
  kms: KmsDataKeyResolver;
  phoneKmsReference: string;
  smsCredentialKms: KmsSecretResolver;
  ramRoleIssuer: RamRoleSessionIssuer;
  smsConfig: AliyunSmsConfig;
  userTokenVerifier: UserTokenVerifier;
  auth: { issuer: string; audience: string };
  now?: () => Date;
  id?: () => string;
  metrics?: {
    smsRetry(reason: 'transient' | 'unknown_acceptance' | 'receipt_pending'): void;
  };
}): Promise<{
  templates: TemplateService;
  service: NotificationService;
  worker: NotificationWorker;
  workerRunner: NotificationWorkerRunner;
  consumer: NotificationConsumer;
  http: NotificationHttpModule;
  smsHealth: { ping(): Promise<void> };
}> {
  const now = input.now ?? (() => new Date());
  const id = input.id ?? createUuidV7Generator();
  const repository = new PrismaNotificationRepository(
    input.prisma,
    new KmsPhoneProtector(input.phoneKmsReference, input.kms),
  );
  const templates = new TemplateService(repository, id, now);
  const smsClient = await createAliyunSdkSmsClient(
    input.smsConfig,
    new KmsRamRoleCredentialResolver(input.smsCredentialKms, input.ramRoleIssuer),
    { now },
  );
  const worker = new NotificationWorker(
    repository,
    new AliyunSmsSender(smsClient, input.smsConfig, () => undefined, now),
    { id, now, ...(input.metrics === undefined ? {} : { metrics: input.metrics }) },
  );
  const service = new NotificationService(repository, now);
  return {
    templates,
    service,
    worker,
    workerRunner: new NotificationWorkerRunner(worker),
    consumer: new NotificationConsumer(repository, templates, worker, { id, now }),
    smsHealth: {
      async ping() {
        if (smsClient.ping === undefined) throw new Error('ALIYUN_SMS_PROBE_UNAVAILABLE');
        await smsClient.ping();
      },
    },
    http: new NotificationHttpModule({
      service,
      userAuthenticator: new JwksUserAuthenticator(input.userTokenVerifier, input.auth),
    }),
  };
}
