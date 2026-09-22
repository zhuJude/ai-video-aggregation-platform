import type { ArgumentsHost } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import {
  IAM_HTTP_STABLE_STATUS_CODES,
  IamHttpExceptionFilter,
} from '../src/http/iam-http-exception.filter.js';

const STATUS_CODES = {
  400: [
    'INVALID_REQUEST',
    'INVALID_ADMIN_ID',
    'INVALID_ADMIN_SESSION_ID',
    'INVALID_ADMIN_SESSION_FAMILY_ID',
    'INVALID_MFA_CHALLENGE_ID',
    'INVALID_RECOVERY_CODE_ID',
    'INVALID_RECOVERY_GENERATION_ID',
    'INVALID_AUDIT_ACTOR_ID',
    'INVALID_AUDIT_CAUSATION_ID',
    'INVALID_AUDIT_CONTEXT',
    'INVALID_AUDIT_CORRELATION_ID',
    'INVALID_AUDIT_ID',
    'INVALID_AUDIT_QUERY',
    'INVALID_AUDIT_TRACE_ID',
    'INVALID_DATA_SCOPE',
    'INVALID_DEVICE_NAME',
    'INVALID_PASSWORD',
    'INVALID_PERMISSION_KEYS',
    'INVALID_ROLE_DESCRIPTION',
    'INVALID_ROLE_ID',
    'INVALID_ROLE_NAME',
    'INVALID_ROLE_QUERY',
    'INVALID_ROLE_VERSION',
    'INVALID_UUID_V7',
    'INVALID_UUID_V7_TIMESTAMP',
    'INVALID_PENDING_CLEANUP_LIMIT',
    'ROLE_ASSIGNMENT_PRECONDITION_REQUIRED',
  ],
  401: [
    'INVALID_ADMIN_ACCESS_TOKEN',
    'ADMIN_ACCESS_SESSION_INACTIVE',
    'INVALID_ADMIN_PRINCIPAL',
    'UNTRUSTED_ADMIN_PRINCIPAL',
    'INVALID_BOOTSTRAP_PROOF',
    'INVALID_CREDENTIALS',
    'INVALID_MFA',
    'INVALID_REFRESH_TOKEN',
    'SESSION_REVOKED',
    'SESSION_EXPIRED',
    'ADMIN_SESSION_INACTIVE',
    'MFA_CHALLENGE_EXPIRED',
    'MFA_REPLAY_DETECTED',
    'REFRESH_REUSE_DETECTED',
  ],
  403: [
    'ADMIN_AUTHORIZATION_DENIED',
    'CAPABILITY_CEILING_EXCEEDED',
    'PROTECTED_ROLE_ASSIGNMENT_DENIED',
    'LAST_SUPER_ADMIN_PROTECTED',
    'PROTECTED_ROLE',
    'ADMIN_NOT_ACTIVE',
    'MFA_NOT_ENROLLED',
    'ROLE_MUTATION_DENIED',
    'ROLE_ASSIGNMENT_DENIED',
  ],
  404: ['ADMIN_NOT_FOUND', 'ROLE_NOT_FOUND', 'PERMISSION_NOT_FOUND'],
  409: [
    'MFA_ALREADY_ENABLED',
    'MFA_CHALLENGE_USED',
    'MFA_ENROLLMENT_CONFLICT',
    'MFA_ENROLLMENT_NOT_STARTED',
    'MFA_FINALIZATION_CONFLICT',
    'MFA_RESERVATION_CONFLICT',
    'REFRESH_FINALIZATION_CONFLICT',
    'REFRESH_IN_PROGRESS',
    'ROLE_VERSION_CONFLICT',
    'ROLE_NAME_CONFLICT',
    'ROLE_ASSIGNED',
    'ROLE_NOT_ASSIGNED',
    'SUPER_ADMIN_ALREADY_BOOTSTRAPPED',
  ],
  429: ['AUTH_RATE_LIMITED', 'MFA_CHALLENGE_LOCKED'],
  503: [
    'CLOUD_SDK_UNAVAILABLE',
    'DATABASE_CLOCK_UNAVAILABLE',
    'ADMIN_DISABLE_COORDINATOR_UNAVAILABLE',
    'ADMIN_DISABLE_STATE_MISMATCH',
    'ADMIN_SESSION_FINALIZATION_FAILED',
    'ADMIN_TOKEN_ISSUANCE_FAILED',
    'ROLE_PERSISTENCE_FAILED',
    'RECOVERY_CODE_GENERATION_FAILED',
    'INSUFFICIENT_RECOVERY_CODE_ENTROPY',
    'INSUFFICIENT_TOKEN_ENTROPY',
    'INSUFFICIENT_UUID_V7_ENTROPY',
    'INVALID_DUMMY_PASSWORD_HASH',
    'INVALID_RECOVERY_CODE_PEPPER',
    'SECRET_DECRYPTION_FAILED',
    'INVALID_KMS_SIGNATURE',
    'INVALID_KMS_CONFIGURATION',
    'INVALID_KMS_HMAC_CONFIGURATION',
    'INVALID_KMS_HMAC_KEYRING',
    'INVALID_KMS_IDENTITY',
    'INVALID_KMS_KEYRING',
    'INVALID_KMS_SIGNER_CONFIGURATION',
    'UNSUPPORTED_KMS_IDENTITY',
    'UNVERSIONED_KMS_HMAC_KEY_REFERENCE',
    'UNVERSIONED_KMS_KEY_REFERENCE',
    'UNVERSIONED_KMS_SIGNING_KEY_REFERENCE',
    'MEMORY_DISABLE_PARTICIPANT_ALREADY_REGISTERED',
  ],
} as const;

