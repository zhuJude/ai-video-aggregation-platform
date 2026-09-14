import { describe, expect, it } from 'vitest';
import { SecureAttachmentAuthorization, type AttachmentAuthorizationGateway } from '../src/application/ticket.service.js';

const USER = '01990f24-2ba2-7000-8000-000000000001';
const OTHER = '01990f24-2ba2-7000-8000-000000000002';
const ASSET = '01990f24-2ba2-7000-8000-000000000003';
const SESSION = '01990f24-2ba2-7000-8000-000000000004';
const NOW = new Date('2026-09-01T00:00:00.000Z');
const HASH = 'a'.repeat(64);
const TOKEN = 'ownership-token-0001';
const REMOTE_OPERATION = '01990f24-2ba2-7000-8000-000000000005';
const FENCE = '01990f24-2ba2-7000-8000-000000000006';

describe('production attachment authorization', () => {
  it('accepts an available asset only after a server-side owner lookup', async () => {
    let reserved = false;
    const gateway: AttachmentAuthorizationGateway = {
      findAvailableAsset: () => Promise.resolve({ id: ASSET, ownerId: USER }),
      reserveSupportUploadSession: () => { reserved = true; return Promise.resolve({ outcome: 'NOT_FOUND' }); },
      finalizeSupportUploadSession: () => Promise.resolve(), releaseSupportUploadSession: () => Promise.resolve(), lookupSupportUploadReservation: () => Promise.resolve(null),
    };
    await expect(new SecureAttachmentAuthorization(gateway).reserve({ operationId: 'op', remoteOperationId: REMOTE_OPERATION, generation: 0, fence: FENCE, requestHash: HASH, idempotencyKey: 'key', assetId: ASSET, ownerId: USER, now: NOW })).resolves.toBeNull();
    expect(reserved).toBe(false);
  });

  it('atomically consumes and validates a restricted support session for a non-owned asset', async () => {
    const lifecycle: unknown[] = [];
    const gateway: AttachmentAuthorizationGateway = {
      findAvailableAsset: () => Promise.resolve({ id: ASSET, ownerId: OTHER }),
      reserveSupportUploadSession: (input) => Promise.resolve({ outcome: 'RESERVED', reservation: { id: SESSION, operationId: input.operationId, remoteOperationId: input.remoteOperationId, generation: input.generation, fence: input.fence, requestHash: input.requestHash, ownershipToken: TOKEN, sessionId: input.sessionId, assetId: input.assetId, ownerId: input.ownerId, purpose: 'SUPPORT_TICKET', expiresAt: new Date('2026-09-01T00:15:00.000Z') } }),
      finalizeSupportUploadSession: (input) => { lifecycle.push(input); return Promise.resolve(); }, releaseSupportUploadSession: (input) => { lifecycle.push(input); return Promise.resolve(); }, lookupSupportUploadReservation: () => Promise.resolve(null),
    };
    const authorization = new SecureAttachmentAuthorization(gateway);
    const reservation = await authorization.reserve({ operationId: 'op', remoteOperationId: REMOTE_OPERATION, generation: 0, fence: FENCE, requestHash: HASH, idempotencyKey: 'key', assetId: ASSET, ownerId: USER, supportUploadSessionId: SESSION, now: NOW });
    expect(reservation).toMatchObject({ sessionId: SESSION, operationId: 'op', requestHash: HASH, ownershipToken: TOKEN });
    if (reservation === null) throw new Error('expected reservation');
    await authorization.finalize(reservation);
    await authorization.release(reservation);
    expect(lifecycle).toEqual([
      { operationId: 'op', remoteOperationId: REMOTE_OPERATION, generation: 0, fence: FENCE, requestHash: HASH, ownershipToken: TOKEN },
      { operationId: 'op', remoteOperationId: REMOTE_OPERATION, generation: 0, fence: FENCE, requestHash: HASH, ownershipToken: TOKEN },
    ]);
  });

  it.each([
    ['USED', 'SUPPORT_UPLOAD_SESSION_USED'],
    ['EXPIRED', 'SUPPORT_UPLOAD_SESSION_EXPIRED'],
    ['NOT_FOUND', 'ATTACHMENT_NOT_AUTHORIZED'],
  ] as const)('maps atomic session outcome %s to %s', async (outcome, code) => {
    const gateway: AttachmentAuthorizationGateway = {
      findAvailableAsset: () => Promise.resolve({ id: ASSET, ownerId: OTHER }),
      reserveSupportUploadSession: () => Promise.resolve({ outcome }),
      finalizeSupportUploadSession: () => Promise.resolve(), releaseSupportUploadSession: () => Promise.resolve(), lookupSupportUploadReservation: () => Promise.resolve(null),
    };
    await expect(new SecureAttachmentAuthorization(gateway).reserve({ operationId: 'op', remoteOperationId: REMOTE_OPERATION, generation: 0, fence: FENCE, requestHash: HASH, idempotencyKey: 'key', assetId: ASSET, ownerId: USER, supportUploadSessionId: SESSION, now: NOW })).rejects.toMatchObject({ code });
  });

  it('returns the opaque reservation so the service can persist it before validation', async () => {
    const gateway: AttachmentAuthorizationGateway = {
      findAvailableAsset: () => Promise.resolve({ id: ASSET, ownerId: OTHER }),
      reserveSupportUploadSession: () => Promise.resolve({ outcome: 'RESERVED', reservation: { id: SESSION, operationId: 'op', remoteOperationId: REMOTE_OPERATION, generation: 0, fence: FENCE, requestHash: 'b'.repeat(64), ownershipToken: TOKEN, sessionId: SESSION, assetId: ASSET, ownerId: OTHER, purpose: 'GENERAL_UPLOAD', expiresAt: new Date('2026-08-31T23:59:59.999Z') } }),
      finalizeSupportUploadSession: () => Promise.resolve(), releaseSupportUploadSession: () => Promise.resolve(), lookupSupportUploadReservation: () => Promise.resolve(null),
    };
    await expect(new SecureAttachmentAuthorization(gateway).reserve({ operationId: 'op', remoteOperationId: REMOTE_OPERATION, generation: 0, fence: FENCE, requestHash: HASH, idempotencyKey: 'key', assetId: ASSET, ownerId: USER, supportUploadSessionId: SESSION, now: NOW })).resolves.toMatchObject({ ownerId: OTHER, purpose: 'GENERAL_UPLOAD' });
  });
});