describe('IamHttpExceptionFilter', () => {
  it('keeps the table-driven tests synchronized with every public stable mapping', () => {
    const tested = Object.values(STATUS_CODES).flat().toSorted();
    expect(Object.keys(IAM_HTTP_STABLE_STATUS_CODES).toSorted()).toEqual(tested);
  });

  for (const [statusText, codes] of Object.entries(STATUS_CODES)) {
    const status = Number(statusText);
    it.each(codes)(`maps %s to ${statusText}`, (code) => {
      const response = captureResponse();
      new IamHttpExceptionFilter().catch(
        Object.assign(new Error(`secret:${code}`), { code }),
        response.host,
      );
      expect(response.status).toHaveBeenCalledWith(status);
      expect(response.send).toHaveBeenCalledWith({ code });
      expect(JSON.stringify(response.send.mock.calls)).not.toContain('secret:');
    });
  }

  it('maps unknown exceptions to a non-leaking 500 response', () => {
    const response = captureResponse();
    new IamHttpExceptionFilter().catch(new Error('database URL and secret'), response.host);
    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.send).toHaveBeenCalledWith({ code: 'INTERNAL_SERVER_ERROR' });
    expect(JSON.stringify(response.send.mock.calls)).not.toContain('database URL and secret');
  });

  it.each(['toString', 'constructor', '__proto__'])(
    'does not inherit an HTTP status for hostile code %s',
    (code) => {
      const response = captureResponse();
      new IamHttpExceptionFilter().catch(
        Object.assign(new Error('hostile code'), { code }),
        response.host,
      );
      expect(response.status).toHaveBeenCalledWith(500);
      expect(response.send).toHaveBeenCalledWith({ code: 'INTERNAL_SERVER_ERROR' });
    },
  );

  it('treats a symbol code and a throwing code accessor as unknown without leaking', () => {
    for (const error of [
      Object.assign(new Error('symbol secret'), { code: Symbol('hostile') }),
      Object.defineProperty(new Error('getter secret'), 'code', {
        get: () => {
          throw new Error('getter payload');
        },
      }),
    ]) {
      const response = captureResponse();
      expect(() => {
        new IamHttpExceptionFilter().catch(error, response.host);
      }).not.toThrow();
      expect(response.status).toHaveBeenCalledWith(500);
      expect(response.send).toHaveBeenCalledWith({ code: 'INTERNAL_SERVER_ERROR' });
    }
  });
});

function captureResponse() {
  const send = vi.fn();
  const status = vi.fn(() => ({ send }));
  const host = {
    switchToHttp: () => ({ getResponse: () => ({ status }) }),
  } as unknown as ArgumentsHost;
  return { host, status, send };
}
